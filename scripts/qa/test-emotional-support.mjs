// QA regression suite for the emotional-support content generator.
// Tests pure logic: title parser, UTF-8 base64 round-trip, data-URL
// decoder. Plus invariants on the source file (offline guarantees,
// trauma-informed prompt rules, AI call routed through chat()).
//
// Run with: node scripts/qa/test-emotional-support.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => {
  try { return readFileSync(resolve(root, p), 'utf8'); } catch { return ''; }
};

const genSrc = read('src/services/emotionalSupportGen.ts');
const modalSrc = read('src/components/EmotionalSupportGenModal.tsx');
const kidsPageSrc = read('src/pages/KidsContent.tsx');

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); failed++; };
const ok = (msg) => { console.log(`PASS: ${msg}`); passed++; };
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));
const expectEq = (actual, expected, msg) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(msg);
  else { fail(`${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
};

// =========================================================================
// 1. Source invariants — offline + trauma-informed prompts
// =========================================================================

console.log('\n--- Source invariants ---\n');

expect(
  /from\s+['"]@\/services\/ollama['"]/.test(genSrc) &&
    /\bchatStream\b/.test(genSrc) &&
    /\bpingOllama\b/.test(genSrc),
  'service routes AI calls through ollama (chatStream + pingOllama)'
);

expect(
  !/^[^/]*fetch\(/m.test(genSrc.replace(/\/\/[^\n]*/g, '')),
  'no bare fetch() in emotionalSupportGen.ts (offline-only via chat helper)'
);

expect(
  /TRAUMA-INFORMED CARE PRINCIPLES/.test(genSrc) &&
    /Validate feelings/i.test(genSrc) &&
    /never dismiss them/i.test(genSrc),
  'system prompt encodes trauma-informed care rubric'
);

expect(
  /Avoid graphic depictions/i.test(genSrc) &&
    /culturally and politically neutral/i.test(genSrc),
  'system prompt forbids graphic content + politically neutral'
);

expect(
  /AI-assisted draft/.test(modalSrc) &&
    /Review for cultural fit/.test(modalSrc),
  'modal shows always-visible review-before-use disclaimer'
);

expect(
  /document\.body\.style\.overflow\s*=\s*['"]hidden['"]/.test(modalSrc) &&
    /['"]Escape['"]/.test(modalSrc) &&
    /addEventListener\(\s*['"]keydown['"]/.test(modalSrc),
  'modal a11y: scroll lock + Escape handler'
);

expect(
  /EmotionalSupportGenModal/.test(kidsPageSrc) &&
    /setGenOpen\(true\)/.test(kidsPageSrc),
  'KidsContent page wires the EmotionalSupportGenModal'
);

expect(
  /decodeDataUrlText/.test(kidsPageSrc),
  'KidsContent uses UTF-8-safe data-URL decoder for stories'
);

// =========================================================================
// 2. Pure-logic — title parser
// =========================================================================

console.log('\n--- Title parser ---\n');

// Re-implement the parser inline (mirror of parseGeneratedContent in the
// real service). If you change the service version, update this too.
function parseGeneratedContent(buffer, fallbackTitle) {
  const trimmed = buffer.trim();
  const earlyLines = trimmed.split('\n').slice(0, 3).join('\n');
  const titleMatch = earlyLines.match(/^#\s+(.+?)\s*$/m);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    const body = trimmed.replace(/^#\s+.+?\s*$/m, '').trim();
    return { title: title || fallbackTitle, body };
  }
  return { title: fallbackTitle, body: trimmed };
}

{
  const r = parseGeneratedContent('# The Brave Little Lion\n\nOnce upon a time…', 'fallback');
  expectEq(r.title, 'The Brave Little Lion', 'parser: extracts H1 title');
  expectEq(r.body, 'Once upon a time…', 'parser: removes the H1 line from body');
}

{
  const r = parseGeneratedContent('Once upon a time, with no title.', 'Story — fear');
  expectEq(r.title, 'Story — fear', 'parser: falls back to provided fallback when H1 missing');
  expectEq(r.body, 'Once upon a time, with no title.', 'parser: keeps body intact when H1 missing');
}

{
  const r = parseGeneratedContent('\n\n# Leading Blank Lines\n\nbody', 'fb');
  expectEq(r.title, 'Leading Blank Lines', 'parser: H1 still found after leading blank lines');
}

{
  // Title-like text past the first 3 lines should NOT be treated as the title.
  const r = parseGeneratedContent('paragraph one\n\nparagraph two\n\n# This is in the body, not a title', 'fb');
  expectEq(r.title, 'fb', 'parser: ignores "#" past the early-lines window');
}

{
  // Defend against an empty buffer (e.g. Ollama returned nothing).
  const r = parseGeneratedContent('', 'Default');
  expectEq(r.title, 'Default', 'parser: empty buffer → fallback');
  expectEq(r.body, '', 'parser: empty buffer → empty body');
}

// =========================================================================
// 3. UTF-8 base64 round-trip — Arabic / French / Spanish must survive
// =========================================================================

console.log('\n--- UTF-8 round-trip ---\n');

// Inline mirror of the helpers in the service. Keep in lockstep.
function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return Buffer.from(bin, 'binary').toString('base64');
}
function base64ToUtf8(s) {
  const binary = Buffer.from(s, 'base64').toString('binary');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function decodeDataUrlText(dataUrl) {
  if (!dataUrl) return '';
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return '';
  const meta = dataUrl.slice(5, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const isBase64 = /;\s*base64\s*$/.test(meta);
  if (isBase64) return base64ToUtf8(payload);
  try { return decodeURIComponent(payload); } catch { return payload; }
}

const samples = [
  'Hello world',
  'الأطفال الصغار شجعان', // Arabic
  'Le petit lion courageux', // French
  'El niño valiente — está bien sentirse así.', // Spanish with em-dash
  '😊 emoji test 🌈', // emoji
  '# Title\n\nWith **markdown** _and_ [links](https://example.com)',
];

for (const s of samples) {
  const round = base64ToUtf8(utf8ToBase64(s));
  expectEq(round, s, `round-trip: ${JSON.stringify(s.slice(0, 40))}…`);
}

// data-URL decoder
{
  const md = '# Hola\n\nEsto es **importante**.';
  const dataUrl = `data:text/markdown;charset=utf-8;base64,${utf8ToBase64(md)}`;
  expectEq(decodeDataUrlText(dataUrl), md, 'decoder: base64 markdown data URL → original');
}
{
  const md = '# Bonjour';
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`;
  expectEq(decodeDataUrlText(dataUrl), md, 'decoder: percent-encoded data URL → original');
}
{
  expectEq(decodeDataUrlText(''), '', 'decoder: empty input → empty');
  expectEq(decodeDataUrlText('not-a-data-url'), '', 'decoder: malformed input → empty');
}

// =========================================================================
// 4. Locale parity — every locale has the new kids_gen block
// =========================================================================

console.log('\n--- Locale parity ---\n');

for (const lang of ['en', 'ar', 'fr', 'es']) {
  let parsed;
  try { parsed = JSON.parse(read(`src/locales/${lang}.json`)); }
  catch (e) { fail(`${lang}.json parse: ${e.message}`); continue; }
  expect(parsed.kids_gen, `locales/${lang}.json has the kids_gen block`);
  expect(parsed.kids_gen?.title, `locales/${lang}.json has kids_gen.title`);
  expect(parsed.kids_gen?.disclaimer, `locales/${lang}.json has kids_gen.disclaimer`);
  expect(parsed.kids_gen?.generate, `locales/${lang}.json has kids_gen.generate`);
  expect(parsed.kids?.generate, `locales/${lang}.json has kids.generate (Generate button label)`);
}

// =========================================================================
// Summary
// =========================================================================

console.log(`\n--- ${passed + failed} tests, ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
process.exit(0);
