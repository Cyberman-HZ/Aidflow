// AidFlow Pro — static contract test for the AI trace feature.
//
// This script does NOT need a running Ollama or a browser. It loads the
// type-bearing source files as plain text and asserts:
//
//   1. The AiTrace TypeScript interface declares every field the UI
//      depends on. If someone trims a field, this fails loudly.
//   2. The v10 Dexie migration registers the aiTraces table.
//   3. The aiTrace service exports the public API the components import.
//   4. Every callsite that records a trace passes a valid `source` value
//      drawn from the AiTraceSource union.
//   5. The TraceButton component renders ONLY when a traceId is provided
//      (offline-safe; old chat messages without traces don't crash).
//
// Run:   node scripts/qa/test-trace-shape.mjs
//
// Exit codes: 0 = all pass · 1 = at least one assertion failed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function ok(label) {
  pass++;
  console.log(`  ✓ ${label}`);
}

function bad(label, detail) {
  fail++;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function assert(cond, label, detail) {
  if (cond) ok(label);
  else bad(label, detail);
}

function header(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. AiTrace interface declares every required field
// ---------------------------------------------------------------------------

header('1. AiTrace interface contract');

const types = read('src/types/index.ts');

const required = [
  'trace_id',
  'source',
  'created_at',
  'language',
  'model',
  'inputs_summary',
];
const optional = [
  'duration_ms',
  'system_prompt',
  'user_input',
  'tool_reads',
  'tool_writes',
  'citations',
  'fallback_used',
  'fallback_reason',
  'response_text',
  'error',
  'metadata',
];

// Lift the AiTrace block out of the file so we don't false-match on
// references in other interfaces.
const traceBlockMatch = types.match(/export interface AiTrace \{([\s\S]*?)\n\}/);
assert(
  !!traceBlockMatch,
  'AiTrace interface declared in src/types/index.ts',
  'expected an `export interface AiTrace { ... }` block'
);
const traceBlock = traceBlockMatch ? traceBlockMatch[1] : '';

for (const f of required) {
  assert(
    new RegExp(`\\b${f}\\s*:`).test(traceBlock),
    `AiTrace.${f} declared`,
    `missing required field`
  );
}
for (const f of optional) {
  assert(
    new RegExp(`\\b${f}\\??\\s*:`).test(traceBlock),
    `AiTrace.${f} declared (optional)`,
    `missing optional field`
  );
}

// AiTraceSource union must include every value the UI filters on.
const sources = [
  'chat_tools',
  'chat_rag',
  'chat_plain',
  'family_chat_scoped',
  'dashboard_summary',
  'priority_rank',
  'paper_form',
  'spreadsheet_map',
  'kids_content',
];
for (const s of sources) {
  assert(
    new RegExp(`'${s}'`).test(types),
    `AiTraceSource includes '${s}'`,
    `missing union member`
  );
}

// AiTraceToolRead / AiTraceToolWrite / AiTraceCitation also exported.
for (const t of ['AiTraceToolRead', 'AiTraceToolWrite', 'AiTraceCitation']) {
  assert(
    new RegExp(`export interface ${t}`).test(types),
    `${t} interface exported`,
    `missing supporting interface`
  );
}

// ChatMessage carries an optional trace_id.
assert(
  /interface ChatMessage[\s\S]*?trace_id\??\s*:/.test(types),
  'ChatMessage.trace_id added',
  'AIChat needs this field to render the inline Trace button'
);

// ---------------------------------------------------------------------------
// 2. v10 migration registers the aiTraces table
// ---------------------------------------------------------------------------

header('2. Dexie v10 migration');

const dbSrc = read('src/db/database.ts');

assert(
  /this\.version\(10\)\.stores\(\{[\s\S]*aiTraces:\s*'id|trace_id, source, created_at/.test(dbSrc) ||
    /this\.version\(10\)\.stores\(\{[\s\S]*aiTraces:\s*'trace_id, source, created_at'/.test(dbSrc),
  'version(10) registers aiTraces with the expected index set',
  "expected `aiTraces: 'trace_id, source, created_at'`"
);
assert(
  /aiTraces!:\s*Table<AiTrace,\s*string>/.test(dbSrc),
  'aiTraces table is typed as Table<AiTrace, string>',
  'check the field declaration on AidFlowDB'
);
assert(
  /this\.aiTraces\.clear\(\)/.test(dbSrc),
  'clearAll() wipes the aiTraces table',
  'Reset demo data would otherwise leave stale traces'
);

// ---------------------------------------------------------------------------
// 3. Service public API matches what components import
// ---------------------------------------------------------------------------

header('3. aiTrace service surface');

const svc = read('src/services/aiTrace.ts');
const expectedExports = [
  'recordTrace',
  'getTrace',
  'listTraces',
  'deleteTrace',
  'clearAllTraces',
  'patchTrace',
  'purgeOlderThan',
  'sourceLabel',
  'exportTraceAsJson',
  'summarizeToolResult',
  'clip',
];
for (const fn of expectedExports) {
  assert(
    new RegExp(`export (?:async )?function ${fn}\\b`).test(svc) ||
      new RegExp(`export const ${fn}\\b`).test(svc),
    `aiTrace exports ${fn}()`,
    'consumers will fail to import otherwise'
  );
}

// recordTrace must NEVER throw — the catch-all is load-bearing.
assert(
  /async function recordTrace[\s\S]*?try \{[\s\S]*?await db\.aiTraces\.put[\s\S]*?\} catch/.test(svc),
  'recordTrace wraps the DB put in try/catch (never breaks the AI path)',
  'an audit-log failure must not propagate to the user'
);

// ---------------------------------------------------------------------------
// 4. Every recordTrace callsite uses a valid source
// ---------------------------------------------------------------------------

header('4. Callsite source values');

const callsites = [
  ['src/components/AIChat.tsx', ['chat_rag', 'chat_tools', 'chat_plain', 'family_chat_scoped']],
  ['src/pages/Dashboard.tsx', ['dashboard_summary']],
  ['src/pages/Families.tsx', ['priority_rank']],
  ['src/components/PaperFormImport.tsx', ['paper_form']],
];
for (const [file, expected] of callsites) {
  const code = read(file);
  assert(
    /recordTrace\s*\(/.test(code),
    `${file} calls recordTrace()`,
    'missing trace recording at this AI callsite'
  );
  for (const s of expected) {
    // Either a literal "source: 'foo'" OR the trailing leg of a ternary
    // "source: cond ? 'family_chat_scoped' : 'foo'". The trailing-leg form
    // is what AIChat uses to pick chat_tools/chat_plain when not scoped.
    // Match a literal `source: 'foo'` OR either leg of a ternary
    // `source: cond ? 'a' : 'b'` — the leading `?` or `:` followed
    // by whitespace and the quoted source string.
    const literal = new RegExp(`source:\\s*['"]${s}['"]`);
    const ternaryLeg = new RegExp(`[?:]\\s*['"]${s}['"]`);
    assert(
      literal.test(code) || ternaryLeg.test(code),
      `${file} uses source '${s}'`,
      'expected this trace source on this surface'
    );
  }
}

// ---------------------------------------------------------------------------
// 5. TraceButton renders only when traceId is provided
// ---------------------------------------------------------------------------

header('5. TraceButton safety');

const btn = read('src/components/TraceButton.tsx');
assert(
  /if \(!traceId\) return null;/.test(btn),
  'TraceButton returns null when traceId is undefined',
  'old chat messages without trace ids must not crash'
);
assert(
  /Escape/.test(btn),
  'TracePanel closes on Escape key',
  'keyboard accessibility'
);
assert(
  /aria-modal="true"/.test(btn),
  'TracePanel has aria-modal="true"',
  'screen-reader semantics'
);

// ---------------------------------------------------------------------------
// 6. /audit route is wired
// ---------------------------------------------------------------------------

header('6. /audit route + nav');

const appTsx = read('src/App.tsx');
assert(
  /Route path="\/audit" element=\{<AiAudit/.test(appTsx),
  '/audit route registered',
  'audit page would be unreachable'
);

const layoutTsx = read('src/components/Layout.tsx');
assert(
  /to: '\/audit'/.test(layoutTsx),
  'Sidebar nav links to /audit',
  'users would not find the audit log'
);

const enLocale = JSON.parse(read('src/locales/en.json'));
assert(
  typeof enLocale.nav?.audit === 'string' && enLocale.nav.audit.length > 0,
  'nav.audit string present in en.json',
  'sidebar label would render as the raw key'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass + fail} assertion(s) total — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
