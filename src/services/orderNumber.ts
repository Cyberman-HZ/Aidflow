// Sequential order number helpers for AidDistribution.
// Numbers are 1-indexed. Display format: "ORD-001", "ORD-042", "ORD-1024".

import { db } from '@/db/database';

export function formatOrderNumber(n?: number): string {
  if (n == null) return 'ORD-—';
  if (n < 1000) return `ORD-${String(n).padStart(3, '0')}`;
  return `ORD-${n}`;
}

/**
 * Returns the next sequential order_number to assign to a new distribution.
 * Reads max(order_number) over all rows. Concurrency note: in the unlikely
 * event two creators race, both might see the same max — the worst case
 * is two orders sharing a number (cosmetic only). We could add a Dexie
 * transaction-level mutex if this ever becomes a real issue.
 */
export async function nextOrderNumber(): Promise<number> {
  const rows = await db.distributions.toArray();
  let max = 0;
  for (const d of rows) {
    if (typeof d.order_number === 'number' && d.order_number > max) {
      max = d.order_number;
    }
  }
  return max + 1;
}
