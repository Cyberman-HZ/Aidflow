// Lets the AI assistant propose changes to a Family record. The flow is:
//
//   1. AI emits one or more ```aidflow-action JSON ``` code blocks in its
//      response. Each block describes a single proposed change.
//   2. The AIChat component parses them out, hides them from the rendered
//      markdown, and shows an Apply / Discard confirmation card.
//   3. On Apply, the action is executed against IndexedDB via Dexie and the
//      family's priority is recomputed (via computeRuleScore) so the UI
//      reflects the change immediately through useLiveQuery.

import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import type {
  DisplacementStatus,
  Family,
  IncomeLevel,
  NeededItem,
} from '@/types';

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
  | { type: 'add_recommended_item'; item: string; quantity: number }
  /**
   * Remove an item from the family's needs.
   * - If `quantity` is omitted (or 0), the entry is deleted entirely.
   * - If `quantity` is a positive number, that many units are subtracted;
   *   the entry is removed only if the result reaches 0.
   */
  | { type: 'remove_recommended_item'; item: string; quantity?: number }
  | { type: 'set_recommended_items'; items: NeededItem[] }
  | { type: 'add_medical_condition'; condition: string }
  | { type: 'remove_medical_condition'; condition: string }
  | { type: 'set_medical_conditions'; conditions: string[] };

// ---------------------------------------------------------------------------
// Prompt builder
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

### 🟢 ITEMS vs PROFILE FIELDS — read this first, it is the #1 source of mistakes
The family has TWO completely separate things you can edit:
- **PROFILE FIELDS** (fixed names): head_name, member_count, children_under_5, elderly_count, has_pregnant_member, displacement_status, income_level, location_sector, street, city, notes. Use action type "set_field" with the EXACT field name. Profile fields NEVER include items like "infant formula".
- **NEED ITEMS** (free-form names like "infant formula", "drinking water (20L)", "laptop", "soft food kit", etc.) — listed under CURRENT NEEDS in the family snapshot. Use add_recommended_item / remove_recommended_item / set_recommended_items.

⚠️ When the user mentions a thing that appears in CURRENT NEEDS (case-insensitive substring match), it is an ITEM — NEVER a profile field. Examples:
- "remove 1 infant formula" → ITEM action ("infant formula" is in CURRENT NEEDS) — emit remove_recommended_item with quantity:1.
- "remove 1 infant" when CURRENT NEEDS contains "infant formula" → AMBIGUOUS — ASK: "Did you mean 'infant formula' (an item in the needs list) or change the children-under-5 count?"
- "set children_under_5 to 2" → PROFILE field action (clearly references the field name).
- "set elderly to 3" → PROFILE field action ("elderly" maps unambiguously to elderly_count).

⚠️ Item name matching is CASE-INSENSITIVE. The list shown in CURRENT NEEDS is the canonical spelling. If the user types "INFANT FORMULA" or "Infant Formula" or "infant formula", match it against the list.

⚠️ NEVER tell the user an item "is not in the family's needs" without first scanning the CURRENT NEEDS list above and matching case-insensitively. If a substring of the user's request matches any item, that's the item they mean.

