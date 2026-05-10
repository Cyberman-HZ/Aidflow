// Emotional-support content generator
// =========================================================================
//
// Streams a trauma-informed piece of content (story, breathing exercise,
// journaling prompt, or coloring-page description) from Gemma 4. The admin
// reviews + edits in a preview panel and only saves to the library on
// confirm — same Apply/Discard discipline as the family-edit AI flow.
//
// Privacy / offline: every call goes only to local Ollama via the existing
// chat() helper. Nothing leaves the device.
//
// Safety: this is a tool for trained workers. The system prompt encodes a
// short trauma-informed-care rubric (validate feelings, no false
// reassurance, no graphic content) but it does NOT replace child-psychology
// expertise. The UI shows a clear "review before using" disclaimer.

import { chatStream, pingOllama } from '@/services/ollama';
import type { ChatMessage } from '@/types';

export type ContentFormat = 'story' | 'breathing' | 'journaling' | 'game';
export type AgeGroup = '5-7' | '8-11' | '12-15';
export type ContentLanguage = 'en' | 'ar' | 'fr' | 'es';

/** Built-in theme keys. The UI also accepts a free-text custom theme. */
export const THEME_KEYS = [
  'loss_of_home',
  'fear',
  'displacement',
  'separation',
  'returning_to_school',
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export interface GenerateOpts {
  format: ContentFormat;
  ageGroup: AgeGroup;
  /**
   * Either a ThemeKey (looked up against the human-readable label table
   * for prompt construction) or a free-text custom theme — passed through
   * verbatim if it doesn't match a known key.
   */
  theme: string;
  language: ContentLanguage;
  /** Optional situational context, e.g. "8-year-old who lost their dog in a flood". */
  situation?: string;
}

const FORMAT_INSTRUCTIONS: Record<ContentFormat, string> = {
  story: `STORY — 200-400 words. A short narrative with a relatable child or animal protagonist who experiences something connected to the theme. The story should:
- Acknowledge the hard feeling without minimizing it.
- Show small actions the protagonist takes (asking for help, finding a safe place, breathing slowly).
- End with a calm, hopeful resolution that does not promise everything will be perfect.
- Use markdown paragraphs (no headings inside the body).`,

  breathing: `BREATHING EXERCISE — a 100-200 word SCRIPT for a trusted adult to read aloud to a child. The script should:
- Open by acknowledging the child may feel scared, sad, or restless. Vary the opening line each time — do not always say "you may feel scared".
- Pick ONE imagery anchor from this list and develop it: candle, flower, balloon, soap bubble, butterfly, cloud, falling leaf, ocean wave, warm cup of cocoa, kite, tree branch in the wind, lighthouse beam, teddy bear's chest, snowflake, stone in a pond. DO NOT default to "candle and flower" every time — pick something different. Match the imagery to what would be familiar in the target language's cultural context.
- Vary the breath count (anywhere from 3 to 7 slow breaths) and the rhythm (in/hold/out, or in/out, or counted).
- Use the marker [pause] where the reader should slow down. Translate the marker if a more natural pause cue exists in the target language.
- Close with a SHORT gentle line. Vary the close — do not always say "you are safe in this moment". Other examples: "your body remembers it is safe", "this feeling will pass", "you are doing something brave by breathing".
- Use short markdown paragraphs. No bullet lists.`,

  journaling: `JOURNALING PROMPT — 5-8 prompt questions or sentence-starters. The prompts should:
- Be age-appropriate (younger = simpler / more concrete).
- Include at least one prompt about a feeling, one about a memory, one about a wish, and one about a small thing the child can control or do.
- End with explicit permission to draw or speak the answer if writing is hard.
- Be presented as a markdown bullet list.`,

  game: `SUPPORTIVE GAME — a simple, trauma-informed activity a worker can play with a child or small group of children to help with the theme. Output a STRUCTURED markdown document with these sections (use exactly these bold sub-headings):
- **Materials**: list what's needed; STRONGLY prefer "no materials" or only commonly-available items (paper, pen, sticks, small stones). Field deployment may have nothing else.
- **Players**: number of children (single child, pair, small group of 4-6). Include adult facilitator role.
- **Duration**: rough time (5-15 minutes is ideal).
- **How to play**: numbered steps the worker reads or does aloud. Keep steps short and concrete.
- **Why it helps**: 2-3 sentences linking the game to the emotional theme — what the child feels by playing it (sense of control, connection, calm, etc.).
- **Facilitator tips**: 3-4 bullets — gentle ways to handle a child who freezes, refuses, or gets emotional; permission to stop the game at any time; how to close it on a positive note.

Strict rules:
- The game must NOT involve physical force, competition that creates losers, or pressure to "share feelings" beyond the child's comfort.
- Avoid culturally-specific references (no specific holidays, religions, or political symbols).
- Avoid metaphors that mimic the trauma itself (no "earthquake game" for earthquake survivors, no "running from danger" for displaced kids).
- Format the output in markdown.`,
};

const AGE_GUIDANCE: Record<AgeGroup, string> = {
  '5-7':
    'Early childhood. Short sentences and sensory, concrete language ("the warm cup", "the soft blanket"). Repetition is comforting. Gentle animal or child characters work well. Avoid abstract concepts like "future" or "permanent loss" — anchor in the here-and-now.',
  '8-11':
    'Middle childhood. Clear narrative structure. Relatable child or animal protagonist. Simple problem and a calm resolution. The child is allowed to feel scared, angry, or sad — content validates that. Vocabulary is everyday; explain any new word inside the sentence.',
  '12-15':
    'Early adolescence. Respect emotional complexity. Allow ambiguity — not every feeling needs to resolve. Acknowledge the child\'s developing sense of agency and identity. Avoid being preachy or condescending.',
};

const THEME_LABELS: Record<ThemeKey, string> = {
  loss_of_home: 'losing or being far from home',
  fear: 'fear and feeling unsafe',
  displacement: 'being displaced from their community',
  separation: 'separation from family or friends',
  returning_to_school: 'returning to school after a disaster',
};

const LANGUAGE_NAMES: Record<ContentLanguage, string> = {
  en: 'English',
  ar: 'Arabic',
  fr: 'French',
  es: 'Spanish',
};

function describeTheme(theme: string): string {
  const knownKey = (THEME_KEYS as readonly string[]).includes(theme);
  if (knownKey) return THEME_LABELS[theme as ThemeKey];
  // Free-text custom theme — sanitize lightly and pass through.
  return theme.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) || 'a difficult experience';
}

