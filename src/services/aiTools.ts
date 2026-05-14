// AidFlow Pro — Native function-calling tool catalog for Gemma 4.
//
// Gemma 4 supports native function (tool) calling via Ollama's /api/chat
// `tools` parameter (OpenAI-compatible schema). This module is the single
// source of truth for:
//
//   1. The JSON-Schema tool declarations sent to the model.
//   2. The typed TypeScript executors that run when the model invokes a tool.
//
// Tools are partitioned into two modes:
//
//   * READ tools  — the assistant runs them automatically; the result is
//                   handed back to the model so it can answer the user.
//                   Examples: get_family, find_families, get_history.
//
//   * WRITE tools — the assistant does NOT execute them. Instead it bubbles
//                   the proposed call up to the UI as an Apply/Discard card.
//                   Only the user can commit the change. The model gets a
//                   `{"status":"proposed_to_user"}` tool response so it
//                   stops looping and produces a confirmation sentence.
//
// This replaces the older fenced-`aidflow-action` JSON-block protocol with
// real OpenAI-style function calls, which is what the Gemma 4 Good
// Hackathon promo material explicitly calls out as a Gemma-4 strength.

import { db } from '@/db/database';
import type {
  AidDistribution,
  Family,
  NeededItem,
  PriorityLevel,
  Worker,
} from '@/types';
import { applyFamilyAction, type FamilyAction } from './familyActions';
import { addDistributionWithNextOrderNumber } from './orderNumber';
import { computeRuleScore } from './priorityRules';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JSONSchemaProperty>;
      required?: string[];
    };
  };
}

interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: JSONSchemaProperty | { type: string };
  minimum?: number;
}

export interface ToolCall {
  /** Optional id (some models emit one; many don't). */
  id?: string;
  function: {
    name: string;
    /** Ollama returns parsed objects; some models stringify. We accept both. */
    arguments: Record<string, unknown> | string;
  };
}

export type ToolMode = 'read' | 'write';

export interface ToolContext {
  /**
   * When set, the AI chat is scoped to a single family (Family Detail page).
   * Some tools (e.g. update_family_field) accept an implicit `family_id`
   * defaulting to this value, so the model doesn't have to pass it in.
   */
  scopedFamilyId?: string;
}

export interface ToolEntry {
  definition: ToolDefinition;
  mode: ToolMode;
  /** For READ tools: run server-side and return JSON. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /** Optional: render a friendly one-line description for the Apply card. */
  describe?: (args: Record<string, unknown>) => string;
  /**
   * Optional: for WRITE tools, convert the typed `args` into a `FamilyAction`
   * so we can reuse the existing apply pipeline (closed-set validation,
   * priority recompute, soft-delete handling, etc.). When omitted the tool
   * provides its own apply path inside `execute`.
   */
  toFamilyAction?: (args: Record<string, unknown>) => FamilyAction | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = NaN): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

function levelOf(score: number | undefined): PriorityLevel {
  const s = score ?? 0;
  if (s >= 80) return 'CRITICAL';
  if (s >= 60) return 'HIGH';
  if (s >= 40) return 'MEDIUM';
  return 'NORMAL';
}

