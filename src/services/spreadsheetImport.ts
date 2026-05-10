// Spreadsheet import — CSV / XLSX → AidFlow Family records
// =========================================================================
//
// Pipeline:
//   1. parseSpreadsheet(file)       — sniffs CSV vs XLSX, returns rows.
//   2. proposeColumnMapping(...)    — asks Gemma 4 (or falls back to a
//                                     pure-string heuristic when offline)
//                                     for column → Family-field mapping.
//   3. coerceRow(row, mapping)      — applies type/enum coercion and
//                                     validates required fields.
//   4. commitImport(rows)           — single Dexie transaction; auto-mints
//                                     a fresh family_id per row.
//
// Privacy / offline: every AI call goes only to the local Ollama instance
// via the existing chat() helper. No network paths besides that. SheetJS
// is dynamically imported so CSV-only users don't pay the bundle cost.
// PapaParse is bundled (small).

import Papa from 'papaparse';
import { db } from '@/db/database';
import { chat, pingOllama } from '@/services/ollama';
import type { ChatMessage, Family, DisplacementStatus, IncomeLevel } from '@/types';

// ---- Public types -------------------------------------------------------

/**
 * The Family fields the import allows Gemma 4 to map onto. `family_id` is
 * deliberately excluded — IDs are system-generated.
 */
export type ImportableFamilyField =
  | 'head_name'
  | 'member_count'
  | 'children_under_5'
  | 'elderly_count'
  | 'has_pregnant_member'
  | 'medical_conditions'
  | 'displacement_status'
  | 'income_level'
  | 'location_sector'
  | 'street'
  | 'city'
  | 'notes';

export const IMPORTABLE_FIELDS: ImportableFamilyField[] = [
  'head_name',
  'member_count',
  'children_under_5',
  'elderly_count',
  'has_pregnant_member',
  'medical_conditions',
  'displacement_status',
  'income_level',
  'location_sector',
  'street',
  'city',
  'notes',
];

export interface ParsedSpreadsheet {
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: Record<string, string>[];
  /** Total rows incl. ones that may be skipped (empty / malformed). */
  rowCount: number;
}

export interface ColumnMapping {
  /** Map of spreadsheet header → ImportableFamilyField OR null (skip / send to notes). */
  mapping: Record<string, ImportableFamilyField | null>;
  /** Per-column human-readable reason; informational only. */
  reasoning: Record<string, string>;
  /** Whether the mapping was produced by Gemma 4 ("ai") or the offline heuristic ("heuristic"). */
  source: 'ai' | 'heuristic';
}

export interface CoercedRow {
  /** Family fields filled in from the row, ready to merge with a fresh family_id. */
  family: Omit<Family, 'family_id' | 'last_updated'>;
  /** Validation errors keyed by field name. Empty when the row is good to go. */
  errors: Record<string, string>;
  /** Warnings (e.g., values coerced to defaults). Informational. */
  warnings: string[];
  /** Original row index in the spreadsheet (1-based, header row excluded). */
  rowIndex: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { rowIndex: number; message: string }[];
}

// ---- Hard limits --------------------------------------------------------

/** Refuse files past this — keeps Gemma 4 prompt size sane and user workflows tractable. */
export const MAX_IMPORT_ROWS = 1000;
/** Refuse files past this — keeps malformed uploads from killing the parser. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---- Parsing ------------------------------------------------------------

/**
 * Sniff the file format and parse it. Always returns rows as plain string
 * objects keyed by the header — type/enum coercion happens later.
 */
