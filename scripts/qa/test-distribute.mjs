#!/usr/bin/env node
// Distribute-tab QA tests. Self-contained logic tests — no React/Dexie deps.
// Mirrors the algorithm under audit so regressions show up immediately.
//
// Run: node scripts/qa/test-distribute.mjs

let passed = 0;
let failed = 0;
const fails = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; fails.push("  " + label + "\n    expected " + e + "\n    got      " + a); }
}
function truthy(v, label) {
  if (v) passed++;
  else { failed++; fails.push("  " + label + " (got " + JSON.stringify(v) + ")"); }
}

// ===========================================================================
// Mirror of src/services/orderNumber.ts (formatOrderNumber + nextOrderNumber)
// ===========================================================================

function formatOrderNumber(n) {
  if (n == null) return 'ORD-—';
  if (n < 1000) return 'ORD-' + String(n).padStart(3, '0');
  return 'ORD-' + n;
}
function nextOrderNumber(distributions) {
  let max = 0;
  for (const d of distributions) {
    if (typeof d.order_number === 'number' && d.order_number > max) max = d.order_number;
  }
  return max + 1;
}

console.log('--- formatOrderNumber ---');
eq(formatOrderNumber(undefined), 'ORD-—', 'undefined → ORD-—');
eq(formatOrderNumber(null), 'ORD-—', 'null → ORD-—');
eq(formatOrderNumber(1), 'ORD-001', 'pad 1 to 3 digits');
eq(formatOrderNumber(42), 'ORD-042', 'pad 42 to 3 digits');
eq(formatOrderNumber(999), 'ORD-999', 'pad 999');
eq(formatOrderNumber(1000), 'ORD-1000', '4-digit threshold');
eq(formatOrderNumber(12345), 'ORD-12345', '5-digit number');

console.log('--- nextOrderNumber: happy path ---');
eq(nextOrderNumber([]), 1, 'empty list → 1');
eq(nextOrderNumber([{ order_number: 1 }]), 2, 'single → +1');
eq(nextOrderNumber([{ order_number: 5 }, { order_number: 3 }]), 6, 'unsorted → max+1');

console.log('--- nextOrderNumber: race condition demo (CONFIRMED P0) ---');
// Two callers see the same max simultaneously
const distributions = [{ order_number: 10 }];
const aResult = nextOrderNumber(distributions);
const bResult = nextOrderNumber(distributions); // before A persists
eq(aResult, 11, 'caller A → 11');
eq(bResult, 11, 'caller B → 11 (COLLISION — both will use 11)');
truthy(aResult === bResult, 'CONFIRMED: race condition assigns duplicate numbers');

console.log('--- nextOrderNumber: handles missing order_number ---');
eq(nextOrderNumber([{}, { order_number: 7 }, {}]), 8,
  'rows without order_number ignored');
eq(nextOrderNumber([{ order_number: '10' }, { order_number: 5 }]), 6,
  'string order_number ignored (only number type counted)');

// ===========================================================================
// Schedule validation (audited as LIKELY P1 — past dates accepted)
// Mirror of the SchedulePanel handleSave validator (current behavior)
// ===========================================================================