### When to emit an action block — IMPORTANT BEHAVIOR
- The MOMENT the user makes an unambiguous change request ("remove 2fg", "add 4 bottles of water", "change sector to Sector-A-South"), emit the action block IMMEDIATELY in your reply. The user will see an Apply / Discard card — that IS the confirmation step. Do NOT ask "should I do that?" verbally first.
- A correct reply looks like ONE short sentence ("Removing 2fg from the needs.") followed by ONE \`aidflow-action\` fenced block.
- Multiple changes = multiple blocks in the SAME reply (e.g. "add X and Y" → two add blocks).
- Only ASK for clarification when the request is genuinely ambiguous (e.g. "add X" without a quantity, or "set sector to A" with two valid candidates). Never ask "are you sure?" — emit the block, the Apply card handles confirmation.
- The fenced code block MUST start exactly with three backticks followed by aidflow-action and the JSON object MUST be a JSON number for any quantity (write 4, NOT "4" and NOT "4x").

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

2. Manage current need items (the chips on the "Current need items" card).
   Every item has BOTH a name AND a quantity (positive integer).
   PICK THE RIGHT ACTION — these are NOT interchangeable:
   - "add X to the needs" / "I also need X" → use add_recommended_item (one block per item).
   - "remove X" / "we no longer need X" → use remove_recommended_item.
   - "replace the list with …" / "set the needs to exactly …" / "the needs are now only …" → use set_recommended_items. This OVERWRITES the entire list — use it ONLY when the user explicitly asks for a complete replacement.

🔢 QUANTITY RULES — READ CAREFULLY (this is where the AI most often makes mistakes):

ADD:
- add_recommended_item REQUIRES a numeric "quantity" field (>= 1).
- If the user did NOT specify a quantity ("add water" with no number), DO NOT emit the action block. Reply asking how many they need ("How many units of drinking water should I add?") and wait for the answer.

REMOVE — pick the right one based on what the user said:
A) Full delete (no "quantity" field on the action) — use this when the user wants the ITEM GONE entirely:
   - "remove water" / "we no longer need water" / "delete water from the needs" / "remove all water"
B) Decrement (include "quantity": N on the action) — use this when the user wants to SUBTRACT some units:
   - "remove 1 water" / "remove 1x laptop" / "take away 2 water" / "reduce water by 3"
C) AMBIGUOUS — when the user says just "remove X" but the family has X with quantity > 1, you don't know if they mean (A) delete entirely or (B) decrement by 1. STOP and ASK for clarification, do NOT emit a block. Example reply: "They currently have laptop ×4. Did you want to remove ALL 4 laptops, or just decrease the count by some amount?"
- The current quantity for each item is shown in the FAMILY SNAPSHOT ("next_needs:[name × N, …]"). Use that to decide whether (C) applies.

For set_recommended_items, every entry needs both a name and a quantity. Same rule: if quantities are unclear, ask before emitting.

EXAMPLES:

Add 4 bottles of water:
\`\`\`aidflow-action
{ "type": "add_recommended_item", "item": "drinking water (20L)", "quantity": 4 }
\`\`\`

Delete the soft food kit entry entirely (note: NO "quantity" field):
\`\`\`aidflow-action
{ "type": "remove_recommended_item", "item": "soft food kit" }
\`\`\`

Subtract 1 from the laptop count (laptop ×4 → laptop ×3):
\`\`\`aidflow-action
{ "type": "remove_recommended_item", "item": "laptop", "quantity": 1 }
\`\`\`

Replace the entire list:
\`\`\`aidflow-action
{ "type": "set_recommended_items", "items": [{ "name": "item one", "quantity": 2 }, { "name": "item two", "quantity": 1 }] }
\`\`\`

⚠️ Common mistakes to avoid:
- Do NOT emit \`set_recommended_items\` when the user says "add X" — that wipes the rest of the list. Use \`add_recommended_item\`.
- Do NOT delete the entire entry when the user said "remove 1 X" or "remove 1x X". That "1" is a decrement instruction; emit \`remove_recommended_item\` WITH a \`quantity\` field.
- When in doubt about whether to delete or decrement, ASK first — do NOT emit a block.

3. Manage medical conditions (always include severity in parentheses, lowercase).
   Same rules as above:
   - "add X" / "she also has X" → use add_medical_condition.
   - "remove X" / "she no longer has X" → use remove_medical_condition.
   - "replace the list with …" / "the conditions are now only …" → use set_medical_conditions (overwrite — only on explicit replacement requests).

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

// ---------------------------------------------------------------------------
// Parsing & stripping
// ---------------------------------------------------------------------------

// Matches ANY fenced code block — language tag is captured but optional.
// We accept ```aidflow-action (preferred), ```json, or no tag at all because
// Gemma 4 sometimes drifts from the exact tag we ask for.
const ACTION_BLOCK_RE = /```([a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```/g;

// Loose detector for inline JSON action objects emitted without a fence.
// Looks for the tell-tale {"type":"set_field|add_recommended_item|..."} shape.
const INLINE_ACTION_RE = /\{[^{}]*"type"\s*:\s*"(?:set_field|add_recommended_item|remove_recommended_item|set_recommended_items|add_medical_condition|remove_medical_condition|set_medical_conditions)"[^{}]*\}/g;

function tryParseAction(raw: string): FamilyAction | null {
  const cleaned = raw
    // Strip JS-style trailing commas which Gemma 4 occasionally emits
    .replace(/,(\s*[\]}])/g, "")
    .trim();
  if (!cleaned) return null;
  try {
    const json = JSON.parse(cleaned);
    return validateFamilyAction(json);
  } catch (e) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("[familyActions] could not parse action JSON:", cleaned, e);
    }
    return null;
  }
}

export interface ParseResult {
  actions: FamilyAction[];
  /**
   * Number of fenced or inline candidates that failed validation.
   * The UI can surface this so the user knows the AI tried to propose a
   * change but it was malformed (vs. silently dropping it).
   */
  failedCandidates: number;
}

export function parseFamilyActionsDetailed(text: string): ParseResult {
  const out: FamilyAction[] = [];
  let failed = 0;

  // 1) Fenced code blocks (preferred path)
  ACTION_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_BLOCK_RE.exec(text))) {
    const tag = (match[1] || "").toLowerCase();
    if (tag && tag !== "aidflow-action" && tag !== "json" && tag !== "") continue;
    const raw = match[2].trim();
    // Only count as a candidate if it looks like an attempt at our schema.
    const looksLikeAction = /"type"\s*:\s*"[a-z_]+"/.test(raw);
    const action = tryParseAction(match[2]);
    if (action) out.push(action);
    else if (looksLikeAction) failed++;
  }
  if (out.length > 0) return { actions: out, failedCandidates: failed };

  // 2) Fallback: inline {"type":...} JSON the AI dropped without a fence.
  INLINE_ACTION_RE.lastIndex = 0;
  while ((match = INLINE_ACTION_RE.exec(text))) {
    const action = tryParseAction(match[0]);
    if (action) out.push(action);
    else failed++;
  }
  return { actions: out, failedCandidates: failed };
}

/**
 * Returns the message text with action blocks removed so they don't appear
 * in the rendered chat bubble.
 *
 * Bug fix: previously this stripped EVERY fenced code block, including
 * unrelated snippets the model emitted alongside its action proposal
 * (e.g. a ```js example or a ```sh shell command). Now it only strips a
 * block if EITHER:
 *   (a) the block's language tag is "aidflow-action" / "json" / blank
 *       AND the body parses as a valid FamilyAction via tryParseAction,
 *   OR
 *   (b) the body matches the inline action shape on its own.
 * Anything else (a "js" snippet, a "shell" example, a markdown table)
 * stays put so the user still sees the model's surrounding explanation.
 */
export function stripFamilyActions(text: string): string {
  // Reset the global regex so successive calls don't drift.
  ACTION_BLOCK_RE.lastIndex = 0;
  return text
    .replace(ACTION_BLOCK_RE, (whole, tag: string | undefined, body: string) => {
      const t = (tag ?? '').trim().toLowerCase();
      const looksLikeActionTag =
        t === 'aidflow-action' || t === 'json' || t === '';
      if (!looksLikeActionTag) return whole; // keep ```js etc.
      const parsed = tryParseAction(body ?? '');
      // Only strip if we actually parsed an action — avoids eating a
      // ```json block of unrelated example data.
      return parsed ? '' : whole;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validateFamilyAction(j: any): FamilyAction | null {
  if (!j || typeof j !== 'object' || typeof j.type !== 'string') return null;
  switch (j.type) {
    case 'set_field': {
      const field = j.field;
      if (typeof field !== 'string' || !ALLOWED_FIELDS.includes(field as AllowedField)) {
        return null;
      }
      const value = j.value;
      if (
        ['head_name', 'location_sector', 'street', 'city', 'notes'].includes(field)
      ) {
        if (typeof value !== 'string') return null;
      } else if (
        ['member_count', 'children_under_5', 'elderly_count'].includes(field)
      ) {
        const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(n) || n < 0) return null;
        return { type: 'set_field', field: field as AllowedField, value: Math.floor(n) };
      } else if (field === 'has_pregnant_member') {
        if (typeof value === 'boolean') {
          return { type: 'set_field', field, value };
        }
        // Accept 'yes' / 'no' / 'true' / 'false' / 0 / 1 from the AI
        const s = String(value).toLowerCase();
        if (['true', 'yes', '1'].includes(s)) return { type: 'set_field', field, value: true };
        if (['false', 'no', '0'].includes(s)) return { type: 'set_field', field, value: false };
        return null;
      } else if (field === 'displacement_status') {
        if (!['resident', 'recently_displaced', 'refugee'].includes(value)) return null;
      } else if (field === 'income_level') {
        if (!['none', 'minimal', 'moderate'].includes(value)) return null;
      }
      return { type: 'set_field', field: field as AllowedField, value };
    }
    case 'add_recommended_item': {
      if (typeof j.item !== 'string' || !j.item.trim()) return null;
      // Coerce quantity from number or string like '4', '4x', '×4', '"4"'.
      const qRaw = j.quantity;
      const qNum =
        typeof qRaw === 'number' ? qRaw : Number(String(qRaw ?? '').replace(/[^0-9.-]/g, ''));
      const q = Number.isFinite(qNum) && qNum >= 1 ? Math.floor(qNum) : 1;
      return { type: 'add_recommended_item', item: j.item.trim(), quantity: q };
    }
    case 'remove_recommended_item': {
      if (typeof j.item !== 'string' || !j.item.trim()) return null;
      // Optional quantity: 'remove 1 laptop' subtracts 1 instead of deleting
      // the whole entry. Omitted → full delete.
      let q: number | undefined;
      if (j.quantity !== undefined && j.quantity !== null) {
        const qNum =
          typeof j.quantity === 'number'
            ? j.quantity
            : Number(String(j.quantity).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(qNum) && qNum >= 1) q = Math.floor(qNum);
      }
      return q !== undefined
        ? { type: 'remove_recommended_item', item: j.item.trim(), quantity: q }
        : { type: 'remove_recommended_item', item: j.item.trim() };
    }
    case 'set_recommended_items': {
      if (!Array.isArray(j.items)) return null;
      const items: NeededItem[] = [];
      for (const raw of j.items) {
        if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
          const name = String((raw as any).name).trim();
          const q = Number((raw as any).quantity);
          if (!name || !Number.isFinite(q) || q < 1) continue;
          items.push({ name, quantity: Math.floor(q) });
        } else if (typeof raw === 'string' && raw.trim()) {
          items.push({ name: raw.trim(), quantity: 1 });
        }
      }
      return { type: 'set_recommended_items', items };
    }
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
      return `Add "${action.item}" ×${action.quantity} to current need items`;
    case 'remove_recommended_item':
      return action.quantity
        ? `Remove ${action.quantity} of "${action.item}" from current need items`
        : `Remove "${action.item}" entirely from current need items`;
    case 'set_recommended_items':
      return `⚠️ REPLACE all current need items with only: ${
        action.items.length === 0
          ? '(empty list)'
          : action.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')
      }. This removes any items not in this list.`;
    case 'add_medical_condition':
      return `Add medical condition: "${action.condition}"`;
    case 'remove_medical_condition':
      return `Remove medical condition: "${action.condition}"`;
    case 'set_medical_conditions':
      return `⚠️ REPLACE all medical conditions with only: ${
        action.conditions.length === 0 ? '(empty list)' : action.conditions.join(', ')
      }. This removes any conditions not in this list.`;
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

export async function applyFamilyAction(
  familyId: string,
  action: FamilyAction
): Promise<Family> {
  const fresh = await db.families.get(familyId);
  if (!fresh) throw new Error(`Family ${familyId} not found`);

  // Seed recommended_items from the rule engine if the DB field is
  // undefined. The user sees the rule-engine recommendations as chips on
  // screen, so without this seed the AI can correctly identify an item
  // (because we pass `familyForAI` to AIChat) but then fail to remove it
  // because the DB has no items yet. Seeding makes the displayed state
  // match the persisted state on the first action.
  if (fresh.recommended_items === undefined) {
    const distributions = await db.distributions
      .where('family_id')
      .equals(familyId)
      .toArray();
    const seeded = computeRuleScore(fresh, distributions);
    fresh.recommended_items = seeded.recommended_items;
  }

  // Closed-set safety check: location_sector may only be set to a value that
  // already exists on at least one family.
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
      const list: NeededItem[] = Array.isArray(next.recommended_items)
        ? [...next.recommended_items]
        : [];
      const idx = list.findIndex(
        (i) => i.name.toLowerCase() === action.item.toLowerCase()
      );
      if (idx >= 0) {
        // Preserve existing canonical name spelling — don't overwrite
        // "Infant Formula" with "infant formula" just because the AI
        // happened to lowercase it.
        list[idx] = { ...list[idx], quantity: list[idx].quantity + action.quantity };
      } else {
        list.push({ name: action.item, quantity: action.quantity });
      }
      next.recommended_items = list;
      break;
    }
    case 'remove_recommended_item': {
      const list: NeededItem[] = Array.isArray(next.recommended_items)
        ? [...next.recommended_items]
        : [];
      // Try exact (case-insensitive) match first, then fall back to
      // substring match — this catches "infant" → "infant formula".
      const requested = action.item.toLowerCase().trim();
      let idx = list.findIndex((i) => i.name.toLowerCase() === requested);
      if (idx === -1) {
        idx = list.findIndex(
          (i) =>
            i.name.toLowerCase().includes(requested) ||
            requested.includes(i.name.toLowerCase())
        );
      }
      if (idx === -1) {
        const have = list.map((i) => `"${i.name}" ×${i.quantity}`).join(', ');
        throw new Error(
          `Cannot remove "${action.item}" — it is not in the family's needs. Current needs: ${have || '(empty)'}`
        );
      }
      if (action.quantity && action.quantity > 0) {
        const remaining = list[idx].quantity - action.quantity;
        if (remaining > 0) {
          list[idx] = { ...list[idx], quantity: remaining };
        } else {
          list.splice(idx, 1);
        }
      } else {
        // No quantity = delete the whole entry
        list.splice(idx, 1);
      }
      next.recommended_items = list;
      break;
    }
    case 'set_recommended_items':
      next.recommended_items = action.items;
      break;
    case 'add_medical_condition': {
      const list = Array.isArray(next.medical_conditions)
        ? [...next.medical_conditions]
        : [];
      if (!list.some((c) => c.toLowerCase() === action.condition.toLowerCase())) {
        list.push(action.condition);
      }
      next.medical_conditions = list;
      break;
    }
    case 'remove_medical_condition': {
      const list = Array.isArray(next.medical_conditions)
        ? next.medical_conditions
        : [];
      next.medical_conditions = list.filter(
        (c) => c.toLowerCase() !== action.condition.toLowerCase()
      );
      break;
    }
    case 'set_medical_conditions':
      next.medical_conditions = action.conditions;
      break;
  }

  // Recompute priority using the shared rule engine, factoring in this
  // family's distribution history so recent deliveries lower the score.
  const distributions = await db.distributions
    .where('family_id')
    .equals(familyId)
    .toArray();
  const result = computeRuleScore(next, distributions);
  next.priority_score = result.priority_score;
  next.priority_level = result.priority_level;
  next.ai_reason = result.reason;
  next.last_updated = new Date().toISOString();

  await db.families.put(next);
  return next;
}
