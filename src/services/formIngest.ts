// Paper-form ingestion — uses Gemma 4's multimodal capability to extract
// family registration rows from a photo of a handwritten or printed form.
//
// The flow:
//
//   1. Admin uploads a photo of a registration form / tally sheet (paper).
//   2. We resize it (imageUtils) and ship it to Ollama via chatWithImage()
//      with a strict JSON schema prompt.
//   3. Gemma 4 returns one candidate per row — head_name, member_count,
//      sector, displacement, income, notes, etc. — plus a confidence
//      tag and the raw text it read.
//   4. We validate/sanitize each candidate (closed-set fields, integer
//      ranges, etc.) and hand the array to the UI.
//   5. Admin reviews each candidate as an Apply/Discard card. Each
//      "Apply" calls commitFamilyCandidate() which mints a fresh
//      family_id, computes a priority score, and writes to db.families.
//
// Why a separate service (vs. just inlining in the modal):
//
//   - The prompt is load-bearing for accuracy. It belongs next to the
//     schema validation it produces, not buried in a component file.
//   - Lets QA scripts under scripts/qa/ exercise the same path headlessly
//     later if we ever add an Ollama golden-path test.

import { db } from '@/db/database';
import { chatWithImage, pingOllama } from './ollama';
import { computeRuleScore } from './priorityRules';
import { findDuplicateFamily } from './familyDuplicates';
import type {
  ChatMessage,
  DisplacementStatus,
  Family,
  IncomeLevel,
} from '@/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConfidenceTag = 'high' | 'medium' | 'low';

/** A single row Gemma 4 thinks it saw on the photographed form. */
export interface FamilyCandidate {
  /** Stable per-photo id (for React keys + Apply/Discard tracking). */
  candidate_id: string;
  /** Verbatim text the model read for this row — shown in the UI for review. */
  raw_text: string;
  /** Model's self-rated confidence. Low-confidence rows get a visual flag. */
  confidence: ConfidenceTag;
  /** Free-text notes Gemma surfaces (e.g. "row 4 was partly cut off"). */
  warnings: string[];

  // -- Editable family fields (subset of Family) -----------------------------
  head_name: string;
  member_count: number;
  children_under_5: number;
  elderly_count: number;
  has_pregnant_member: boolean;
  displacement_status: DisplacementStatus;
  income_level: IncomeLevel;
  location_sector: string;
  medical_conditions: string[];
  notes: string;
}