function daysSince(iso?: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function compactFamily(f: Family) {
  return {
    family_id: f.family_id,
    head_name: f.head_name,
    sector: f.location_sector,
    members: f.member_count,
    children_under_5: f.children_under_5,
    elderly: f.elderly_count,
    pregnant: f.has_pregnant_member,
    displacement: f.displacement_status,
    income: f.income_level,
    medical_conditions: f.medical_conditions,
    current_needs: f.recommended_items ?? [],
    priority_score: f.priority_score ?? 0,
    priority_level: f.priority_level ?? levelOf(f.priority_score),
    last_aid_at: f.last_aid_at ?? null,
    days_since_last_aid: daysSince(f.last_aid_at),
  };
}

function compactDistribution(d: AidDistribution) {
  return {
    distribution_id: d.distribution_id,
    order_number: d.order_number ?? null,
    family_id: d.family_id,
    status: d.status,
    items: (d.items_distributed ?? []).map((i) => ({
      name: i.item_name,
      quantity: i.quantity,
    })),
    delivered_at: d.delivered_at ?? null,
    created_at: d.created_at ?? null,
    assigned_to: d.assigned_to ?? null,
    delivered_by: d.delivered_by ?? null,
    notes: d.post_update_notes ?? null,
    failure_reason: d.failure_reason ?? null,
  };
}

function compactWorker(w: Worker) {
  return {
    id: w.id,
    first_name: w.first_name,
    last_name: w.last_name,
    position: w.position,
  };
}

async function loadFamilies(): Promise<Family[]> {
  const rows = await db.families.toArray();
  return rows.filter((f) => !f.deleted_at);
}

async function loadWorkers(): Promise<Worker[]> {
  const rows = await db.workers.toArray();
  return rows.filter((w) => !w.deleted_at);
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS_ENUM = [
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

const TOOLS: Record<string, ToolEntry> = {
  // ---------------- READ TOOLS --------------------------------------------

  get_family: {
    mode: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'get_family',
        description:
          "Look up a single family by its family_id (e.g. F-001) or head-of-household name. Returns the family's demographics, current needs, medical conditions, sector, displacement status, priority score, and last-aid timestamp.",
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Family ID like F-001. Optional — provide either this OR head_name.',
            },
            head_name: {
              type: 'string',
              description: 'Head of household name. Case-insensitive substring match.',
            },
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
      const name = asString(args.head_name);
      if (!fid && !name) return { error: 'Provide family_id or head_name.' };
      const all = await loadFamilies();
      let hit: Family | undefined;
      if (fid) hit = all.find((f) => f.family_id.toLowerCase() === fid.toLowerCase());
      if (!hit && name) {
        const needle = name.toLowerCase();
        hit = all.find((f) => f.head_name.toLowerCase().includes(needle));
      }
      if (!hit) return { error: 'No matching family found.' };
      return compactFamily(hit);
    },
  },

  find_families: {
    mode: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'find_families',
        description:
          'Search the family registry by combinable filters. Use this for queries like "all critical families in Sector-B-North with no delivery in 7 days" — pass priority_level=CRITICAL, sector="Sector-B-North", min_days_since_last_aid=7. Sector values are operational area names (e.g. "Sector-A-South", "Sector-B-North", "Amman") — match what the user typed against the available data; do not invent humanitarian-cluster shorthand like "WASH" or "Food" unless those literal strings appear in the registry. Returns up to 50 compact family records sorted by priority score descending.',
        parameters: {
          type: 'object',
          properties: {
            sector: {
              type: 'string',
              description: 'Exact sector name (case-insensitive). Optional.',
            },
            priority_level: {
              type: 'string',
              enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'NORMAL'],
              description: 'Filter by priority level. Optional.',
            },
            min_priority_score: {
              type: 'integer',
              minimum: 0,
              description: 'Only families with score >= this value.',
            },
            min_days_since_last_aid: {
              type: 'integer',
              minimum: 0,
              description: 'Only families who have not received aid for at least this many days. Families that have never received aid count as Infinity and always match.',
            },
            displacement_status: {
              type: 'string',
              enum: ['resident', 'recently_displaced', 'refugee'],
              description: 'Filter by displacement status. Optional.',
            },
            has_pregnant_member: {
              type: 'boolean',
              description: 'Only families with a pregnant member.',
            },
            has_medical_condition: {
              type: 'string',
              description: 'Only families with at least one medical_conditions entry containing this substring (case-insensitive). E.g. "diabet" matches "diabetes (chronic)".',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              description: 'Max rows to return (default 50, hard cap 50).',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const all = await loadFamilies();
      const sector = asString(args.sector).toLowerCase();
      const level = asString(args.priority_level).toUpperCase() as PriorityLevel | '';
      const minScore = Number.isFinite(num(args.min_priority_score)) ? num(args.min_priority_score) : -1;
      const minDays = Number.isFinite(num(args.min_days_since_last_aid))
        ? num(args.min_days_since_last_aid)
        : -1;
      const displacement = asString(args.displacement_status);
      const hasPreg = args.has_pregnant_member === true;
      const hasMed = asString(args.has_medical_condition).toLowerCase();
      const limit = Math.max(1, Math.min(50, Math.floor(num(args.limit, 50))));

      const filtered = all.filter((f) => {
        if (sector && f.location_sector.toLowerCase() !== sector) return false;
        if (level && f.priority_level !== level && levelOf(f.priority_score) !== level) return false;
        if (minScore >= 0 && (f.priority_score ?? 0) < minScore) return false;
        if (minDays >= 0 && daysSince(f.last_aid_at) < minDays) return false;
        if (displacement && f.displacement_status !== displacement) return false;
        if (hasPreg && !f.has_pregnant_member) return false;
        if (hasMed && !f.medical_conditions.some((c) => c.toLowerCase().includes(hasMed))) return false;
        return true;
      });

      filtered.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

      return {
        matched: filtered.length,
        returned: Math.min(filtered.length, limit),
        families: filtered.slice(0, limit).map(compactFamily),
      };
    },
  },

  get_distribution_history: {
    mode: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'get_distribution_history',
        description:
          "Return a family's delivery ledger — every distribution row (pending, out_for_delivery, delivered, failed, cancelled) with items, dates, worker, notes, and failure reasons. Sorted newest first.",
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Family ID. Omit to use the currently scoped family.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              description: 'Max rows to return (default 20, hard cap 50).',
            },
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
      if (!fid) return { error: 'Provide family_id (no family scope active).' };
      const rows = await db.distributions.where('family_id').equals(fid).toArray();
      rows.sort((a, b) =>
        (b.delivered_at ?? b.created_at ?? '').localeCompare(a.delivered_at ?? a.created_at ?? '')
      );
      const limit = Math.max(1, Math.min(50, Math.floor(num(args.limit, 20))));
      return {
        family_id: fid,
        total: rows.length,
        returned: Math.min(rows.length, limit),
        distributions: rows.slice(0, limit).map(compactDistribution),
      };
    },
  },

  list_active_orders: {
    mode: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'list_active_orders',
        description:
          'List all orders that are pending or out_for_delivery (not yet delivered/failed/cancelled). Useful for "any orders stuck out for delivery for more than 24 hours?".',
        parameters: {
          type: 'object',
          properties: {
            min_age_hours: {
              type: 'integer',
              minimum: 0,
              description: 'Only orders created at least N hours ago.',
            },
            assigned_to: {
              type: 'string',
              description: 'Filter by worker ID.',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const minH = Math.max(0, Math.floor(num(args.min_age_hours, 0)));
      const worker = asString(args.assigned_to);
      const rows = await db.distributions.toArray();
      const now = Date.now();
      const active = rows.filter((d) => {
        if (d.status !== 'pending' && d.status !== 'out_for_delivery') return false;
        if (worker && d.assigned_to !== worker) return false;
        if (minH > 0) {
          const ageMs = now - new Date(d.created_at ?? d.dispatched_at ?? Date.now()).getTime();
          if (ageMs < minH * 3_600_000) return false;
        }
        return true;
      });
      active.sort((a, b) =>
        (a.created_at ?? '').localeCompare(b.created_at ?? '')
      );
      return {
        total: active.length,
        orders: active.map(compactDistribution),
      };
    },
  },

  find_workers: {
    mode: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'find_workers',
        description:
          'List field workers. Use available_only=true to exclude workers currently on a pending/out_for_delivery order (so the admin can assign a new dispatch).',
        parameters: {
          type: 'object',
          properties: {
            available_only: {
              type: 'boolean',
              description: 'Exclude workers with at least one active order.',
            },
            position: {
              type: 'string',
              description: 'Filter by position (e.g. "Field Worker", "Driver").',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const onlyFree = args.available_only === true;
      const position = asString(args.position).toLowerCase();
      const workers = await loadWorkers();
      let pool = workers;
      if (position) pool = pool.filter((w) => String(w.position).toLowerCase() === position);
      if (onlyFree) {
        const active = await db.distributions
          .where('status')
          .anyOf(['pending', 'out_for_delivery'])
          .toArray();
        const busy = new Set(active.map((d) => d.assigned_to).filter(Boolean) as string[]);
        pool = pool.filter((w) => !busy.has(w.id));
      }
      return {
        total: pool.length,
        workers: pool.map(compactWorker),
      };
    },
  },

  // ---------------- WRITE TOOLS (require user confirmation) ---------------

  update_family_field: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'update_family_field',
        description:
          "Propose an update to one structured profile field on a family record. The change is shown to the admin as an Apply/Discard card — it is NOT applied automatically. Use add_family_need or remove_family_need for items, NOT this function. Closed-set fields (location_sector, displacement_status, income_level) must match an existing value exactly.",
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Family ID. Omit to use the currently scoped family.',
            },
            field: {
              type: 'string',
              enum: ALLOWED_FIELDS_ENUM,
              description: 'Which field to change.',
            },
            value: {
              type: 'string',
              description:
                'New value as a string. Numbers (member_count etc.) are parsed; booleans accept "true"/"false"/"yes"/"no".',
            },
          },
          required: ['field', 'value'],
        },
      },
    },
    describe: (args) => {
      const field = asString(args.field);
      const value = asString(args.value);
      return `Set ${field.replace(/_/g, ' ')} to "${value}"`;
    },
    toFamilyAction: (args) => {
      const field = asString(args.field);
      const raw = args.value;
      if (!ALLOWED_FIELDS_ENUM.includes(field as (typeof ALLOWED_FIELDS_ENUM)[number])) {
        return null;
      }
      // Coerce based on the field's expected type.
      if (['member_count', 'children_under_5', 'elderly_count'].includes(field)) {
        const n = num(raw);
        if (!Number.isFinite(n) || n < 0) return null;
        return { type: 'set_field', field: field as FamilyAction extends { type: 'set_field'; field: infer F } ? F : never, value: Math.floor(n) } as FamilyAction;
      }
      if (field === 'has_pregnant_member') {
        const s = String(raw).toLowerCase();
        const truthy = ['true', 'yes', '1'].includes(s);
        const falsy = ['false', 'no', '0'].includes(s);
        if (!truthy && !falsy) return null;
        return { type: 'set_field', field: 'has_pregnant_member', value: truthy } as FamilyAction;
      }
      // String fields (head_name, sector, displacement_status, income_level, etc.).
      return { type: 'set_field', field: field as 'head_name', value: asString(raw) } as FamilyAction;
    },
    execute: async (args, ctx) => {
      // Write tools are never called directly; this is a safety net so the
      // model gets a structured "proposed" response if the runtime forgets
      // to intercept.
      const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
      return { status: 'proposed_to_user', family_id: fid, field: args.field };
    },
  },

  add_family_need: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'add_family_need',
        description:
          "Propose adding (or incrementing) a need item on a family's current-needs list. Quantity is a required positive integer. Surfaced as an Apply/Discard card.",
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Family ID. Omit to use the currently scoped family.',
            },
            item: {
              type: 'string',
              description: 'Free-form item name (e.g. "infant formula", "drinking water (20L)").',
            },
            quantity: {
              type: 'integer',
              minimum: 1,
              description: 'How many units to add.',
            },
          },
          required: ['item', 'quantity'],
        },
      },
    },
    describe: (args) =>
      `Add "${asString(args.item)}" ×${Math.max(1, Math.floor(num(args.quantity, 1)))} to current need items`,
    toFamilyAction: (args) => {
      const item = asString(args.item);
      const q = Math.max(1, Math.floor(num(args.quantity, 1)));
      if (!item) return null;
      return { type: 'add_recommended_item', item, quantity: q };
    },
    execute: async (args, ctx) => {
      const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
      return { status: 'proposed_to_user', family_id: fid, item: args.item };
    },
  },

  remove_family_need: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'remove_family_need',
        description:
          'Propose removing a need item (or decrementing its quantity) from a family. Omit quantity to delete the entry entirely; include quantity to subtract that many units. Surfaced as an Apply/Discard card.',
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Family ID. Omit to use the currently scoped family.',
            },
            item: {
              type: 'string',
              description: 'Item name — matched case-insensitively against the current needs list.',
            },
            quantity: {
              type: 'integer',
              minimum: 1,
              description:
                'Optional. Omit for full delete; pass N to subtract N units.',
            },
          },
          required: ['item'],
        },
      },
    },
    describe: (args) => {
      const q = Math.floor(num(args.quantity, 0));
      const item = asString(args.item);
      return q > 0
        ? `Remove ${q} of "${item}" from current need items`
        : `Remove "${item}" entirely from current need items`;
    },
    toFamilyAction: (args) => {
      const item = asString(args.item);
      if (!item) return null;
      const q = Math.floor(num(args.quantity, 0));
      return q > 0
        ? { type: 'remove_recommended_item', item, quantity: q }
        : { type: 'remove_recommended_item', item };
    },
    execute: async (args, ctx) => {
      const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
      return { status: 'proposed_to_user', family_id: fid, item: args.item };
    },
  },

  add_medical_condition: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'add_medical_condition',
        description:
          'Propose adding a medical condition flag to a family. Include severity in parentheses (lowercase), e.g. "diabetes (chronic)". Surfaced as an Apply/Discard card.',
        parameters: {
          type: 'object',
          properties: {
            family_id: { type: 'string', description: 'Optional — defaults to scoped family.' },
            condition: { type: 'string', description: 'Condition with severity, e.g. "asthma (mild)".' },
          },
          required: ['condition'],
        },
      },
    },
    describe: (args) => `Add medical condition: "${asString(args.condition)}"`,
    toFamilyAction: (args) => {
      const c = asString(args.condition);
      return c ? { type: 'add_medical_condition', condition: c } : null;
    },
    execute: async (args, ctx) => ({
      status: 'proposed_to_user',
      family_id: asString(args.family_id) || ctx.scopedFamilyId || '',
    }),
  },

  remove_medical_condition: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'remove_medical_condition',
        description: 'Propose removing a medical condition flag from a family.',
        parameters: {
          type: 'object',
          properties: {
            family_id: { type: 'string' },
            condition: { type: 'string' },
          },
          required: ['condition'],
        },
      },
    },
    describe: (args) => `Remove medical condition: "${asString(args.condition)}"`,
    toFamilyAction: (args) => {
      const c = asString(args.condition);
      return c ? { type: 'remove_medical_condition', condition: c } : null;
    },
    execute: async (args, ctx) => ({
      status: 'proposed_to_user',
      family_id: asString(args.family_id) || ctx.scopedFamilyId || '',
    }),
  },

  draft_dispatch_order: {
    mode: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'draft_dispatch_order',
        description:
          "Draft a new aid distribution order from this family with these items. The order is NOT created until the admin clicks Apply on the card. `worker_id` is OPTIONAL — omit it (or pass an empty string) when the admin says they'll assign a worker themselves later; the order is then created in PENDING status and the admin can assign + dispatch from the Distribute page when ready. If the user does want it assigned now, call find_workers(available_only=true) first to pick someone not already busy. Use the family's current_needs list (from get_family) as the default items if the user didn't specify what to send.",
        parameters: {
          type: 'object',
          properties: {
            family_id: {
              type: 'string',
              description: 'Recipient family.',
            },
            worker_id: {
              type: 'string',
              description:
                'Optional. Worker who will perform the delivery. Omit to leave the order unassigned (admin assigns later).',
            },
            items: {
              type: 'array',
              description: 'List of items to deliver. Each entry has name and quantity.',
              items: {
                type: 'object',
              } as JSONSchemaProperty,
            },
            notes: {
              type: 'string',
              description: 'Optional dispatch notes.',
            },
          },
          required: ['family_id', 'items'],
        },
      },
    },
    describe: (args) => {
      const items = (Array.isArray(args.items) ? args.items : []) as Array<{
        name?: string;
        item_name?: string;
        item?: string;
        quantity?: number;
      }>;
      const summary =
        items
          .map((i) => `${asString(i.name ?? i.item_name ?? i.item)} ×${Math.max(1, Math.floor(num(i.quantity, 1)))}`)
          .filter(Boolean)
          .slice(0, 4)
          .join(', ') +
        (items.length > 4 ? `, +${items.length - 4} more` : '');
      const wid = asString(args.worker_id);
      const who = wid ? `worker ${wid}` : 'unassigned (admin will assign later)';
      return `Dispatch ${summary || '(no items)'} to family ${asString(args.family_id)} · ${who}`;
    },
    execute: async (args, ctx) => ({
      status: 'proposed_to_user',
      family_id: asString(args.family_id) || ctx.scopedFamilyId || '',
      worker_id: asString(args.worker_id),
    }),
  },
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Returns the JSON-Schema tool definitions to send to Ollama in the
 * `tools` field. When `scopedFamilyId` is provided, we expose a single
 * description sentence that tells the model the family is already chosen
 * so it doesn't bother asking for the ID.
 */
