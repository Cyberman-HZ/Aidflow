#!/usr/bin/env node
// Family-profile QA tests — coverage for the bug-fix patches.
// Run: node scripts/qa/test-family-profile-fixes.mjs

let passed = 0;
let failed = 0;
const fails = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; fails.push("  " + label + "\n    expected " + e + "\n    got      " + a); }
}
function truthy(v, label) {
  if (v) passed++;
  else { failed++; fails.push("  " + label + " (got " + JSON.stringify(v) + ")"); }
}

// ---------- Mirror of findItem after the precedence fix ----------
function findItem(family, query) {
  const items = family.recommended_items ?? [];
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const exact = items.find((i) => i.name.toLowerCase() === q);
  if (exact) return exact;
  const TOKEN_SPLIT = new RegExp("[\\s/.\\-_]+");
  const tokenMatch = items.find((i) => i.name.toLowerCase().split(TOKEN_SPLIT).includes(q));
  if (tokenMatch) return tokenMatch;
  const subs = items
    .filter((i) => i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase()))
    .sort((a, b) => a.name.length - b.name.length);
  return subs[0] ?? null;
}

console.log('--- findItem precedence after Likely Bug #3 fix ---');
{
  const f3 = {
    recommended_items: [
      { name: 'infant', quantity: 2 },
      { name: 'infant formula', quantity: 1 },
      { name: 'baby formula', quantity: 1 },
    ],
  };
  eq(findItem(f3, 'infant').name, 'infant',
    'exact match wins over substring');
  eq(findItem(f3, 'INFANT').name, 'infant',
    'case-insensitive exact match');
  truthy(['baby formula', 'infant formula'].includes(findItem(f3, 'formula').name),
    'token-boundary match');
  eq(findItem(f3, 'milk'), null, 'no match returns null');
}

// ---------- parseFamilyActionsDetailed mirror (Bug #6 fix) ----------
const ACTION_BLOCK_RE = /```([a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```/g;
const INLINE_ACTION_RE = /\{[^{}]*"type"\s*:\s*"(?:set_field|add_recommended_item|remove_recommended_item|set_recommended_items|add_medical_condition|remove_medical_condition|set_medical_conditions)"[^{}]*\}/g;
const TYPE_DETECT = /"type"\s*:\s*"[a-z_]+"/;
const TRAILING_COMMA = /,(\s*[\]}])/g;
const NUM_FILTER = new RegExp("[^0-9.\\-]", "g");
const ALLOWED_FIELDS = ['head_name','location_sector','member_count','children_under_5','elderly_count','has_pregnant_member','displacement_status','income_level','street','city','notes'];

function validateFamilyAction(j) {
  if (!j || typeof j !== 'object' || typeof j.type !== 'string') return null;
  switch (j.type) {
    case 'set_field': {
      if (!ALLOWED_FIELDS.includes(j.field)) return null;
      return { type: 'set_field', field: j.field, value: j.value };
    }
    case 'add_recommended_item': {
      if (typeof j.item !== 'string' || !j.item.trim()) return null;
      const qNum = typeof j.quantity === 'number' ? j.quantity : Number(String(j.quantity ?? '').replace(NUM_FILTER, ''));
      const q = Number.isFinite(qNum) && qNum >= 1 ? Math.floor(qNum) : 1;
      return { type: 'add_recommended_item', item: j.item.trim(), quantity: q };
    }
    case 'remove_recommended_item': {
      if (typeof j.item !== 'string' || !j.item.trim()) return null;
      let q;
      if (j.quantity !== undefined && j.quantity !== null) {
        const qNum = typeof j.quantity === 'number' ? j.quantity : Number(String(j.quantity).replace(NUM_FILTER, ''));
        if (Number.isFinite(qNum) && qNum >= 1) q = Math.floor(qNum);
      }
      return q !== undefined ? { type: 'remove_recommended_item', item: j.item.trim(), quantity: q } : { type: 'remove_recommended_item', item: j.item.trim() };
    }
    default: return null;
  }
}
function tryParseAction(raw) {
  const cleaned = raw.replace(TRAILING_COMMA, '$1').trim();
  if (!cleaned) return null;
  try { return validateFamilyAction(JSON.parse(cleaned)); } catch { return null; }
}
function parseFamilyActionsDetailed(text) {
  const out = [];
  let failedCandidates = 0;
  ACTION_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = ACTION_BLOCK_RE.exec(text))) {
    const tag = (m[1] || '').toLowerCase();
    if (tag && tag !== 'aidflow-action' && tag !== 'json' && tag !== '') continue;
    const raw = m[2].trim();
    const looksLikeAction = TYPE_DETECT.test(raw);
    const a = tryParseAction(m[2]);
    if (a) out.push(a);
    else if (looksLikeAction) failedCandidates++;
  }
  if (out.length > 0) return { actions: out, failedCandidates };
  INLINE_ACTION_RE.lastIndex = 0;
  while ((m = INLINE_ACTION_RE.exec(text))) {
    const a = tryParseAction(m[0]);
    if (a) out.push(a);
    else failedCandidates++;
  }
  return { actions: out, failedCandidates };
}

