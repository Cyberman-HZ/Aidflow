// Lets the AI assistant propose changes to a Family record. The flow is:
//
//   1. AI emits one or more ```aidflow-action JSON ``` code blocks in its
//      response. Each block describes a single proposed change.
//   2. The AIChat component parses them out, hides them from the rendered
//      markdown, and shows an Apply / Discard confirmation card.
//   3. On Apply, the action is executed against IndexedDB via Dexie and the
//      family's priority is recomputed (via computeRuleScore) so the UI
//      reflects the change immediately through useLiveQuery.
//
// Why a structured action block instead of free-form text? Gemma 4 is a
// generative model — when asked to "update the family" it will happily
// describe an update without actually causing one. By forcing it to emit a
// machine-parseable block AND requiring user confirmation, we turn a
// hallucination ("I added water…") into a real, auditable mutation.

import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import type { DisplacementStatus, Family, IncomeLevel } from '@/types';

// ---------------------------------------------------------------------------
// Action type definitions
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  'head_name',
  'location_sector',
  'member_count',
  'children_under_5',
  'elderly_count',
  'has_pregnant_member',
  'displacement_status',
  'income_level',
  'street',
  'city',
  'notes',
] as const;

type AllowedField = (typeof ALLOWED_FIELDS)[number];

export type FamilyAction =
  | { type: 'set_field'; field: AllowedField; value: string | number | boolean }
  | { type: 'add_recommended_item'; item: string }
  | { type: 'remove_recommended_item'; item: string }
  | { type: 'set_recommended_items'; items: string[] }
  | { type: 'add_medical_condition'; condition: string }
  | { type: 'remove_medical_condition'; condition: string }
  | { type: 'set_medical_conditions'; conditions: string[] };

// ---------------------------------------------------------------------------
// Prompt builder — appended to the system prompt of the family chat so
// Gemma 4 knows when and how to emit action blocks. Takes a list of values
// for fields that are constrained to a closed set (sectors, etc.) so the
// model can't invent values like "A" when the user means "Sector-A-South".
// ---------------------------------------------------------------------------

export interface FamilyActionPromptOpts {
  /** Sectors that already exist on at least one family. The AI may only use these for location_sector — anything else is rejected. */
  allowedSectors: string[];
}

export function buildFamilyActionPrompt(opts: FamilyActionPromptOpts): string {
  const sectorsList =
    opts.allowedSectors.length > 0
      ? opts.allowedSectors.map((s) => `"${s}"`).join(', ')
      : '(no sectors exist yet — refuse any sector change request and tell the user to add a sector via a family form first)';
  return `

## ACTIONS — modifying this family's record
You can propose changes to this family's record. To do so, emit ONE OR MORE fenced code blocks with the language tag \`aidflow-action\` ANYWHERE in your reply. Each block must contain a SINGLE valid JSON object describing one change. The user will see an "Apply / Discard" card next to your message and decide whether to commit the change. Do NOT claim a change has been applied — only the user can confirm it.

### When to emit an action block
- ONLY when the user explicitly asks for a change ("add X to the needs", "change the sector to Y", "remove the malnutrition condition", "update the address"). Never propose a change the user did not ask for.
- Always include EXACTLY one JSON object per block. Multiple changes = multiple blocks.
- Always emit \`aidflow-action\` blocks in addition to your natural-language reply, never instead of it. Briefly say what you are proposing.

### Supported action shapes
1. Update a profile field:
\`\`\`aidflow-action
{ "type": "set_field", "field": "<field>", "value": <value> }
\`\`\`
Allowed fields and value types:
- head_name (string), street (string), city (string), notes (string)
- location_sector — MUST be one of: ${sectorsList}
- member_count, children_under_5, elderly_count (positive integers)
- has_pregnant_member (boolean)
- displacement_status: one of "resident" | "recently_displaced" | "refugee"
- income_level: one of "none" | "minimal" | "moderate"

2. Manage current need items (the chips on the "Current need items" card):
\`\`\`aidflow-action
{ "type": "add_recommended_item", "item": "drinking water (20L)" }
\`\`\`
\`\`\`aidflow-action
{ "type": "remove_recommended_item", "item": "soft food kit" }
\`\`\`
\`\`\`aidflow-action
{ "type": "set_recommended_items", "items": ["item one", "item two"] }
\`\`\`

3. Manage medical conditions (always include severity in parentheses, lowercase):
\`\`\`aidflow-action
{ "type": "add_medical_condition", "condition": "diabetes (chronic)" }
\`\`\`
\`\`\`aidflow-action
{ "type": "remove_medical_condition", "condition": "asthma (chronic)" }
\`\`\`
\`\`\`aidflow-action
{ "type": "set_medical_conditions", "conditions": ["diabetes (chronic)", "anemia (mild)"] }
\`\`\`

### Rules
- Use exactly the JSON shapes above. No extra keys, no comments inside the JSON.
- **Closed-set fields** (location_sector, displacement_status, income_level, severity tags): the value MUST be one of the listed options EXACTLY (case-sensitive). If the user's request is ambiguous (e.g. "change the sector to A" when valid sectors are "Sector-A-South" / "Sector-A-North"), DO NOT guess — ask the user to clarify which option they mean. Do NOT emit an action block until the value is unambiguous.
- For "remove_*" actions, the value must match an existing entry exactly (case-insensitive). If unsure which entry the user means, ask them — do NOT guess and emit a delete.
- For severity tags use one of: critical, chronic, moderate, mild, monitoring.
- If the user asks for something outside these action shapes (e.g. "delete this whole family"), reply with what you can do but DO NOT emit an action block.
`;
}

