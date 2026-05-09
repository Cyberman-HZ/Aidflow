// Sequential order number helpers for AidDistribution.
// Numbers are 1-indexed. Display format: "ORD-001", "ORD-042", "ORD-1024".

import { db } from '@/db/database';
import type { AidDistribution } from '@/types';

export function formatOrderNumber(n?: number): string {
  if (n == null) return 'ORD-—';
  if (n < 1000) return `ORD-${String(n).padStart(3, '0')}`;
  return `ORD-${n}`;
}

// Pure helper: highest order_number in a list of rows.
function maxOrderNumber(rows: Pick<AidDistribution, 'order_number'>[]): number {
  let max = 0;
  for (const d of rows) {
    if (typeof d.order_number === 'number' && d.order_number > max) {
      max = d.order_number;
    }
  }
  return max;
}

/**
 * Read-only preview of the next order number. NOT safe under concurrent
 * creation — two callers may see the same max. Use
 * {@link addDistributionWithNextOrderNumber} for the atomic write path.
 */
export async function nextOrderNumber(): Promise<number> {
  const rows = await db.distributions.toArray();
  return maxOrderNumber(rows) + 1;
}

/**
 * Atomically reserves the next sequential order_number AND inserts the row,
 * all inside a Dexie 'rw' transaction so concurrent creators cannot collide.
 */
export async function addDistributionWithNextOrderNumber(
  order: Omit<AidDistribution, 'order_number'>
): Promise<AidDistribution> {
  return db.transaction('rw', db.distributions, async () => {
    const rows = await db.distributions.toArray();
    const order_number = maxOrderNumber(rows) + 1;
    const full: AidDistribution = { ...order, order_number };
    await db.distributions.add(full);
    return full;
  });
}