export interface IngestResult {
  /** Rows the admin will review. May be empty (the model saw no families). */
  candidates: FamilyCandidate[];
  /** Top-level warnings about the image (e.g. "image is partly blurry"). */
  warnings: string[];
  /**
   * Whatever the model literally returned. Stored so we can show "raw model
   * response" in the dev console if something looks off — saves a Wireshark
   * trip when the user reports a bad extraction.
   */
  rawResponse: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are AidFlow Pro's paper-form ingestion vision model. The user will upload a photograph of a handwritten or printed humanitarian aid family registration form, tally sheet, or hand-written list. Each row on the form represents one family. Your job: extract one structured family record per row, in strict JSON.

CRITICAL RULES
1. Output ONLY valid JSON. No markdown, no commentary, no \`\`\`json fences.
2. Top-level shape:
   {
     "image_warnings": [string],  // image-wide notes (blur, glare, cut off, no form detected, etc.)
     "families": [
       {
         "head_name": string,                          // required, non-empty
         "member_count": int,                          // 1..30; default 1 if unreadable
         "children_under_5": int,                      // 0..15
         "elderly_count": int,                         // 0..10
         "has_pregnant_member": boolean,
         "displacement_status": "resident"|"recently_displaced"|"refugee",
         "income_level": "none"|"minimal"|"moderate",
         "location_sector": string,                    // free-text; "" if not on form
         "medical_conditions": [string],               // each entry like "diabetes (chronic)"
         "notes": string,                              // free-text observations from the form
         "raw_text": string,                           // verbatim transcription of THIS row
         "confidence": "high"|"medium"|"low",          // your honest read on this row
         "row_warnings": [string]                      // per-row issues (smudged, cut off, etc.)
       }
     ]
   }

3. NEVER invent values. If a field is not visible/legible on the form:
   - Enums (displacement_status, income_level): pick the most conservative default —
     "resident" for displacement_status, "none" for income_level — and add a row_warning
     like "displacement not on form, defaulted to resident".
   - Counts: use 0 (for children_under_5/elderly) or 1 (for member_count) and add a warning.
   - location_sector / notes / medical_conditions: empty string / empty array if not present.

4. Strings: trim whitespace. Names: preserve original spelling and diacritics.

5. Medical conditions must include a severity tag in parentheses (lowercase):
   "critical" | "chronic" | "moderate" | "mild" | "monitoring".
   Example: "diabetes (chronic)", "pregnancy complications (critical)".

6. If you cannot see ANY family rows (image is unreadable / not a form / blank page):
   return { "image_warnings": ["..."], "families": [] }.

7. confidence: "high" means you are sure of every field on this row;
   "medium" means at least one field was guessed/defaulted;
   "low" means significant fields were unreadable. Be honest — the admin
   uses this to decide which rows to spot-check.`;

const USER_PROMPT =
  'Extract every family row visible on the attached photo of a paper registration form into the JSON schema described in the system prompt. One JSON object per row in the families[] array. Return JSON only — no prose, no markdown.';

// ---------------------------------------------------------------------------
// Validators / coercers
// ---------------------------------------------------------------------------

const DISPLACEMENT_VALUES = ['resident', 'recently_displaced', 'refugee'] as const;
const INCOME_VALUES = ['none', 'minimal', 'moderate'] as const;
const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;

// Built via `new RegExp(...)` with explicit \u escapes so the source file
// contains zero literal control bytes (some editor / tool pipelines drop
// them silently, which would silently corrupt these patterns).
//
//   ALL_CTRL_RE         — every char in C0 + DEL. Used for single-line fields.
//   CTRL_KEEP_NL_TAB_RE — same range but keeps U+0009, U+000A, U+000D so
//                         free-text notes can preserve line breaks and tabs.
const ALL_CTRL_RE = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const CTRL_KEEP_NL_TAB_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+',
  'g'
);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string'
      ? Number(v.replace(/[^0-9.\-]/g, ''))
      : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asString(v: unknown, maxLen = 500): string {
  if (typeof v !== 'string') return '';
  // Strip ALL ASCII control chars (incl. newlines/tabs) and collapse runs
  // of whitespace. Used for single-line fields (name, sector, …).
  return v
    .replace(ALL_CTRL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function asMultilineString(v: unknown, maxLen = 2000): string {
  if (typeof v !== 'string') return '';
  // Allow newlines / tabs in free-text notes; strip everything else in
  // the C0 control range + DEL.
  return v.replace(CTRL_KEEP_NL_TAB_RE, '').trim().slice(0, maxLen);
}

function asEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function asStringArray(v: unknown, maxItems = 10, maxLen = 200): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function makeCandidateId(): string {
  return `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Take whatever the model returned and turn it into a strictly-shaped
 * FamilyCandidate. Anything we can't validate is replaced with a safe
 * default and surfaced as a row warning so the admin can spot-check.
 */
function coerceCandidate(raw: unknown): FamilyCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const head_name = asString(r.head_name, 200);
  if (!head_name) return null; // no name → unusable row, drop it

  const row_warnings = asStringArray(r.row_warnings, 5);

  return {
    candidate_id: makeCandidateId(),
    head_name,
    raw_text: asMultilineString(r.raw_text, 500),
    confidence: asEnum<ConfidenceTag>(r.confidence, CONFIDENCE_VALUES, 'medium'),
    warnings: row_warnings,
    member_count: clampInt(r.member_count, 1, 30, 1),
    children_under_5: clampInt(r.children_under_5, 0, 15, 0),
    elderly_count: clampInt(r.elderly_count, 0, 10, 0),
    has_pregnant_member: r.has_pregnant_member === true,
    displacement_status: asEnum<DisplacementStatus>(
      r.displacement_status,
      DISPLACEMENT_VALUES,
      'resident'
    ),
    income_level: asEnum<IncomeLevel>(r.income_level, INCOME_VALUES, 'none'),
    location_sector: asString(r.location_sector, 80),
    medical_conditions: asStringArray(r.medical_conditions, 8, 100),
    notes: asMultilineString(r.notes, 800),
  };
}

/** Best-effort JSON unwrap — strips ```json fences if the model used them. */
function extractJsonObject(text: string): string {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return cleaned;
  return cleaned.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Send a photo to Gemma 4 vision and parse the result into candidate
 * family rows. Throws if Ollama is unreachable; returns
 * `{candidates:[], warnings:["image_unreadable"]}` if the model couldn't
 * see any rows.
 */
export async function extractFamiliesFromPhoto(
  imageBase64: string
): Promise<IngestResult> {
  if (!(await pingOllama())) {
    throw new Error(
      'Ollama is not reachable. Start it with `OLLAMA_ORIGINS=* ollama serve` and pull a vision-capable Gemma 4 model.'
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT },
  ];

  const raw = await chatWithImage(messages, [imageBase64], {
    temperature: 0.1,
    maxTokens: 4096,
    jsonMode: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    // The model didn't follow JSON contract. Surface as a top-level warning
    // rather than crashing — the admin can retry with a clearer photo or
    // fall back to manual entry.
    return {
      candidates: [],
      warnings: [
        'The model did not return valid JSON. The image may be unreadable, or your Ollama model may not support vision. Try a different Gemma 4 vision variant or a clearer photo.',
      ],
      rawResponse: raw,
    };
  }

  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const imageWarnings = asStringArray(obj.image_warnings, 5);
  const familiesRaw = Array.isArray(obj.families) ? obj.families : [];
  const candidates = familiesRaw
    .map(coerceCandidate)
    .filter((c): c is FamilyCandidate => c !== null);

  return {
    candidates,
    warnings: imageWarnings,
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// Commit (one candidate → one Family row)
// ---------------------------------------------------------------------------

/** Mint a unique family_id that won't collide on a same-millisecond batch. */
function newFamilyId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `F-${ts}-${rand}`;
}

/**
 * Persist a single approved candidate to db.families. Computes an initial
 * priority score via the rule engine so the new family lands on the list
 * at the right level immediately, without needing a separate AI re-run.
 *
 * Returns the persisted Family row.
 */
/**
 * Thrown by commitFamilyCandidate when the candidate would create a
 * duplicate of an existing family (same head name + same member count).
 * The PaperFormImport modal catches this and surfaces it as a per-row
 * failure with the existing family_id so the admin knows where to go.
 *
 * Exposed as an Error subclass (rather than a plain Error) so callers
 * can `instanceof`-check it if they want to handle duplicates
 * differently from other persistence failures.
 */
export class DuplicateFamilyError extends Error {
  readonly existing_family_id: string;
  readonly existing_head_name: string;
  readonly existing_member_count: number;
  constructor(
    message: string,
    match: {
      family_id: string;
      head_name: string;
      member_count: number;
    }
  ) {
    super(message);
    this.name = 'DuplicateFamilyError';
    this.existing_family_id = match.family_id;
    this.existing_head_name = match.head_name;
    this.existing_member_count = match.member_count;
  }
}

export async function commitFamilyCandidate(
  candidate: FamilyCandidate
): Promise<Family> {
  // Duplicate guard — block the commit if the registry already has a
  // family with the same head name + member count. This is the last
  // line of defence: PaperFormImport also runs a pre-flight check
  // before showing the Apply button, but DB state may have changed
  // since the modal opened (e.g. the admin Applied a previous card
  // in the same review session that ALSO matched). Throwing here is
  // safe — the caller's onApply handler catches and shows the
  // "Could not apply" state on the candidate card with this message.
  const dup = await findDuplicateFamily(
    candidate.head_name,
    candidate.member_count
  );
  if (dup) {
    throw new DuplicateFamilyError(
      `A family named "${dup.head_name}" with ${dup.member_count} members already exists (${dup.family_id}). Open that family to edit it instead.`,
      dup
    );
  }

  const now = new Date().toISOString();
  const family: Family = {
    family_id: newFamilyId(),
    head_name: candidate.head_name,
    member_count: candidate.member_count,
    children_under_5: candidate.children_under_5,
    elderly_count: candidate.elderly_count,
    has_pregnant_member: candidate.has_pregnant_member,
    medical_conditions: candidate.medical_conditions,
    displacement_status: candidate.displacement_status,
    income_level: candidate.income_level,
    location_sector: candidate.location_sector || 'Unassigned',
    last_updated: now,
    // Stash a provenance note so audit trails can see "imported from photo".
    notes: candidate.notes
      ? `${candidate.notes}\n\n[Imported from paper form via Gemma 4 vision on ${now.slice(0, 10)}]`
      : `[Imported from paper form via Gemma 4 vision on ${now.slice(0, 10)}]`,
  };

  // Compute the priority score / level / reason from demographics so the
  // new family lands on the list at the right urgency immediately.
  //
  // DELIBERATELY skipped: scored.recommended_items. The rule engine can
  // *suggest* items from demographics (e.g. children<5 → infant formula),
  // but those suggestions are not facts — they're hints. Persisting them
  // as the family's actual `recommended_items` would mean every imported
  // row arrives with auto-invented needs that nobody at the source ever
  // entered. The Family detail card and the Families list already fall
  // back to rule-engine suggestions when `recommended_items` is unset,
  // so the user still SEES the same hints in the UI — they just aren't
  // stamped onto the database row as if the source had provided them.
  // The admin adds real items via the Current Needs card's Edit button.
  const scored = computeRuleScore(family);
  family.priority_score = scored.priority_score;
  family.priority_level = scored.priority_level;
  family.ai_reason = scored.reason;

  await db.families.put(family);
  return family;
}