const fence = '`'+'`'+'`';
console.log('--- parseFamilyActionsDetailed (Bug #6 fix) ---');
{
  let r = parseFamilyActionsDetailed(fence + 'aidflow-action\n{not json}\n' + fence);
  eq(r.actions, [], 'malformed: no actions');
  eq(r.failedCandidates, 0, 'malformed without "type" not counted');
  r = parseFamilyActionsDetailed(fence + 'aidflow-action\n{"type":"add_recommended_item","item":"","quantity":4}\n' + fence);
  eq(r.actions, [], 'empty item: rejected');
  truthy(r.failedCandidates >= 1, 'empty item counted as failed');
  r = parseFamilyActionsDetailed(fence + 'aidflow-action\n{"type":"unknown_type","x":1}\n' + fence);
  eq(r.actions, [], 'unknown type rejected');
  truthy(r.failedCandidates >= 1, 'unknown type counted as failed');
  r = parseFamilyActionsDetailed(fence + 'aidflow-action\n{"type":"add_recommended_item","item":"water","quantity":4}\n' + fence);
  eq(r.actions.length, 1, 'good action parsed');
  eq(r.failedCandidates, 0, 'good action: no failures');
}

// ---------- friendlyApplyError mirror (Bug #3 fix) ----------
function friendlyApplyError(raw, action) {
  if (action.type === 'set_field' && action.field === 'location_sector' && /not an existing sector/i.test(raw)) {
    const m = raw.match(/Pick one of: (.+)$/);
    return "Sorry — that sector doesn't exist yet. Pick one that's already in use: " + (m ? m[1] : '(no sectors yet)') + '.';
  }
  if (/not found/i.test(raw)) return 'The family record could not be loaded. Try refreshing the page.';
  if (/Cannot remove/i.test(raw)) return raw;
  if (/QuotaExceeded|InvalidState|Aborted|NotFoundError/i.test(raw)) {
    return 'Could not save the change to the local database. Free up storage space and try again.';
  }
  return 'Could not apply this change. ' + raw;
}

console.log('--- friendlyApplyError (Bug #3 fix) ---');
{
  const sectorAction = { type: 'set_field', field: 'location_sector', value: 'X' };
  truthy(friendlyApplyError('"X" is not an existing sector. Pick one of: Sector-A, Sector-B', sectorAction).startsWith('Sorry'),
    'sector error → user-friendly');
  truthy(friendlyApplyError("Cannot remove 'water' — not in needs", { type: 'remove_recommended_item', item: 'water' }).includes('Cannot remove'),
    'cannot-remove error passed through');
  truthy(friendlyApplyError('QuotaExceededError: db is full', sectorAction).includes('storage'),
    'quota error → mentions storage');
  truthy(friendlyApplyError('Family Z not found', sectorAction).includes('refreshing'),
    'not-found → suggests refresh');
}

// ---------- CurrentNeedsCard input validation (Bugs #1 + #2 fix) ----------
console.log('--- CurrentNeedsCard input validation (Bugs #1 + #2 fix) ---');
function validateAddInput(name, qty) {
  const n = String(name).trim();
  if (!n) return { ok: false, error: 'Item name is required' };
  if (!Number.isFinite(qty) || qty < 1) return { ok: false, error: 'Quantity must be 1 or more' };
  return { ok: true, name: n, quantity: Math.max(1, Math.floor(qty)) };
}
eq(validateAddInput('   ', 1), { ok: false, error: 'Item name is required' }, 'whitespace-only name rejected');
eq(validateAddInput('', 1), { ok: false, error: 'Item name is required' }, 'empty name rejected');
eq(validateAddInput('water', -5), { ok: false, error: 'Quantity must be 1 or more' }, 'negative qty rejected');
eq(validateAddInput('water', 0), { ok: false, error: 'Quantity must be 1 or more' }, 'zero qty rejected');
eq(validateAddInput('water', NaN), { ok: false, error: 'Quantity must be 1 or more' }, 'NaN qty rejected');
eq(validateAddInput('  water  ', 4), { ok: true, name: 'water', quantity: 4 }, 'valid input passes after trim');

// ---------- Double-Apply guard (Likely Bug #1 fix) ----------
console.log('--- double-apply guard (Likely Bug #1 fix) ---');
function shouldIgnoreApplyClick(s) {
  return s === 'applying' || s === 'applied' || s === 'discarded';
}
truthy(shouldIgnoreApplyClick('applying'), 'second click while applying → ignored');
truthy(shouldIgnoreApplyClick('applied'), 'click after applied → ignored');
truthy(shouldIgnoreApplyClick('discarded'), 'click after discarded → ignored');
truthy(!shouldIgnoreApplyClick('pending'), 'first click while pending → allowed');
truthy(!shouldIgnoreApplyClick('failed'), 'click after failed → retry allowed');

// ---------- save() error mapping (Bug #5 fix) ----------
console.log('--- save() error mapping (Bug #5 fix) ---');
function mapSaveError(raw) {
  if (/QuotaExceeded/i.test(raw)) return 'Could not save — your device is out of storage. Free up some space and try again.';
  if (/InvalidState|Aborted|NotFound/i.test(raw)) return 'Could not save — the database is in an unexpected state. Try refreshing the page.';
  return 'Could not save the changes. ' + raw;
}
truthy(mapSaveError('QuotaExceededError').includes('out of storage'), 'quota → storage message');
truthy(mapSaveError('InvalidStateError').includes('database is in an unexpected state'), 'invalid state → DB message');
truthy(mapSaveError('Random error').includes('Random error'), 'unknown error → falls through');

console.log('\n========================');
console.log('PASSED: ' + passed);
console.log('FAILED: ' + failed);
if (fails.length) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log(f));
  process.exit(1);
}
