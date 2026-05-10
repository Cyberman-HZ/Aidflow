// Deterministic intent detector for the family chat.
//
// Why this exists: small local models like Gemma 4 4B routinely refuse to
// emit ```aidflow-action``` blocks even when the protocol is correct. We use
// this regex-based detector as a deterministic FIRST PASS — if the user's
// input matches an unambiguous intent against the family's current state,
// we emit the action card directly without ever calling the LLM. This is
// fast, deterministic, offline-safe, and fully testable.
//
// The LLM remains the fallback for anything that doesn't match here
// (questions, ambiguous requests, complex edits, etc.).

import type { Family, NeededItem } from '@/types';
import type { FamilyAction } from '@/services/familyActions';

export interface IntentResult {
  actions: FamilyAction[];
  reply: string;
  /** True if we matched something deterministically; false if we should fall back to the LLM. */
  matched: boolean;
}

const STRIPPABLE = /^(please |kindly |can you |could you |would you |i want to |i'd like to |let's |lets |go )+/i;

/**
 * Find a canonical item name from the family's current needs by case-insensitive
 * substring matching. Returns the actual stored name (preserving casing) or null.
 */
/**
 * Find an item from the family's needs by case-insensitive matching with
 * clear precedence:
 *   1. Exact match (case-insensitive)
 *   2. Token-boundary match — query equals one of the words in the item name
 *      e.g. "infant" matches an item NAMED "infant" but does NOT match an
 *      item named "infant formula" via this rule
 *   3. Substring match — preferring the SHORTEST candidate (closest in length
 *      to the query), so "infant" → "infant" wins over "infant formula"
 */
function findItem(family: Family, query: string): NeededItem | null {
  const items = family.recommended_items ?? [];
  const q = query.toLowerCase().trim();
  if (!q) return null;

  // Pass 1: exact case-insensitive match
  const exact = items.find((i) => i.name.toLowerCase() === q);
  if (exact) return exact;

  // Pass 2: token-boundary match — split each item name on whitespace and
  // check if any token equals the query exactly. This gives "infant" precise
  // priority over "infant formula" when the user said just "infant".
  const tokenMatch = items.find((i) =>
    i.name
      .toLowerCase()
      .split(/[\s/.\-_]+/)
      .includes(q)
  );
  if (tokenMatch) return tokenMatch;

  // Pass 3: substring match — prefer the SHORTEST candidate (closest in
  // length to the query). This way the user typing a partial item name gets
  // the most specific match, not the longest one that happens to contain it.
  const subs = items
    .filter(
      (i) =>
        i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase())
    )
    .sort((a, b) => a.name.length - b.name.length);
  return subs[0] ?? null;
}

/**
 * Detects the user's intent from a free-text message and emits a list of
 * FamilyActions when the request is unambiguous. Order matters — patterns
 * are tried top-down, first match wins.
 */
