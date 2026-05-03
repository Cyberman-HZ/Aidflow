// Privacy-safe web search via Wikipedia.
//
// Privacy contract:
// - We send ONLY the user's question (after light cleanup) to Wikipedia.
// - We NEVER send family data, distribution records, or any IndexedDB content.
//
// Search strategy:
// 1. Clean the user's question — strip framing phrases like "tell me about",
//    "search wikipedia", "summarize" etc. that confuse Wikipedia's full-text
//    search. This dramatically improves result quality on natural-language
//    queries vs. raw keyword passes.
// 2. Hit Wikipedia's modern REST search endpoint (/w/rest.php/v1/search/page)
//    which ranks much better than the legacy action=query&list=search.
// 3. Fetch the lead-paragraph extract for the top results for richer context.

const WIKI_BASES: Record<string, string> = {
  en: 'https://en.wikipedia.org',
  ar: 'https://ar.wikipedia.org',
  fr: 'https://fr.wikipedia.org',
  es: 'https://es.wikipedia.org',
};

export interface WikipediaResult {
  title: string;
  description?: string;
  excerpt: string;
  url: string;
  pageid?: number;
  extract?: string;
}

interface RestSearchResponse {
  pages?: {
    id: number;
    key: string;
    title: string;
    excerpt: string;
    description?: string;
    matched_title?: string | null;
  }[];
}

interface ExtractResponse {
  query?: {
    pages?: Record<string, { pageid: number; title: string; extract?: string }>;
  };
}

function baseFor(lang: string): string {
  return WIKI_BASES[lang] ?? WIKI_BASES.en;
}

// ---- Query cleanup ------------------------------------------------------
// Strip common framing phrases so the search engine sees the actual topic.