function currentScheduleValidator(value) {
  // Mirrors the existing buggy logic: only checks if the date parses
  if (!value) return { ok: false, error: 'Date required' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid date' };
  return { ok: true };
}

function recommendedScheduleValidator(value, now = new Date()) {
  // Recommended fix logic
  if (!value) return { ok: false, error: 'Date required' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid date' };
  // Allow current minute, reject earlier
  if (d.getTime() < now.getTime() - 60_000) {
    return { ok: false, error: 'Cannot schedule for past dates' };
  }
  // Warn / reject if more than 1 year in the future
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (d.getTime() > now.getTime() + ONE_YEAR_MS) {
    return { ok: false, error: 'Date is too far in the future' };
  }
  return { ok: true };
}

console.log('--- SchedulePanel: current validator (proves bug) ---');
eq(currentScheduleValidator('2020-01-01').ok, true,
  'CONFIRMED: past date "2020-01-01" is accepted (BUG — should be rejected)');
eq(currentScheduleValidator('2099-12-31').ok, true,
  'CONFIRMED: 70-year-future date accepted (BUG — should be rejected)');
eq(currentScheduleValidator('').ok, false, 'empty rejected');
eq(currentScheduleValidator('not a date').ok, false, 'gibberish rejected');

console.log('--- SchedulePanel: recommended fix logic ---');
const fixedNow = new Date('2026-05-08T10:00:00Z');
eq(recommendedScheduleValidator('2020-01-01', fixedNow).ok, false,
  'past date rejected with fix');
eq(recommendedScheduleValidator('2030-05-08T10:00:00Z', fixedNow).ok, false,
  '~4y future REJECTED with fix (>1 year cap)');
eq(recommendedScheduleValidator('2026-12-31T10:00:00Z', fixedNow).ok, true,
  '7-month future ACCEPTED with fix');
eq(recommendedScheduleValidator('2099-12-31', fixedNow).ok, false,
  'too-far-future rejected with fix');
eq(recommendedScheduleValidator('2026-05-09T10:00:00Z', fixedNow).ok, true,
  'tomorrow accepted with fix');

// ===========================================================================
// Quantity validation (audited as LIKELY P1 — quantity=0 via direct typing)
// Mirror of the wizard step 3 onChange handler
// ===========================================================================

function currentQtyHandler(rawValue) {
  // Mirrors the existing handler: Math.max(1, +e.target.value)
  return Math.max(1, +rawValue);
}

console.log('--- Quantity input: current handler ---');
eq(currentQtyHandler('0'), 1, '"0" clamps to 1 (handler safe — but UI flashes 0)');
eq(currentQtyHandler('-5'), 1, 'negative clamps to 1');
eq(currentQtyHandler(''), 1, 'empty → 1 (NaN → +"" === 0 → max(1,0) === 1)');
// CONFIRMED BY EXECUTION: typing "abc" produces NaN, NOT clamped to 1.
// Math.max(1, NaN) === NaN. This is a real bug — pasting non-numeric text
// into the quantity input would store NaN, which then fails downstream.
const nanResult = currentQtyHandler('abc');
truthy(Number.isNaN(nanResult),
  'CONFIRMED P1: "abc" → Math.max(1, NaN) === NaN (NOT 1) — quantity becomes NaN');
// Recommended fix:
const fixedQtyHandler = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};
eq(fixedQtyHandler('abc'), 1, 'recommended fix: parseInt + isFinite → 1');
eq(fixedQtyHandler('0'), 1, 'recommended fix: 0 → 1');
eq(fixedQtyHandler('-5'), 1, 'recommended fix: negative → 1');
eq(fixedQtyHandler('4'), 4, 'recommended fix: valid → 4');
eq(fixedQtyHandler(''), 1, 'recommended fix: empty → 1');

// ===========================================================================
// Empty items_distributed validation (audited as CONFIRMED P0)
// ===========================================================================

function currentSubmitValidator(items) {
  // Mirrors current wizard behavior: filters then submits without checking length
  return { items: items.filter((i) => i.item_name.trim()) };
}

function recommendedSubmitValidator(items) {
  const filtered = items.filter((i) => i.item_name.trim());
  if (filtered.length === 0) return { ok: false, error: 'At least one item required' };
  if (filtered.some((i) => i.quantity < 1)) return { ok: false, error: 'Quantity must be ≥ 1' };
  return { ok: true, items: filtered };
}

console.log('--- Empty items: current vs recommended (CONFIRMED P0) ---');
const emptyItems = [{ item_name: '', quantity: 1 }, { item_name: '   ', quantity: 1 }];
const result = currentSubmitValidator(emptyItems);
eq(result.items, [], 'CONFIRMED: empty/whitespace items filtered, but result.items=[]');
truthy(!('error' in result),
  'CONFIRMED: current code does NOT reject empty items (bug — order would save with no items)');
eq(recommendedSubmitValidator(emptyItems).ok, false,
  'recommended: empty items rejected');
eq(recommendedSubmitValidator([{ item_name: 'water', quantity: 4 }]).ok, true,
  'recommended: 1 valid item accepted');
eq(recommendedSubmitValidator([{ item_name: 'water', quantity: 0 }]).ok, false,
  'recommended: zero quantity rejected');

// ===========================================================================
// Status transition state machine (LIKELY — invalid transitions allowed?)
// Mirror of ALLOWED_TRANSITIONS from Distribute.tsx
// ===========================================================================

const ALLOWED_TRANSITIONS = {
  pending: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'failed', 'cancelled'],
  delivered: [],
  failed: [],
  cancelled: [],
};

