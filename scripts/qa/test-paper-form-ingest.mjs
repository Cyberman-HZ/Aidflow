// Smoke test for the paper-form ingest pipeline.
//
//   1. Confirms the configured Ollama model accepts an `images: [...]`
//      payload — i.e. is vision-capable on this Ollama build.
//   2. Round-trips the exact prompt + schema the production code uses.
//   3. Prints whatever the model returns so a human can sanity-check.
//
// This is a *capability* test, not a correctness test. The image we ship
// is a 1×1 blank JPEG — Gemma should respond with `{"families":[],
// "image_warnings":["..."]}` or similar. If it returns plain prose or
// fabricates families, the model is not following the JSON contract and
// the production feature will degrade to manual entry.
//
// Run:   node scripts/qa/test-paper-form-ingest.mjs
// Env:   OLLAMA_BASE_URL (default http://localhost:11434)
//        OLLAMA_MODEL    (default gemma4:e4b)

const BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

import { readFileSync } from 'node:fs';

// Read public/logo.png and ship that as the test image. It's a real PNG,
// so it exercises the actual decode path on the vision backend.
const IMAGE_B64 = readFileSync(new URL('../../public/logo.png', import.meta.url)).toString('base64');

const SYSTEM_PROMPT = `You are AidFlow Pro's paper-form ingestion vision model. You will be given an image. Output ONLY valid JSON with the shape:
{ "image_warnings": [string], "families": [ { "head_name": string, "member_count": int, "confidence": "high"|"medium"|"low" } ] }
If the image contains no family registration data (blank, unreadable, etc.), return { "image_warnings": ["..."], "families": [] }.`;

const USER_PROMPT =
  'Extract every family row visible on the attached photo. Return JSON only — no prose, no markdown.';

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

async function chatWithImage(messages, imagesBase64) {
  const conv = messages.map((m) => ({ role: m.role, content: m.content }));
  // Attach images to the last user turn (Ollama's contract).
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i].role === 'user') {
      conv[i].images = imagesBase64;
      break;
    }
  }
  const body = {
    model: MODEL,
    messages: conv,
    stream: false,
    format: 'json',
    options: { num_ctx: 8192, temperature: 0.1, num_predict: 1024 },
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
  const installed = (t.models ?? []).map((m) => m.name);
  if (!installed.includes(MODEL)) {
    console.warn(`  (warning) ${MODEL} not installed. Found: ${installed.join(', ')}`);
  }

  console.log(`  Image size: ${(IMAGE_B64.length / 1024).toFixed(1)} KB base64`);

  const reply = await step('Multimodal /api/chat (public/logo.png)', () =>
    chatWithImage(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT },
      ],
      [IMAGE_B64]
    )
  );

  const raw = reply.message?.content ?? '';
  console.log('  Raw assistant content:');
  console.log(
    raw
      ? raw.split('\n').map((l) => '    ' + l).join('\n')
      : '    (empty)'
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('\n✗ Model did not return valid JSON.');
    console.error('  This means either:');
    console.error('   (a) the model variant does not support vision, or');
    console.error('   (b) the model ignored the JSON-mode constraint.');
    console.error(
      '  In production AidFlow Pro will show the "extraction failed" path and let the admin retry.'
    );
    process.exit(2);
  }

  if (!('families' in parsed)) {
    console.error('\n✗ Response did not include a "families" key.');
    console.error('  Got:', JSON.stringify(parsed).slice(0, 400));
    process.exit(3);
  }

  const n = Array.isArray(parsed.families) ? parsed.families.length : 0;
  console.log(`\n✓ Model returned valid JSON with families[] (length=${n}).`);
  if (n > 0) {
    console.warn(
      '  (heads up) Model hallucinated families from a blank 1×1 image. Production prompt'
    );
    console.warn(
      '  is stricter about this — but if it happens on real photos too, low-confidence rows'
    );
    console.warn('  will get flagged in the review UI.');
  }
})();