export async function parseSpreadsheet(file: File): Promise<ParsedSpreadsheet> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max import size is ${
        MAX_FILE_SIZE_BYTES / 1024 / 1024
      } MB.`
    );
  }
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'csv' || file.type === 'text/csv') {
    return parseCsv(file);
  }
  if (ext === 'xlsx' || ext === 'xls' || file.type.includes('spreadsheet')) {
    return parseXlsx(file);
  }
  // Fall back to CSV — Papa is forgiving and will tell us if it's not CSV.
  return parseCsv(file);
}

function parseCsv(file: File): Promise<ParsedSpreadsheet> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (result) => {
        const headers = (result.meta.fields ?? []).map((h) => h.trim()).filter(Boolean);
        if (headers.length === 0) {
          reject(new Error('No headers found in the CSV. Make sure the first row is the column names.'));
          return;
        }
        const rows = (result.data ?? []).filter((r) => {
          // Drop rows where every cell is empty.
          return Object.values(r).some((v) => String(v ?? '').trim().length > 0);
        });
        if (rows.length > MAX_IMPORT_ROWS) {
          reject(
            new Error(
              `Spreadsheet has ${rows.length} rows; max is ${MAX_IMPORT_ROWS}. Split the file into smaller chunks.`
            )
          );
          return;
        }
        // Stringify every cell so downstream coercion has a uniform input.
        const stringifiedRows = rows.map((r) => {
          const out: Record<string, string> = {};
          for (const h of headers) out[h] = String(r[h] ?? '').trim();
          return out;
        });
        resolve({
          format: 'csv',
          headers,
          rows: stringifiedRows,
          rowCount: stringifiedRows.length,
        });
      },
      error: (err) => reject(err),
    });
  });
}

async function parseXlsx(file: File): Promise<ParsedSpreadsheet> {
  // Dynamic-import SheetJS so CSV-only users don't pay its bundle weight.
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) throw new Error('The XLSX file has no sheets.');
  const sheet = wb.Sheets[firstSheetName];
  // Extract as 2D array first to find headers manually — XLSX's sheet_to_json
  // header detection can be fragile with merged cells / leading blanks.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });
  if (aoa.length === 0) throw new Error('The first sheet appears to be empty.');
  const headerRow = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const headers = headerRow.filter(Boolean);
  if (headers.length === 0) {
    throw new Error('No headers found in the XLSX. Make sure the first row is the column names.');
  }
  const dataRows = aoa.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `Spreadsheet has ${dataRows.length} rows; max is ${MAX_IMPORT_ROWS}. Split the file into smaller chunks.`
    );
  }
  const rows: Record<string, string>[] = [];
  for (const r of dataRows) {
    const arr = r as unknown[];
    const out: Record<string, string> = {};
    let anyNonEmpty = false;
    for (let i = 0; i < headers.length; i++) {
      const cell = String(arr[i] ?? '').trim();
      out[headers[i]] = cell;
      if (cell.length > 0) anyNonEmpty = true;
    }
    if (anyNonEmpty) rows.push(out);
  }
  return {
    format: 'xlsx',
    headers,
    rows,
    rowCount: rows.length,
  };
}

// ---- Heuristic mapping (offline fallback) -------------------------------

/**
 * Lowercased synonyms for each Family field. Used by the offline heuristic
 * mapper and as a safety net when Gemma 4 returns garbage. Keep terms that
 * are realistic for humanitarian intake forms (English, plus a few common
 * abbreviations and Arabic / French / Spanish hints).
 */
const FIELD_SYNONYMS: Record<ImportableFamilyField, string[]> = {
  head_name: [
    'head of household',
    'head of family',
    'head_name',
    'household head',
    'hoh',
    'head',
    'name',
    'full name',
    'family name',
    'beneficiary name',
    'main contact',
    'nom du chef',
    'cabeza de familia',
    'اسم رب الأسرة',
  ],
  member_count: [
    'household size',
    'family size',
    'member count',
    'total members',
    'people',
    'persons',
    'individuals',
    'hh size',
    'taille du foyer',
    'tamaño del hogar',
    'عدد الأفراد',
  ],
  children_under_5: [
    'children under 5',
    'kids under 5',
    'under 5',
    'u5',
    'infants',
    'young children',
    'enfants moins de 5',
    'niños menores de 5',
    'أطفال دون الخامسة',
  ],
  elderly_count: [
    'elderly',
    '65+',
    '60+',
    'seniors',
    'older adults',
    'aged',
    'personnes âgées',
    'adultos mayores',
    'كبار السن',
  ],
  has_pregnant_member: [
    'pregnant',
    'pregnancy',
    'pregnant woman',
    'expecting',
    'femme enceinte',
    'embarazada',
    'حامل',
  ],
  medical_conditions: [
    'medical conditions',
    'medical',
    'conditions',
    'illness',
    'health issues',
    'chronic conditions',
    'diseases',
    'conditions médicales',
    'condiciones médicas',
    'حالات طبية',
  ],
  displacement_status: [
    'displacement',
    'displacement status',
    'status',
    'idp',
    'refugee status',
    'displaced',
    'situation',
    'estatus de desplazamiento',
    'حالة النزوح',
  ],
  income_level: [
    'income',
    'income level',
    'monthly income',
    'income bracket',
    'wealth',
    'revenu',
    'ingreso',
    'مستوى الدخل',
  ],
  location_sector: [
    'sector',
    'camp',
    'location',
    'area',
    'zone',
    'site',
    'district',
    'sub-district',
    'block',
    'cluster',
    'secteur',
    'sector / zona',
    'القطاع',
  ],
  street: [
    'street',
    'address',
    'street address',
    'house',
    'house no',
    'rue',
    'calle',
    'الشارع',
  ],
  city: ['city', 'town', 'village', 'municipality', 'ville', 'ciudad', 'المدينة'],
  notes: ['notes', 'comments', 'remarks', 'observations', 'note', 'observaciones', 'ملاحظات'],
};

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure-string heuristic: longest synonym match wins per field. Only one
 * spreadsheet column wins each Family field — the rest get null. Used as
 * the offline fallback and as the AI safety net.
 */
export function heuristicMapping(headers: string[]): ColumnMapping {
  const mapping: Record<string, ImportableFamilyField | null> = {};
  const reasoning: Record<string, string> = {};
  for (const h of headers) mapping[h] = null;

  // For each Family field, find the header with the strongest synonym hit.
  // We score by longest matching synonym character length.
  const taken = new Set<string>();
  for (const field of IMPORTABLE_FIELDS) {
    const syns = FIELD_SYNONYMS[field];
    let best: { header: string; matched: string } | null = null;
    for (const h of headers) {
      if (taken.has(h)) continue;
      const norm = normalizeHeader(h);
      if (!norm) continue;
      for (const syn of syns) {
        const sn = normalizeHeader(syn);
        if (!sn) continue;
        // exact match wins outright; substring also accepted for both directions
        if (norm === sn || norm.includes(sn) || sn.includes(norm)) {
          if (!best || sn.length > best.matched.length) {
            best = { header: h, matched: sn };
          }
        }
      }
    }
    if (best) {
      mapping[best.header] = field;
      reasoning[best.header] = `Heuristic match: "${best.header}" → ${field}`;
      taken.add(best.header);
    }
  }
  for (const h of headers) {
    if (!reasoning[h]) {
      reasoning[h] = mapping[h]
        ? `Heuristic match: ${mapping[h]}`
        : 'No close match — will be appended to notes if not skipped.';
    }
  }
  return { mapping, reasoning, source: 'heuristic' };
}

// ---- AI-assisted mapping ------------------------------------------------

const MAPPING_SYSTEM_PROMPT = `You are mapping spreadsheet columns from a humanitarian aid intake spreadsheet to fields of a family registry.