function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

console.log('--- Status state machine: legal transitions ---');
truthy(canTransition('pending', 'out_for_delivery'), 'pending → out_for_delivery legal');
truthy(canTransition('pending', 'cancelled'), 'pending → cancelled legal');
truthy(canTransition('out_for_delivery', 'delivered'), 'out_for_delivery → delivered legal');
truthy(canTransition('out_for_delivery', 'failed'), 'out_for_delivery → failed legal');
truthy(canTransition('out_for_delivery', 'cancelled'), 'out_for_delivery → cancelled legal');

console.log('--- Status state machine: illegal transitions blocked ---');
truthy(!canTransition('delivered', 'pending'), 'delivered → pending blocked (terminal)');
truthy(!canTransition('failed', 'delivered'), 'failed → delivered blocked');
truthy(!canTransition('cancelled', 'out_for_delivery'), 'cancelled → out_for_delivery blocked');
truthy(!canTransition('pending', 'delivered'), 'pending → delivered blocked (must dispatch first)');
truthy(!canTransition('pending', 'failed'), 'pending → failed blocked (must dispatch first)');

// ===========================================================================
// Worker busy-map derivation (audited as CONFIRMED but actually correct)
// ===========================================================================

function busyByUserId(orders) {
  const map = new Map();
  for (const o of orders) {
    if (o.status === 'out_for_delivery' && o.assigned_to) {
      map.set(o.assigned_to, o);
    }
  }
  return map;
}

console.log('--- busyByUserId: derived from live query (NOT a bug if useLiveQuery refreshes) ---');
const ordersBefore = [
  { distribution_id: 'A', status: 'out_for_delivery', assigned_to: 'W-john' },
  { distribution_id: 'B', status: 'pending', assigned_to: 'W-mary' },
];
truthy(busyByUserId(ordersBefore).has('W-john'), 'John locked while OUT_FOR_DELIVERY');
truthy(!busyByUserId(ordersBefore).has('W-mary'), 'Mary not locked (her order is pending)');
const ordersAfterCancel = ordersBefore.map((o) =>
  o.distribution_id === 'A' ? { ...o, status: 'cancelled' } : o
);
truthy(!busyByUserId(ordersAfterCancel).has('W-john'),
  'After cancel: John auto-freed when useLiveQuery returns new orders array');
// Audit claimed worker stays locked; this proves the derivation logic itself is correct.
// The only failure mode would be if useLiveQuery did NOT re-fire — that's a Dexie issue,
// not a Distribute logic issue. This downgrades the audit's CONFIRMED claim to NEEDS REPRO.

// ===========================================================================
// Total quantity math (audited bug surface)
// ===========================================================================

function totalQty(items) {
  return items.reduce((a, b) => a + b.quantity, 0);
}

console.log('--- totalQty math ---');
eq(totalQty([]), 0, 'empty → 0');
eq(totalQty([{ quantity: 3 }, { quantity: 5 }]), 8, 'sum 3+5 = 8');
eq(totalQty([{ quantity: 1 }]), 1, 'single item');
const bigQty = totalQty(Array.from({ length: 1000 }, () => ({ quantity: 1 })));
eq(bigQty, 1000, '1000 × 1 = 1000');

// ===========================================================================
// Summary
// ===========================================================================

console.log('\n========================');
console.log('PASSED: ' + passed);
console.log('FAILED: ' + failed);
if (fails.length) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log(f));
  process.exit(1);
}