const STRIP_PATTERNS: { regex: RegExp; lang: string }[] = [
  // English framing
  { regex: /^(please\s+)?(can|could|would)\s+you\s+/i, lang: 'en' },
  { regex: /\b(give|tell|show)\s+me\s+(some\s+)?(info|information|details|facts)\s+(about|on|regarding)\s+/i, lang: 'en' },
  { regex: /\b(what|who|where|when|how)\s+(is|are|was|were|does|do)\s+/i, lang: 'en' },
  { regex: /\bsearch\s+(for\s+|on\s+)?(wikipedia\s+(for\s+|about\s+)?|the\s+web\s+(for\s+)?)?/i, lang: 'en' },
  { regex: /\b(summari[sz]e|summary\s+of)\s+(the\s+)?(pages?|articles?|results?)?/i, lang: 'en' },
  { regex: /\bfind\s+(me\s+)?(out\s+)?/i, lang: 'en' },
  { regex: /\blook\s+up\s+/i, lang: 'en' },
  { regex: /\bplease\b/gi, lang: 'en' },
  // Arabic framing (short list)
  { regex: /\b(ابحث|أعطني|أخبرني|ما هو|ما هي)\s+/g, lang: 'ar' },
  { regex: /\bمعلومات\s+عن\s+/g, lang: 'ar' },
  // French framing
  { regex: /\b(donne[zr]?(-moi)?|dis-moi|raconte-moi)\s+/gi, lang: 'fr' },
  { regex: /\bqu[''']est-ce\s+que\s+/gi, lang: 'fr' },
  { regex: /\b(des\s+)?informations?\s+(sur|à\s+propos\s+de)\s+/gi, lang: 'fr' },
  // Spanish framing
  { regex: /\b(dame|dime|cu[ée]ntame)\s+/gi, lang: 'es' },
  { regex: /\bqu[ée]\s+es\s+/gi, lang: 'es' },
  { regex: /\b(da[mt]e\s+)?(informaci[oó]n|datos)\s+(sobre|acerca\s+de)\s+/gi, lang: 'es' },
];

function cleanQuery(raw: string, lang: string): string {
  let q = raw.trim();

  // Apply language-applicable stripping passes
  for (const p of STRIP_PATTERNS) {
    if (p.lang === lang || p.lang === 'en') {
      q = q.replace(p.regex, ' ');
    }
  }

  // Drop trailing instructions after the first comma in a long sentence
  // (e.g. "cholera, search wikipedia and summarize" → "cholera")
  if (q.length > 25 && q.includes(',')) {
    q = q.split(',')[0];
  }

  // Collapse whitespace + strip trailing punctuation
  q = q.replace(/\s+/g, ' ').replace(/[?!.,;:\s]+$/g, '').trim();
  // Fall back to the original if cleanup over-stripped to nothing
  return q.length >= 2 ? q : raw.trim();
}

// ---- REST search (better ranking than action=query) ---------------------

async function searchPages(
  query: string,
  lang: string,
  limit: number
): Promise<{ id: number; title: string; description?: string; excerpt: string }[]> {
  const base = baseFor(lang);
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(`${base}/w/rest.php/v1/search/page?${params.toString()}`, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Wikipedia REST search failed: ${res.status}`);
  const data = (await res.json()) as RestSearchResponse;
  return (data.pages ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    excerpt: (p.excerpt ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  }));
}

async function fetchExtracts(pageids: number[], lang: string): Promise<Record<number, string>> {
  if (pageids.length === 0) return {};
  const base = baseFor(lang);
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    exintro: 'true',
    explaintext: 'true',
    exlimit: String(pageids.length),
    pageids: pageids.join('|'),
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`${base}/w/api.php?${params.toString()}`, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Wikipedia extract failed: ${res.status}`);
  const data = (await res.json()) as ExtractResponse;
  const pages = data.query?.pages ?? {};
  const out: Record<number, string> = {};
  for (const key of Object.keys(pages)) {
    const p = pages[key];
    if (p?.extract) out[p.pageid] = p.extract;
  }
  return out;
}

/**
 * Top-level Wikipedia search used by the AI Assistant.
 */
export async function wikipediaSearch(
  query: string,
  lang: 'en' | 'ar' | 'fr' | 'es' = 'en',
  limit = 3
): Promise<WikipediaResult[]> {
  const cleaned = cleanQuery(query, lang);
  if (!cleaned) return [];
  const hits = await searchPages(cleaned, lang, limit);
  if (hits.length === 0) return [];
  const extracts = await fetchExtracts(
    hits.map((h) => h.id),
    lang
  );
  const base = baseFor(lang);
  return hits.map((h) => ({
    title: h.title,
    description: h.description,
    excerpt: h.excerpt,
    pageid: h.id,
    url: `${base}/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    extract: extracts[h.id],
  }));
}

/**
 * Build a context block + citations list from Wikipedia results.
 * Caps each extract at ~1500 chars to keep total prompt size reasonable.
 * Returns the cleaned query alongside so the caller can show it in the UI.
 */
export async function wikipediaContext(
  query: string,
  lang: 'en' | 'ar' | 'fr' | 'es' = 'en'
): Promise<{
  context: string;
  citations: { doc_id: string; title: string; page: number; url: string }[];
  searchedFor: string;
}> {
  const searchedFor = cleanQuery(query, lang);
  try {
    const results = await wikipediaSearch(query, lang, 3);
    if (results.length === 0) {
      return { context: '', citations: [], searchedFor };
    }
    const context = results
      .map((r, i) => {
        const body = (r.extract ?? r.excerpt).slice(0, 1500);
        const desc = r.description ? ` — ${r.description}` : '';
        return `[#${i + 1}] Wikipedia article: "${r.title}"${desc}\nURL: ${r.url}\n${body}`;
      })
      .join('\n\n');
    const citations = results.map((r) => ({
      doc_id: r.url,
      title: `Wikipedia: ${r.title}`,
      page: 0,
      url: r.url,
    }));
    return { context, citations, searchedFor };
  } catch (e) {
    console.warn('[webSearch] wikipedia failed', e);
    return { context: '', citations: [], searchedFor };
  }
}