Available Family fields (and what they mean):
- "head_name": name of the head of household (string)
- "member_count": total people in the household (integer, >=1)
- "children_under_5": children under 5 years old (integer, >=0)
- "elderly_count": people 65 or older (integer, >=0)
- "has_pregnant_member": is there a pregnant household member? (boolean)
- "medical_conditions": comma- or semicolon-separated list of medical conditions
- "displacement_status": one of "resident", "recently_displaced", "refugee"
- "income_level": one of "none", "minimal", "moderate"
- "location_sector": sector / camp / area / district name
- "street": street address
- "city": city / town / village
- "notes": free-text notes

Strict rules:
- DO NOT map any column to "family_id" — IDs are system-generated, never imported.
- If a column clearly fits one Family field, map it to that field.
- If a column is borderline or specific to the user's organization (e.g. "NGO Reference Number"), map it to null — it will be appended to the family's notes field.
- Each Family field can be the target of AT MOST ONE column. If multiple columns plausibly fit the same field, keep only the best match and set the others to null.
- Output ONLY valid JSON with this exact shape:
  {
    "mapping": { "<column>": "<field>" | null, ... },
    "reasoning": { "<column>": "<short reason>", ... }
  }
- Every spreadsheet column must appear as a key in BOTH "mapping" and "reasoning".
- No preamble, no markdown, no commentary — just the JSON object.`;

/**
 * Build the user-facing AI prompt: column names + first 3 rows of sample data.
 * Sample rows help Gemma 4 disambiguate when header names are ambiguous.
 */
function buildMappingUserPrompt(headers: string[], sampleRows: Record<string, string>[]): string {
  const samples = sampleRows.slice(0, 3).map((r, i) => {
    const cells = headers.map((h) => `${h}: ${truncate(r[h] ?? '', 60)}`);
    return `Row ${i + 1}:\n  ${cells.join('\n  ')}`;
  });
  return [
    `Spreadsheet columns (${headers.length}):`,
    headers.map((h, i) => `${i + 1}. ${h}`).join('\n'),
    '',
    samples.length > 0 ? `Sample data (first ${samples.length} rows):` : 'No sample rows available.',
    samples.join('\n\n'),
    '',
    'Output the mapping JSON now.',
  ].join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Try Gemma 4 first; fall back to the heuristic on any failure.
 */
export async function proposeColumnMapping(
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<ColumnMapping> {
  if (!(await pingOllama())) {
    return heuristicMapping(headers);
  }
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: MAPPING_SYSTEM_PROMPT },
      { role: 'user', content: buildMappingUserPrompt(headers, sampleRows) },
    ];
    const raw = await chat(messages, { temperature: 0.1, maxTokens: 1024, numCtx: 8192 });
    const parsed = parseMappingJson(raw, headers);
    if (parsed) return parsed;
    // Garbage from the model — fall back.
    return heuristicMapping(headers);
  } catch (e) {
    console.warn('[spreadsheet-import] AI mapping failed, using heuristic', e);
    return heuristicMapping(headers);
  }
}

/**
 * Parse Gemma 4's JSON response. Defensive: strips code fences, slices to
 * the outermost braces, validates field names against the allowlist, and
 * fills in missing keys with null. Returns null if the response is so
 * malformed it can't be salvaged — caller falls back to the heuristic.
 */
export function parseMappingJson(
  raw: string,
  headers: string[]
): ColumnMapping | null {
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  // Strip ```json … ``` fences if present.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const rawMapping = (obj.mapping as Record<string, unknown> | undefined) ?? {};
  const rawReasoning = (obj.reasoning as Record<string, unknown> | undefined) ?? {};

  const mapping: Record<string, ImportableFamilyField | null> = {};
  const reasoning: Record<string, string> = {};
  const usedFields = new Set<ImportableFamilyField>();

  for (const h of headers) {
    const v = rawMapping[h];
    let field: ImportableFamilyField | null = null;
    if (typeof v === 'string' && (IMPORTABLE_FIELDS as string[]).includes(v)) {
      field = v as ImportableFamilyField;
      // Enforce uniqueness — if the model maps two columns to the same field,
      // keep the FIRST and null the rest.
      if (usedFields.has(field)) {
        field = null;
      } else {
        usedFields.add(field);
      }
    }
    mapping[h] = field;
    const reason = rawReasoning[h];
    reasoning[h] =
      typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim()
        : field
        ? `Mapped to ${field}.`
        : 'No close match — will be appended to notes if not skipped.';
  }

  // If the model returned a completely empty mapping (every value null),
  // treat that as a failure — the heuristic likely has better luck.
  const anyMapped = Object.values(mapping).some((v) => v !== null);
  if (!anyMapped) return null;

  return { mapping, reasoning, source: 'ai' };
}

// ---- Coercion + validation ---------------------------------------------

const TRUTHY = new Set([
  'yes',
  'y',
  'true',
  't',
  '1',
  'oui',
  'sí',
  'si',
  'نعم',
  'pregnant',
  'p',
]);
const FALSY = new Set(['no', 'n', 'false', 'f', '0', 'non', 'no aplica', 'لا', '']);

function coerceBoolean(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  // Anything non-empty that isn't an explicit false token counts as true —
  // most intake forms write "Yes"/"True" or leave it blank.
  return s.length > 0;
}

function coerceInteger(v: string, defaultValue = 0): number {
  if (!v) return defaultValue;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(0, Math.floor(n));
}

const DISPLACEMENT_SYNONYMS: Record<string, DisplacementStatus> = {
  resident: 'resident',
  host: 'resident',
  'host community': 'resident',
  local: 'resident',
  stable: 'resident',
  recently_displaced: 'recently_displaced',
  'recently displaced': 'recently_displaced',
  displaced: 'recently_displaced',
  idp: 'recently_displaced',
  'internally displaced': 'recently_displaced',
  refugee: 'refugee',
  asylum: 'refugee',
  'asylum-seeker': 'refugee',
};

function coerceDisplacement(v: string): DisplacementStatus {
  const k = v.trim().toLowerCase();
  return DISPLACEMENT_SYNONYMS[k] ?? 'resident';
}

const INCOME_SYNONYMS: Record<string, IncomeLevel> = {
  none: 'none',
  'no income': 'none',
  zero: 'none',
  '0': 'none',
  minimal: 'minimal',
  low: 'minimal',
  'very low': 'minimal',
  poor: 'minimal',
  moderate: 'moderate',
  medium: 'moderate',
  middle: 'moderate',
  stable: 'moderate',
  ok: 'moderate',
};

function coerceIncome(v: string): IncomeLevel {
  const k = v.trim().toLowerCase();
  return INCOME_SYNONYMS[k] ?? 'minimal';
}

function coerceMedicalConditions(v: string): string[] {
  if (!v) return [];
  return v
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Map one parsed row into a partial Family object using the column mapping.
 * Returns the family payload (without family_id / last_updated), validation
 * errors, and warnings about coercions that fell back to defaults.
 *
 * Unmapped columns (mapping[col] === null) are concatenated into the
 * family's notes field — preserved but not structured.
 */
export function coerceRow(
  row: Record<string, string>,
  mapping: Record<string, ImportableFamilyField | null>,
  rowIndex: number
): CoercedRow {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  // Set sensible defaults; mapped columns will overwrite below.
  const family: Omit<Family, 'family_id' | 'last_updated'> = {
    head_name: '',
    member_count: 1,
    children_under_5: 0,
    elderly_count: 0,
    has_pregnant_member: false,
    medical_conditions: [],
    displacement_status: 'resident',
    income_level: 'minimal',
    location_sector: 'general',
    notes: '',
  };

  // Track which inputs we used, so the rest go into notes.
  const consumedColumns = new Set<string>();
  // Collect the importer's own notes (mapped notes column) separately
  // from the unmapped columns we'll append.
  let notesFromMapping = '';
  const notesFromUnmapped: string[] = [];

  for (const [col, field] of Object.entries(mapping)) {
    const raw = (row[col] ?? '').trim();
    if (field === null) {
      // Unmapped — preserve in notes if non-empty.
      if (raw) notesFromUnmapped.push(`${col}: ${raw}`);
      continue;
    }
    consumedColumns.add(col);
    if (!raw) {
      // Empty cell — leave default. Skip silently.
      continue;
    }
    switch (field) {
      case 'head_name':
        family.head_name = raw;
        break;
      case 'member_count': {
        const n = coerceInteger(raw, 1);
        family.member_count = Math.max(1, n);
        break;
      }
      case 'children_under_5':
        family.children_under_5 = coerceInteger(raw, 0);
        break;
      case 'elderly_count':
        family.elderly_count = coerceInteger(raw, 0);
        break;
      case 'has_pregnant_member':
        family.has_pregnant_member = coerceBoolean(raw);
        break;
      case 'medical_conditions':
        family.medical_conditions = coerceMedicalConditions(raw);
        break;
      case 'displacement_status': {
        const v = coerceDisplacement(raw);
        if (v !== 'resident' || /^(resident|host|stable|local)/i.test(raw)) {
          family.displacement_status = v;
        } else {
          family.displacement_status = v;
          warnings.push(
            `Column "${col}" value "${raw}" mapped to "${v}" (default — value not recognized).`
          );
        }
        break;
      }
      case 'income_level': {
        const v = coerceIncome(raw);
        if (v === 'minimal' && !INCOME_SYNONYMS[raw.trim().toLowerCase()]) {
          warnings.push(
            `Column "${col}" value "${raw}" mapped to "minimal" (default — value not recognized).`
          );
        }
        family.income_level = v;
        break;
      }
      case 'location_sector':
        family.location_sector = raw;
        break;
      case 'street':
        family.street = raw;
        break;
      case 'city':
        family.city = raw;
        break;
      case 'notes':
        notesFromMapping = raw;
        break;
    }
  }

  // Cross-field validation / clamps.
  if (family.children_under_5 + family.elderly_count > family.member_count) {
    warnings.push(
      `children_under_5 (${family.children_under_5}) + elderly_count (${family.elderly_count}) exceeded member_count (${family.member_count}); member_count raised to fit.`
    );
    family.member_count = family.children_under_5 + family.elderly_count;
  }

  // Required: head_name.
  if (!family.head_name || family.head_name.trim().length === 0) {
    errors.head_name = 'Head of household name is required.';
  }

  // Stitch notes together: mapped notes column first, then unmapped lines.
  const noteSegments: string[] = [];
  if (notesFromMapping) noteSegments.push(notesFromMapping);
  if (notesFromUnmapped.length > 0) noteSegments.push(notesFromUnmapped.join('\n'));
  family.notes = noteSegments.join('\n\n');

  return { family, errors, warnings, rowIndex };
}

// ---- Commit -------------------------------------------------------------

/**
 * Mint a fresh family_id. Pattern matches FamilyEditModal.newFamilyId() but
 * appends a 4-char random suffix to avoid collisions when bulk-importing
 * multiple rows in the same millisecond.
 */
function newFamilyId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `F-${ts}-${rand}`;
}

/**
 * Write all coerced rows that have no validation errors to db.families in
 * a single Dexie transaction. Rows with errors are skipped (and reported
 * back). A fresh family_id is minted per row.
 */
export async function commitImport(rows: CoercedRow[]): Promise<ImportResult> {
  const valid = rows.filter((r) => Object.keys(r.errors).length === 0);
  const skipped = rows.length - valid.length;
  const errors: { rowIndex: number; message: string }[] = rows
    .filter((r) => Object.keys(r.errors).length > 0)
    .map((r) => ({
      rowIndex: r.rowIndex,
      message: Object.values(r.errors).join('; '),
    }));

  if (valid.length === 0) {
    return { imported: 0, skipped, errors };
  }

  const now = new Date().toISOString();
  const records: Family[] = valid.map((r) => ({
    family_id: newFamilyId(),
    last_updated: now,
    ...r.family,
  }));

  await db.transaction('rw', db.families, async () => {
    await db.families.bulkAdd(records);
  });

  return { imported: records.length, skipped, errors };
}