export function detectIntent(rawInput: string, family: Family): IntentResult {
  const cleaned = rawInput.trim().replace(STRIPPABLE, '').trim();
  if (!cleaned) return { actions: [], reply: '', matched: false };

  const items = family.recommended_items ?? [];

  // ----- REMOVE patterns (most specific first) ------------------------------

  // "remove all X" / "delete all X" / "remove every X"
  const removeAll = cleaned.match(
    /^(?:remove|delete|clear|drop)\s+(?:all|every)\s+(?:of\s+)?(.+?)(?:\s+from.*)?$/i
  );
  if (removeAll) {
    const target = removeAll[1].trim();
    const item = findItem(family, target);
    if (item) {
      return {
        matched: true,
        actions: [{ type: 'remove_recommended_item', item: item.name }],
        reply: `Deleting "${item.name}" from the current need items.`,
      };
    }
    return {
      matched: true,
      actions: [],
      reply: `I do not see "${target}" in this family's current needs. Current needs: ${formatItems(items)}.`,
    };
  }

  // "remove N X" / "remove Nx X" / "remove N units of X" / "take N X away"
  const removeN = cleaned.match(
    /^(?:remove|subtract|take\s+away|reduce|decrease)\s+(\d+)\s*(?:x|×|units?\s+of|of)?\s+(.+?)(?:\s+from.*)?$/i
  );
  if (removeN) {
    const qty = parseInt(removeN[1], 10);
    const target = removeN[2].trim();
    const item = findItem(family, target);
    if (item) {
      return {
        matched: true,
        actions: [
          {
            type: 'remove_recommended_item',
            item: item.name,
            quantity: qty,
          },
        ],
        reply:
          qty >= item.quantity
            ? `Removing all ${item.quantity} of "${item.name}" (the request of ${qty} meets or exceeds the current count).`
            : `Removing ${qty} of "${item.name}" (was ×${item.quantity}, will be ×${item.quantity - qty}).`,
      };
    }
    return {
      matched: true,
      actions: [],
      reply: `I do not see "${target}" in this family's current needs. Current needs: ${formatItems(items)}.`,
    };
  }

  // "remove X" — AMBIGUOUS if quantity > 1, else delete the entry
  const removePlain = cleaned.match(
    /^(?:remove|delete|drop)\s+(.+?)(?:\s+from.*)?$/i
  );
  if (removePlain) {
    const target = removePlain[1].trim();
    const item = findItem(family, target);
    if (!item) {
      return {
        matched: true,
        actions: [],
        reply: `I do not see "${target}" in this family's current needs. Current needs: ${formatItems(items)}.`,
      };
    }
    if (item.quantity > 1) {
      // Ambiguous — ask the user to clarify
      return {
        matched: true,
        actions: [],
        reply: `"${item.name}" currently has quantity ×${item.quantity}. Did you want to (a) remove the whole entry, or (b) decrease the quantity by some amount? Reply "remove all ${item.name}" or "remove N ${item.name}".`,
      };
    }
    return {
      matched: true,
      actions: [{ type: 'remove_recommended_item', item: item.name }],
      reply: `Removing "${item.name}" (×1) from current needs.`,
    };
  }

  // ----- ADD patterns -------------------------------------------------------

  // "add N X" / "add N units of X" / "include N X"
  const addN = cleaned.match(
    /^(?:add|include|need|put)\s+(\d+)\s*(?:x|×|units?\s+of|of)?\s+(?:more\s+)?(.+?)(?:\s+to.*)?$/i
  );
  if (addN) {
    const qty = parseInt(addN[1], 10);
    const target = addN[2].trim();
    // Canonicalise against the family's existing needs first — if the
    // user types "add 5 bottles of water" and the family already has
    // "drinking water (20L)", we want to MERGE on that existing chip
    // rather than create a fragmented duplicate. Bug fix: previously we
    // emitted the raw target verbatim, so the same logical need landed
    // under multiple names ("water", "drinking water", "bottled water").
    const existing = findItem(family, target);
    const useName = existing ? existing.name : target;
    return {
      matched: true,
      actions: [
        { type: 'add_recommended_item', item: useName, quantity: qty },
      ],
      reply: existing
        ? `Adding ${qty} more to existing "${useName}".`
        : `Adding ${qty} × "${useName}" to current needs.`,
    };
  }

  // "add another X" / "add one more X" / "one more X"
  const addOne = cleaned.match(
    /^(?:add\s+(?:another|one\s+more)|one\s+more)\s+(.+?)(?:\s+to.*)?$/i
  );
  if (addOne) {
    const target = addOne[1].trim();
    const existing = findItem(family, target);
    const useName = existing ? existing.name : target;
    return {
      matched: true,
      actions: [
        { type: 'add_recommended_item', item: useName, quantity: 1 },
      ],
      reply: existing
        ? `Adding 1 more to existing "${useName}".`
        : `Adding 1 × "${useName}" to current needs.`,
    };
  }

  // "add X" with NO quantity — ask for clarification
  const addPlain = cleaned.match(/^(?:add|include|need)\s+(.+?)(?:\s+to.*)?$/i);
  if (addPlain) {
    const itemName = addPlain[1].trim();
    // If the bareword starts with a number we already caught it above,
    // so this path means there was no number.
    return {
      matched: true,
      actions: [],
      reply: `How many units of "${itemName}" should I add?`,
    };
  }

  return { matched: false, actions: [], reply: '' };
}

function formatItems(items: NeededItem[]): string {
  if (items.length === 0) return '(none)';
  return items.map((i) => `${i.name} ×${i.quantity}`).join(', ');
}