/**
 * @deprecated Use buildFamilyActionPrompt() so allowed values can be enumerated.
 * Kept as a fallback that tells the AI sectors are unknown.
 */
export const FAMILY_ACTION_SYSTEM_PROMPT = buildFamilyActionPrompt({
  allowedSectors: [],
});

// ---------------------------------------------------------------------------
// Parsing & stripping
// ---------------------------------------------------------------------------

const ACTION_BLOCK_RE = /```aidflow-action\s*\n?([\s\S]*?)\n?```/g;

export function parseFamilyActions(text: string): FamilyAction[] {
  const out: FamilyAction[] = [];
  ACTION_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_BLOCK_RE.exec(text))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      const action = validateFamilyAction(json);
      if (action) out.push(action);
    } catch {
      // Ignore malformed blocks — the user just won't see an Apply card.
    }
  }
  return out;
}

/**
 * Returns the message text with action blocks removed so they don't appear
 * in the rendered chat bubble.
 */
export function stripFamilyActions(text: string): string {
  return text.replace(ACTION_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function validateFamilyAction(j: any): FamilyAction | null {
  if (!j || typeof j !== 'object' || typeof j.type !== 'string') return null;
  switch (j.type) {
    case 'set_field': {
      const field = j.field;
      if (typeof field !== 'string' || !ALLOWED_FIELDS.includes(field as AllowedField)) {
        return null;
      }
      // Validate value shape per field
      const value = j.value;
      if (
        ['head_name', 'location_sector', 'street', 'city', 'notes'].includes(field)
      ) {
        if (typeof value !== 'string') return null;
      } else if (
        ['member_count', 'children_under_5', 'elderly_count'].includes(field)
      ) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      } else if (field === 'has_pregnant_member') {
        if (typeof value !== 'boolean') return null;
      } else if (field === 'displacement_status') {
        if (!['resident', 'recently_displaced', 'refugee'].includes(value)) return null;
      } else if (field === 'income_level') {
        if (!['none', 'minimal', 'moderate'].includes(value)) return null;
      }
      return { type: 'set_field', field: field as AllowedField, value };
    }
    case 'add_recommended_item':
    case 'remove_recommended_item':
      if (typeof j.item !== 'string' || !j.item.trim()) return null;
      return { type: j.type, item: j.item.trim() };
    case 'set_recommended_items':
      if (!Array.isArray(j.items)) return null;
      return {
        type: 'set_recommended_items',
        items: j.items.map((s: unknown) => String(s ?? '').trim()).filter(Boolean),
      };
    case 'add_medical_condition':
    case 'remove_medical_condition':
      if (typeof j.condition !== 'string' || !j.condition.trim()) return null;
      return { type: j.type, condition: j.condition.trim() };
    case 'set_medical_conditions':
      if (!Array.isArray(j.conditions)) return null;
      return {
        type: 'set_medical_conditions',
        conditions: j.conditions
          .map((s: unknown) => String(s ?? '').trim())
          .filter(Boolean),
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Human-friendly descriptions for the Apply confirmation card
// ---------------------------------------------------------------------------

export function describeFamilyAction(action: FamilyAction): string {
  switch (action.type) {
    case 'set_field':
      return `Set ${prettyField(action.field)} to "${formatValue(action.value)}"`;
    case 'add_recommended_item':
      return `Add "${action.item}" to current need items`;
    case 'remove_recommended_item':
      return `Remove "${action.item}" from current need items`;
    case 'set_recommended_items':
      return `Replace current need items with: ${action.items.join(', ') || '(empty)'}`;
    case 'add_medical_condition':
      return `Add medical condition: "${action.condition}"`;
    case 'remove_medical_condition':
      return `Remove medical condition: "${action.condition}"`;
    case 'set_medical_conditions':
      return `Replace medical conditions with: ${action.conditions.join(', ') || '(empty)'}`;
  }
}

function prettyField(field: AllowedField): string {
  return field.replace(/_/g, ' ');
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Applies the action to the latest version of the family from the database.
 * Recomputes the rule-based priority score afterwards and bumps last_updated.
 * Returns the updated family.
 */
export async function applyFamilyAction(
  familyId: string,
  action: FamilyAction
): Promise<Family> {
  const fresh = await db.families.get(familyId);
  if (!fresh) throw new Error(`Family ${familyId} not found`);

  // Closed-set safety check: location_sector may only be set to a value that
  // already exists on at least one family. This blocks the AI (or a malformed
  // action block) from inventing a brand-new sector like "A" when the user
  // probably meant "Sector-A-South".
  if (action.type === 'set_field' && action.field === 'location_sector') {
    const all = await db.families.toArray();
    const allowed = new Set(
      all.map((f) => f.location_sector).filter((s): s is string => !!s)
    );
    if (!allowed.has(String(action.value))) {
      const list = Array.from(allowed).sort().join(', ') || '(none)';
      throw new Error(
        `"${action.value}" is not an existing sector. Pick one of: ${list}`
      );
    }
  }

  const next: Family = { ...fresh };
  switch (action.type) {
    case 'set_field': {
      // Type-safe writes per field
      const { field, value } = action;
      switch (field) {
        case 'head_name':
        case 'location_sector':
        case 'street':
        case 'city':
        case 'notes':
          (next as any)[field] = value as string;
          break;
        case 'member_count':
        case 'children_under_5':
        case 'elderly_count':
          (next as any)[field] = Math.max(0, Math.floor(value as number));
          if (field === 'member_count') {
            next.member_count = Math.max(1, next.member_count);
          }
          break;
        case 'has_pregnant_member':
          next.has_pregnant_member = value as boolean;
          break;
        case 'displacement_status':
          next.displacement_status = value as DisplacementStatus;
          break;
        case 'income_level':
          next.income_level = value as IncomeLevel;
          break;
      }
      break;
    }
    case 'add_recommended_item': {
      const cur = next.recommended_items ?? [];
      if (!cur.some((x) => x.toLowerCase() === action.item.toLowerCase())) {
        next.recommended_items = [...cur, action.item];
      }
      break;
    }
    case 'remove_recommended_item': {
      const cur = next.recommended_items ?? [];
      next.recommended_items = cur.filter(
        (x) => x.toLowerCase() !== action.item.toLowerCase()
      );
      break;
    }
    case 'set_recommended_items':
      next.recommended_items = [...action.items];
      break;
    case 'add_medical_condition':
      if (
        !next.medical_conditions.some(
          (x) => x.toLowerCase() === action.condition.toLowerCase()
        )
      ) {
        next.medical_conditions = [...next.medical_conditions, action.condition];
      }
      break;
    case 'remove_medical_condition':
      next.medical_conditions = next.medical_conditions.filter(
        (x) => x.toLowerCase() !== action.condition.toLowerCase()
      );
      break;
    case 'set_medical_conditions':
      next.medical_conditions = [...action.conditions];
      break;
  }

  next.last_updated = new Date().toISOString();
  // Pass this family's distributions so the recomputed score reflects
  // delivery history (recent successful = down, failed/cancelled = up).
  const dists = await db.distributions.where('family_id').equals(familyId).toArray();
  const r = computeRuleScore(next, dists);
  next.priority_score = r.priority_score;
  next.priority_level = r.priority_level;
  next.ai_reason = r.reason;

  await db.families.put(next);
  return next;
}