export function getToolDefinitions(opts: { scopedFamilyId?: string } = {}): ToolDefinition[] {
  const defs = Object.values(TOOLS).map((t) => t.definition);
  if (opts.scopedFamilyId) {
    // Patch get_family to mention the scope so the model relies on default.
    return defs.map((d) =>
      d.function.name === 'get_family'
        ? {
            ...d,
            function: {
              ...d.function,
              description:
                d.function.description +
                ` The current chat is scoped to family_id=${opts.scopedFamilyId}; omit family_id to use it.`,
            },
          }
        : d
    );
  }
  return defs;
}

export function isWriteTool(name: string): boolean {
  return TOOLS[name]?.mode === 'write';
}

export function describeToolCall(call: ToolCall): string {
  const t = TOOLS[call.function.name];
  if (!t) return `${call.function.name}(…)`;
  const args = parseToolArgs(call);
  if (t.describe) return t.describe(args);
  return `${call.function.name}(${Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ')})`;
}

/** Normalize the arguments field to a plain object. */
export function parseToolArgs(call: ToolCall): Record<string, unknown> {
  const a = call.function.arguments;
  if (a == null) return {};
  if (typeof a === 'string') {
    try {
      const j = JSON.parse(a);
      return typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return a;
}

/**
 * Run a READ tool. Throws when the tool doesn't exist or is a write tool —
 * those must go through the Apply/Discard UI, never auto-execute.
 */
export async function executeReadTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.mode !== 'read') {
    throw new Error(`Tool ${name} is a write tool; route via the confirmation UI.`);
  }
  return await tool.execute(args, ctx);
}