const SYSTEM_PROMPT_TEMPLATE = `You are a trauma-informed children's content creator for AidFlow Pro, a humanitarian aid distribution platform. Generate {{FORMAT}} for children aged {{AGE_GROUP}} who are affected by {{THEME}}.

TRAUMA-INFORMED CARE PRINCIPLES (mandatory):
- Use simple, age-appropriate language for the target age group.
- Validate feelings. NEVER dismiss them with phrases like "everything will be fine", "don't worry", or "be brave".
- Emphasize safety, agency, and hope WITHOUT false reassurance. Hard feelings pass; they are not bad.
- Avoid graphic depictions of disasters, violence, deaths, or injuries.
- Stay culturally and politically neutral. Do not name specific countries, religions, or political groups.
- If a child character experiences something hard, show small concrete actions they take (asking a trusted adult, breathing slowly, holding a familiar object).

AGE GUIDANCE for {{AGE_GROUP}}:
{{AGE_GUIDANCE}}

FORMAT INSTRUCTIONS:
{{FORMAT_INSTRUCTIONS}}

OUTPUT FORMAT (mandatory):
- Line 1: a markdown H1 title (3-7 words). Example: "# The Quiet Boat".
- Following lines: the content in markdown. Use short paragraphs and simple punctuation.
- Do NOT include preamble like "Here is your story:" — just the title line, then the content.

LANGUAGE: respond in {{LANGUAGE_NAME}} only.`;

function buildSystemPrompt(opts: GenerateOpts): string {
  const formatLabelMap: Record<ContentFormat, string> = {
    story: 'a short children\'s story',
    breathing: 'a guided breathing-exercise script',
    journaling: 'a journaling prompt',
    game: 'a supportive game / activity for a worker to play with the child',
  };
  return SYSTEM_PROMPT_TEMPLATE.replaceAll('{{FORMAT}}', formatLabelMap[opts.format])
    .replaceAll('{{AGE_GROUP}}', opts.ageGroup)
    .replaceAll('{{AGE_GUIDANCE}}', AGE_GUIDANCE[opts.ageGroup])
    .replaceAll('{{FORMAT_INSTRUCTIONS}}', FORMAT_INSTRUCTIONS[opts.format])
    .replaceAll('{{THEME}}', describeTheme(opts.theme))
    .replaceAll('{{LANGUAGE_NAME}}', LANGUAGE_NAMES[opts.language]);
}

