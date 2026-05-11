// Shared duplicate-family detection. Used at every family-creation entry
// point (manual form, spreadsheet wizard, photo ingest) so a duplicate
// cannot land in the registry no matter which path the admin uses.
//
// Match rule (per product spec):
//   - same `head_name` (trimmed, case-insensitive Unicode lowercase)
//   - AND same `member_count`
//   - against existing NON-deleted families
//
// Why those two fields and not more:
//   - Head name alone collides on common names ("Mohammed", "Maria").
//   - Member count is a stable household-size discriminator that survives
//     typos in other fields (a worker who mis-typed the sector is still
//     the same family).
//   - We intentionally do NOT match against soft-deleted families: if an
//     admin deleted a household and then re-registered it, that's likely
//     intentional (the delete reason flow makes the destruction explicit).
//
// Why a separate file (vs. inlining): three callers + we want one place
// to evolve the rule (e.g. add fuzzy-match later) without touching every
// import path.

import { db } from '@/db/database';

export interface DuplicateMatch {
  /** Existing family that the input would collide with. */
  family_id: string;
  head_name: string;
  member_count: number;
}

/**
 * Normalize a head-of-household name for duplicate comparison.
 *
 *   - Trims leading / trailing whitespace.
 *   - Collapses runs of internal whitespace to a single space so
 *     "Ahmed  Al-Rashid" matches "Ahmed Al-Rashid".
 *   - Lowercases using `toLocaleLowerCase()` so Arabic / French casing
 *     behaves correctly (Turkish dotless-i etc. — Locale-aware fold).
 *
 * Exported so QA tests can exercise the exact same comparison.
 */
export function normalizeHeadName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Look up the first non-deleted family that would duplicate the input
 * `(headName, memberCount)` pair. Returns `null` when no collision.
 *
 * `excludeId` is for the edit path — we don't want to flag a family
 * as duplicating itself when the admin opens an existing record.
 */
export async function findDuplicateFamily(
  headName: string,
  memberCount: number,
  excludeId?: string
): Promise<DuplicateMatch | null> {
  const needle = normalizeHeadName(headName);
  if (!needle) return null;
  if (!Number.isFinite(memberCount) || memberCount < 1) return null;

  const all = await db.families.toArray();
  const hit = all.find(
    (f) =>
      !f.deleted_at &&
      f.family_id !== excludeId &&
      f.member_count === memberCount &&
      normalizeHeadName(f.head_name) === needle
  );
  return hit
    ? {
        family_id: hit.family_id,
        head_name: hit.head_name,
        member_count: hit.member_count,
      }
    : null;
}

/**
 * Synchronous variant for when the caller already has the full families
 * array in hand (e.g. via useLiveQuery in a React component). Saves a
 * round trip to Dexie when the page is rendering a list anyway.
 */
export function findDuplicateFamilySync(
  families: Array<{
    family_id: string;
    head_name: string;
    member_count: number;
    deleted_at?: string;
  }>,
  headName: string,
  memberCount: number,
  excludeId?: string
): DuplicateMatch | null {
  const needle = normalizeHeadName(headName);
  if (!needle) return null;
  if (!Number.isFinite(memberCount) || memberCount < 1) return null;
  const hit = families.find(
    (f) =>
      !f.deleted_at &&
      f.family_id !== excludeId &&
      f.member_count === memberCount &&
      normalizeHeadName(f.head_name) === needle
  );
  return hit
    ? {
        family_id: hit.family_id,
        head_name: hit.head_name,
        member_count: hit.member_count,
      }
    : null;
}