/**
 * Apply a WRITE tool call that the user clicked Apply on. Routes through
 * `applyFamilyAction` when possible (so we reuse closed-set validation +
 * priority recompute). For draft_dispatch_order we return the typed payload
 * so the caller can hand it to the existing dispatch wizard / order minter.
 */
export type ApplyOutcome =
  | { kind: 'family'; family: Family }
  | { kind: 'draft_order'; payload: DraftOrderPayload };

export interface DraftOrderPayload {
  family_id: string;
  /** Optional. Orders may be created unassigned and assigned later from the Distribute page. */
  worker_id?: string;
  items: Array<{ name: string; quantity: number; category?: string }>;
  notes?: string;
}

export async function applyToolCall(
  call: ToolCall,
  ctx: ToolContext
): Promise<ApplyOutcome> {
  const args = parseToolArgs(call);
  const tool = TOOLS[call.function.name];
  if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
  if (tool.mode !== 'write') {
    throw new Error(`Tool ${call.function.name} is read-only.`);
  }

  if (call.function.name === 'draft_dispatch_order') {
    const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
    const wid = asString(args.worker_id);
    if (!fid) throw new Error('Missing family_id.');
    // worker_id is intentionally optional — unassigned orders are created
    // in PENDING status and the admin assigns + dispatches from /distribute.
    const raw = Array.isArray(args.items) ? args.items : [];
    const items = raw
      .map((i) => {
        const obj = (i ?? {}) as Record<string, unknown>;
        const name = asString(obj.name ?? obj.item_name ?? obj.item);
        const qty = Math.max(1, Math.floor(num(obj.quantity ?? obj.qty, 1)));
        return name ? { name, quantity: qty } : null;
      })
      .filter(Boolean) as Array<{ name: string; quantity: number }>;
    if (items.length === 0) throw new Error('No items specified for the order.');
    return {
      kind: 'draft_order',
      payload: {
        family_id: fid,
        worker_id: wid || undefined,
        items,
        notes: asString(args.notes) || undefined,
      },
    };
  }

  // All other write tools map to a FamilyAction.
  const action = tool.toFamilyAction?.(args);
  if (!action) {
    throw new Error(
      `Could not convert ${call.function.name}(${JSON.stringify(args)}) into a family action.`
    );
  }
  const fid = asString(args.family_id) || ctx.scopedFamilyId || '';
  if (!fid) {
    throw new Error('No family_id provided and no scoped family — cannot apply.');
  }
  const family = await applyFamilyAction(fid, action);
  return { kind: 'family', family };
}