function buildUserPrompt(opts: GenerateOpts): string {
  const theme = describeTheme(opts.theme);
  const lines: string[] = [
    `Format: ${opts.format}`,
    `Age group: ${opts.ageGroup}`,
    `Theme: ${theme}`,
    `Language: ${LANGUAGE_NAMES[opts.language]}`,
  ];
  if (opts.situation && opts.situation.trim()) {
    // Sanitize before interpolating so the user's free text can't break out
    // of the prompt structure.
    const safe = opts.situation
      .replace(/[\r\n]+/g, ' ')
      .replace(/[`]/g, "'")
      .trim()
      .slice(0, 400);
    lines.push(`Specific situation to address: ${safe}`);
  }
  lines.push('', 'Generate the content now. Begin with the markdown H1 title.');
  return lines.join('\n');
}

/**
 * Parse the streamed buffer into title + body. Title is the first markdown
 * H1; everything else (with the H1 line removed) is the body. Falls back
 * to a generic title when the model forgets the H1.
 */
export function parseGeneratedContent(
  buffer: string,
  fallbackTitle: string
): { title: string; body: string } {
  const trimmed = buffer.trim();
  // Match a markdown H1 anywhere in the first 3 lines (sometimes the model
  // emits a leading blank line before the title).
  const earlyLines = trimmed.split('\n').slice(0, 3).join('\n');
  const titleMatch = earlyLines.match(/^#\s+(.+?)\s*$/m);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    // Remove only the matched title line from the buffer (first occurrence).
    const body = trimmed.replace(/^#\s+.+?\s*$/m, '').trim();
    return { title: title || fallbackTitle, body };
  }
  return { title: fallbackTitle, body: trimmed };
}

/**
 * Stream a piece of emotional-support content from Gemma 4. Yields content
 * deltas as they arrive, plus a terminal `done` event with the parsed title
 * and body. On Ollama unavailability or stream failure, emits a single
 * `error` event and stops.
 */
export async function* generateEmotionalSupportStream(opts: GenerateOpts): AsyncGenerator<
  | { kind: 'delta'; text: string }
  | { kind: 'done'; title: string; body: string }
  | { kind: 'error'; message: string },
  void,
  void
> {
  if (!(await pingOllama())) {
    yield {
      kind: 'error',
      message:
        'Ollama is offline — cannot generate. Start Ollama with the gemma4:e4b model and try again.',
    };
    return;
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(opts) },
    { role: 'user', content: buildUserPrompt(opts) },
  ];
  const fallbackTitle = `${opts.format[0].toUpperCase() + opts.format.slice(1)} — ${describeTheme(opts.theme)}`;
  let buffer = '';
  try {
    for await (const delta of chatStream(messages, {
      // A touch of warmth helps the stories feel less robotic but stays
      // grounded enough to follow the trauma-informed rubric.
      temperature: 0.6,
      maxTokens: 1024,
      numCtx: 8192,
    })) {
      buffer += delta;
      yield { kind: 'delta', text: delta };
    }
  } catch (e) {
    yield {
      kind: 'error',
      message: e instanceof Error ? e.message : 'Stream interrupted.',
    };
    return;
  }
  const { title, body } = parseGeneratedContent(buffer, fallbackTitle);
  yield { kind: 'done', title, body };
}

// =========================================================================
// UTF-8-safe data-url helpers — used both when saving newly-generated
// content (admin's edited markdown can contain Arabic etc.) and by the
// KidsCard renderer to decode any stored text content.
// =========================================================================

export function utf8ToBase64(s: string): string {
  // String.fromCharCode(...bytes) breaks on long inputs; build incrementally.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToUtf8(s: string): string {
  try {
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return s;
  }
}

/**
 * Decode a data URL's text payload, handling both base64-encoded and
 * percent-encoded forms, with UTF-8 awareness so Arabic / French / Spanish
 * content displays correctly.
 */
export function decodeDataUrlText(dataUrl: string): string {
  if (!dataUrl) return '';
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return '';
  const meta = dataUrl.slice(5, commaIdx); // strip "data:"
  const payload = dataUrl.slice(commaIdx + 1);
  const isBase64 = /;\s*base64\s*$/.test(meta);
  if (isBase64) return base64ToUtf8(payload);
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}
