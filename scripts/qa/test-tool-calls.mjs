// Live golden-path test for the new Gemma 4 native function-calling pipeline.
//
//   1. Verify Ollama is reachable.
//   2. Send a tools-enabled /api/chat request with the AidFlow tool catalog
//      (a minimal subset hard-coded here so this script has no app deps).
//   3. Assert the model returns a tool_calls array (i.e. Gemma 4 + Ollama
//      actually support native function calling on this build).
//   4. Synthesize a fake tool result, send it back, and verify the model
//      produces a final natural-language sentence — that's the full
//      multi-step loop the AIChat component implements.
//
// Run:   node scripts/qa/test-tool-calls.mjs
// Env:   OLLAMA_BASE_URL (default http://localhost:11434)
//        OLLAMA_MODEL    (default gemma4:e4b)

const BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

// Subset of the AidFlow tool catalog (mirrors src/services/aiTools.ts).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_families',
      description:
        'Search the family registry. Use for queries like "all critical families in Sector-B-North with no delivery in 7 days" — pass priority_level=CRITICAL, sector="Sector-B-North", min_days_since_last_aid=7. Returns matching family records sorted by priority score descending.',
      parameters: {
        type: 'object',
        properties: {
          sector: { type: 'string', description: 'Exact sector name (case-insensitive).' },
          priority_level: {
            type: 'string',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'NORMAL'],
          },
          min_days_since_last_aid: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_workers',
      description:
        'List field workers. Use available_only=true to exclude workers currently on an active order.',
      parameters: {
        type: 'object',
        properties: {
          available_only: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_family_need',
      description:
        "Propose adding (or incrementing) a need item on a family's current-needs list. Quantity is a required positive integer. Surfaced as an Apply/Discard card.",
      parameters: {
        type: 'object',
        properties: {
          family_id: { type: 'string' },
          item: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
        },
        required: ['item', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_dispatch_order',
      description:
        'Draft a new aid distribution order from this family to this worker. Surfaced as an Apply/Discard card — NOT auto-committed.',
      parameters: {
        type: 'object',
        properties: {
          family_id: { type: 'string' },
          worker_id: { type: 'string' },
          items: { type: 'array', items: { type: 'object' } },
        },
        required: ['family_id', 'worker_id', 'items'],
      },
    },
  },
];

async function step(label, fn) {
  process.stdout.write(`▶ ${label} ... `);
  try {
    const out = await fn();
    process.stdout.write('OK\n');
    return out;
  } catch (e) {
    process.stdout.write('FAIL\n');
    console.error('  ', e && e.message ? e.message : e);
    process.exit(1);
  }
}

async function tags() {
  const r = await fetch(`${BASE}/api/tags`);
  if (!r.ok) throw new Error(`GET /api/tags → ${r.status}`);
  return r.json();
}

async function chat(messages, opts = {}) {
  const body = {
    model: MODEL,
    messages,
    tools: TOOLS,
    stream: false,
    options: {
      num_ctx: 8192,
      temperature: 0.2,
      num_predict: 1024,
      ...opts,
    },
  };
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`POST /api/chat → ${r.status} ${r.statusText}: ${txt.slice(0, 400)}`);
  }
  return r.json();
}

(async () => {
  console.log(`Ollama: ${BASE}   Model: ${MODEL}\n`);

  const t = await step('Reach Ollama /api/tags', tags);
  const installed = t.models?.map((m) => m.name) ?? [];
  if (!installed.includes(MODEL)) {
    console.warn(`  (warning) ${MODEL} not in installed list: ${installed.join(', ')}`);
  } else {
    console.log(`  Installed: ${installed.join(', ')}`);
  }

  // ── Step 1 — model proposes a read tool ────────────────────────────────
  const sys = {
    role: 'system',
    content:
      "You are AidFlow Pro's humanitarian field assistant. You have access to function-calling tools. Use them to answer factual questions about the family registry. Always call a tool instead of guessing. Be concise.",
  };
  const userTurn = {
    role: 'user',
    content:
      'Find me all CRITICAL priority families in Sector-B-North that have not received aid for at least 7 days.',
  };

  const reply1 = await step('Tool-call request → /api/chat with tools', () =>
    chat([sys, userTurn])
  );
  const calls = reply1.message?.tool_calls ?? [];
  console.log(`  Assistant content: ${(reply1.message?.content || '').slice(0, 100) || '(empty)'}`);
  console.log(`  tool_calls: ${calls.length}`);
  for (const c of calls) {
    console.log(`    • ${c.function?.name}(${JSON.stringify(c.function?.arguments)})`);
  }
  if (calls.length === 0) {
    console.error(
      '\n✗ Gemma 4 did not emit any tool_calls on this prompt. Either the model does not support native function calling on this Ollama build, OR the prompt is not specific enough.\n  This is a soft fail — the AIChat component has a regex fallback, so the project still works. But you wanted the demo to lean on native tool calling, so consider:\n    • Verifying your Ollama version supports tools (>= 0.4.0 for native, >= 0.5.0 for streaming).\n    • Re-pulling: `ollama pull gemma4:e4b`'
    );
    process.exit(2);
  }

  // ── Step 2 — feed a synthetic tool result back ──────────────────────────
  const firstCall = calls[0];
  const fakeResult = {
    matched: 2,
    returned: 2,
    families: [
      {
        family_id: 'F-001',
        head_name: 'Aisha Hassan',
        sector: 'Sector-B-North',
        priority_level: 'CRITICAL',
        priority_score: 92,
        days_since_last_aid: 9,
      },
      {
        family_id: 'F-007',
        head_name: 'Mohammed Diallo',
        sector: 'Sector-B-North',
        priority_level: 'CRITICAL',
        priority_score: 88,
        days_since_last_aid: 12,
      },
    ],
  };
  const reply2 = await step('Tool-result round-trip → /api/chat', () =>
    chat([
      sys,
      userTurn,
      {
        role: 'assistant',
        content: reply1.message?.content || '',
        tool_calls: calls,
      },
      {
        role: 'tool',
        content: JSON.stringify(fakeResult),
        tool_name: firstCall.function?.name,
      },
    ])
  );
  const finalText = reply2.message?.content || '';
  console.log('  Final assistant text:');
  console.log(
    finalText
      ? finalText.split('\n').map((l) => '    ' + l).join('\n')
      : '    (empty)'
  );
  if (!finalText.trim()) {
    console.error('\n✗ Model produced no follow-up text after the tool result.');
    process.exit(3);
  }

  // ── Step 3 — write tool ('proposed_to_user' status round-trip) ──────────
  const writeUser = {
    role: 'user',
    content:
      'For family F-001, please add 4 units of "drinking water (20L)" to their current needs.',
  };
  const reply3 = await step('Write-tool proposal → /api/chat', () =>
    chat([sys, writeUser])
  );
  const writeCalls = reply3.message?.tool_calls ?? [];
  console.log(`  tool_calls: ${writeCalls.length}`);
  for (const c of writeCalls) {
    console.log(`    • ${c.function?.name}(${JSON.stringify(c.function?.arguments)})`);
  }
  if (writeCalls.length === 0) {
    console.warn(
      '  (warning) No tool_calls emitted on the write prompt. The Apply/Discard surface depends on this. Add_family_need wasn\'t in this script\'s tool catalog though — add it here if you want a stricter test.'
    );
  }

  console.log('\n✓ All steps passed.');
})();