/**
 * Commit an approved draft_dispatch_order to the distributions table.
 * Reuses the same atomic order-number minter the manual wizard uses, so
 * AI-drafted orders interleave correctly with manually-created ones.
 */
export async function commitDraftOrder(
  payload: DraftOrderPayload,
  createdBy: string
): Promise<{ distribution_id: string; order_number: number }> {
  const family = await db.families.get(payload.family_id);
  if (!family) throw new Error(`Family ${payload.family_id} not found.`);
  // worker_id is optional. When present, validate it exists so we don't
  // create an order pointing at a phantom worker id. When absent, the order
  // is created PENDING + unassigned; the admin assigns from /distribute.
  if (payload.worker_id) {
    const worker = await db.workers.get(payload.worker_id);
    if (!worker) throw new Error(`Worker ${payload.worker_id} not found.`);
  }

  const now = new Date().toISOString();
  const score = family.priority_score ?? computeRuleScore(family).priority_score;
  const items = payload.items.map((i) => ({
    item_name: i.name,
    quantity: i.quantity,
    category: i.category ?? 'general',
  }));
  const row = await addDistributionWithNextOrderNumber({
    distribution_id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    family_id: payload.family_id,
    session_id: `S-${now.slice(0, 10)}`,
    status: 'pending',
    items_distributed: items,
    created_at: now,
    created_by: createdBy,
    assigned_to: payload.worker_id || undefined,
    ai_priority_score: score,
    ai_reasoning: family.ai_reason ?? '',
    notes: payload.notes,
  });
  return {
    distribution_id: row.distribution_id,
    order_number: row.order_number ?? -1,
  };
}
