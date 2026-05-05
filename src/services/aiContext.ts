// Builds the global system-prompt context that the AI Assistant uses.
//
// Goal: give Gemma 4 read-access to every module's data — families, distributions,
// uploaded knowledge documents, aid usage guides, children content library,
// Starlink country availability + authorized retailers, Bitchat channels, and
// computed dashboard stats — EXCEPT app Settings (per the user's request).
//
// Heavy media (base64 image/video data, PDF bodies) is intentionally excluded.
// PDF content remains queryable via the RAG pipeline triggered by the
// "Search knowledge base" toggle.

import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import {
  COUNTRIES as STARLINK_COUNTRIES,
  STATUS_LABEL as STARLINK_STATUS_LABEL,
  LAST_UPDATED as STARLINK_COUNTRIES_UPDATED,
} from '@/services/starlinkCountries';
import type {
  Family,
  AidDistribution,
  KnowledgeDocument,
  AidGuide,
  KidsContent,
  StarlinkReseller,
  BitchatMessage,
  Continent,
} from '@/types';

export interface AppSnapshot {
  families: Family[];
  distributions: AidDistribution[];
  documents: KnowledgeDocument[];
  guides: AidGuide[];
  kids: KidsContent[];
  resellers: StarlinkReseller[];
  messages: BitchatMessage[];
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const [families, distributions, documents, guides, kids, resellers, messages] = await Promise.all([
    db.families.toArray(),
    db.distributions.toArray(),
    db.documents.toArray(),
    db.guides.toArray(),
    db.kids.toArray(),
    db.resellers.toArray(),
    db.messages.toArray(),
  ]);
  return { families, distributions, documents, guides, kids, resellers, messages };
}

// ---- Per-section serializers --------------------------------------------

function familiesBlock(families: Family[]): string {
  if (families.length === 0) return '## FAMILIES\n— none —\n';
  const lines = families.map((f) => {
    const r = computeRuleScore(f);
    const days = f.last_aid_at
      ? Math.floor((Date.now() - new Date(f.last_aid_at).getTime()) / 86_400_000)
      : null;
    const meds = f.medical_conditions.length
      ? `medical:[${f.medical_conditions.join(', ')}]`
      : 'medical:none';
    return [
      `${f.family_id} | ${f.head_name}`,
      `sector:${f.location_sector}`,
      `members:${f.member_count} (children<5:${f.children_under_5}, elderly:${f.elderly_count}, pregnant:${f.has_pregnant_member ? 'yes' : 'no'})`,
      meds,
      `displacement:${f.displacement_status}`,
      `income:${f.income_level}`,
      `last_aid:${days === null ? 'never' : days + 'd ago'}`,
      `priority:${r.priority_score}/${r.priority_level}`,
      f.notes ? `notes:"${f.notes}"` : '',
    ]
      .filter(Boolean)
      .join(' | ');
  });
  return `## FAMILIES (${families.length})\n${lines.join('\n')}\n`;
}

function distributionsBlock(d: AidDistribution[], families: Family[]): string {
  if (d.length === 0) return '## DISTRIBUTIONS\n— none —\n';
  const familyMap = new Map(families.map((f) => [f.family_id, f.head_name]));

  // Split into active (pending + out_for_delivery) vs completed
  const active = d.filter((x) => x.status === 'pending' || x.status === 'out_for_delivery');
  const closed = d.filter((x) => x.status !== 'pending' && x.status !== 'out_for_delivery');

  const fmtActive = (x: AidDistribution) => {
    const ageMin = Math.round((Date.now() - new Date(x.created_at).getTime()) / 60000);
    const age = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`;
    const sched = x.scheduled_for ? ` | scheduled:${x.scheduled_for.slice(0, 16).replace('T', ' ')}` : '';
    const assigned = x.assigned_to ? ` | assigned:${x.assigned_to}` : ' | UNASSIGNED';
    return `${x.distribution_id} [${x.status.toUpperCase()}] | family:${x.family_id} (${familyMap.get(x.family_id) ?? '?'}) | created:${age}_ago${assigned}${sched} | items:${x.items_distributed.map((i) => `${i.item_name}×${i.quantity}`).join(', ')}${x.notes ? ` | notes:"${x.notes}"` : ''}`;
  };

  const fmtClosed = (x: AidDistribution) => {
    const when = (x.delivered_at || x.closed_at || x.created_at).slice(0, 10);
    const who = x.delivered_by ?? x.assigned_to ?? '?';
    const reason = x.failure_reason ? ` | reason:"${x.failure_reason}"` : '';
    const flag = x.new_needs_flagged ? ' | NEW_NEED_FLAGGED' : '';
    const notes = x.post_update_notes ? ` | notes:"${x.post_update_notes}"` : '';
    return `${x.distribution_id} [${x.status.toUpperCase()}] | family:${x.family_id} (${familyMap.get(x.family_id) ?? '?'}) | when:${when} | by:${who}${reason}${flag}${notes}`;
  };

  const recentClosed = [...closed]
    .sort((a, b) =>
      (b.delivered_at || b.closed_at || b.created_at).localeCompare(a.delivered_at || a.closed_at || a.created_at)
    )
    .slice(0, 25);

  return [
    `## ACTIVE DISTRIBUTION ORDERS (${active.length}: ${active.filter((x) => x.status === 'pending').length} pending + ${active.filter((x) => x.status === 'out_for_delivery').length} out-for-delivery)`,
    active.length === 0 ? '— none —' : active.map(fmtActive).join('\n'),
    ``,
    `## DISTRIBUTION HISTORY (${closed.length} closed, showing last ${recentClosed.length})`,
    recentClosed.length === 0 ? '— none —' : recentClosed.map(fmtClosed).join('\n'),
  ].join('\n') + '\n';
}

function documentsBlock(docs: KnowledgeDocument[]): string {
  if (docs.length === 0) {
    return '## KNOWLEDGE BASE\n— no PDFs uploaded —\n(Tell the user they can upload protocol PDFs in the Knowledge Base page; you can then cite them via the Search knowledge base toggle.)\n';
  }
  const lines = docs.map(
    (d) =>
      `${d.doc_id} | "${d.title}" | category:${d.category} | pages:${d.page_count} | chunks:${d.chunks.length} | uploaded:${d.uploaded_at.slice(0, 10)}`
  );
  return `## KNOWLEDGE BASE (${docs.length} PDFs — full text via RAG when user enables "Search knowledge base")\n${lines.join('\n')}\n`;
}

function guidesBlock(guides: AidGuide[]): string {
  if (guides.length === 0) return '## AID USAGE GUIDES\n— none —\n';
  const lines = guides.map(
    (g) =>
      `### ${g.guide_id} — ${g.item_name} (category:${g.category}, lang:${g.language})\n${g.body}`
  );
  return `## AID USAGE GUIDES (${guides.length})\n${lines.join('\n\n')}\n`;
}

function kidsBlock(kids: KidsContent[]): string {
  if (kids.length === 0) return '## CHILDREN CONTENT LIBRARY\n— none —\n';
  const lines = kids.map(
    (k) =>
      `${k.content_id} | "${k.title}" | type:${k.type} | age:${k.age_group} | lang:${k.language}`
  );
  return `## CHILDREN CONTENT LIBRARY (${kids.length}, metadata only)\n${lines.join('\n')}\n`;
}

// Country availability (static curated snapshot, ~130 countries).
function starlinkCountriesBlock(): string {
  const groups = { available: [] as string[], soon: [] as string[], waitlist: [] as string[], unavailable: [] as string[] };
  for (const c of STARLINK_COUNTRIES) {
    const note = c.notes ? ` (${c.notes})` : '';
    groups[c.status].push(`${c.code}=${c.name}${note}`);
  }
  return `## STARLINK COUNTRY AVAILABILITY (snapshot ${STARLINK_COUNTRIES_UPDATED})
${STARLINK_STATUS_LABEL.available} (${groups.available.length}): ${groups.available.join('; ')}
${STARLINK_STATUS_LABEL.soon} (${groups.soon.length}): ${groups.soon.join('; ')}
${STARLINK_STATUS_LABEL.waitlist} (${groups.waitlist.length}): ${groups.waitlist.join('; ')}
${STARLINK_STATUS_LABEL.unavailable} (${groups.unavailable.length}): ${groups.unavailable.join('; ')}
`;
}

// Authorized retailers. Compact format — group by continent → country, names
// joined by commas. Source-of-truth is the Starlink article; the JSON ships
// the latest extracted snapshot.
function resellersBlock(resellers: StarlinkReseller[]): string {
  if (resellers.length === 0) {
    return '## STARLINK AUTHORIZED RETAILERS\n— not yet synced — tell the user to open the Starlink page or click Refresh now —\n';
  }
  const byContinent = new Map<Continent, Map<string, string[]>>();
  for (const r of resellers) {
    if (!byContinent.has(r.continent)) byContinent.set(r.continent, new Map());
    const byCountry = byContinent.get(r.continent)!;
    if (!byCountry.has(r.country)) byCountry.set(r.country, []);
    byCountry.get(r.country)!.push(r.notes ? `${r.name} [${r.notes}]` : r.name);
  }
  const order: Continent[] = [
    'Africa',
    'Asia-Pacific',
    'Europe',
    'Latin America',
    'Middle East',
    'North America',
    'Oceania',
  ];
  const lines: string[] = [];
  for (const cont of order) {
    const countries = byContinent.get(cont);
    if (!countries) continue;
    lines.push(`### ${cont}`);
    const sorted = Array.from(countries.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [country, names] of sorted) {
      lines.push(`  ${country}: ${names.join(', ')}`);
    }
  }
  return `## STARLINK AUTHORIZED RETAILERS (${resellers.length}, official Starlink list)\n${lines.join('\n')}\n`;
}

function messagesBlock(m: BitchatMessage[]): string {
  if (m.length === 0) return '## BITCHAT\n— no messages —\n';
  const channels = Array.from(new Set(m.map((x) => x.channel))).sort();
  const recent = [...m]
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
    .slice(0, 30)
    .reverse();
  const lines = recent.map(
    (x) => `${x.channel} | ${x.author} | ${x.sent_at.slice(0, 16).replace('T', ' ')} | via:${x.delivered_via} | ${x.body}`
  );
  return `## BITCHAT — channels: ${channels.join(', ')} | messages: ${m.length} (showing last ${recent.length})\n${lines.join('\n')}\n`;
}

function dashboardBlock(snap: AppSnapshot): string {
  const today = new Date().toISOString().slice(0, 10);
  const deliveredToday = snap.distributions.filter(
    (d) => d.status === 'delivered' && (d.delivered_at ?? d.created_at).slice(0, 10) === today
  );
  const itemsToday = deliveredToday.reduce(
    (s, d) => s + d.items_distributed.reduce((a, b) => a + b.quantity, 0),
    0
  );
  const buckets = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, NORMAL: 0 };
  for (const f of snap.families) {
    const score = (f.priority_score ?? computeRuleScore(f).priority_score) | 0;
    const lvl = score >= 80 ? 'CRITICAL' : score >= 60 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'NORMAL';
    buckets[lvl] += 1;
  }
  const sectors = Array.from(new Set(snap.families.map((f) => f.location_sector)));

  // Status counts across all distributions
  const statusCounts = { pending: 0, out_for_delivery: 0, delivered: 0, failed: 0, cancelled: 0 };
  for (const d of snap.distributions) statusCounts[d.status] += 1;

  // "Stuck" = out_for_delivery for > 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stuck = snap.distributions.filter(
    (d) => d.status === 'out_for_delivery' && d.dispatched_at && new Date(d.dispatched_at).getTime() < cutoff
  ).length;

  return `## TODAY'S DASHBOARD
date:${today}
families_tracked:${snap.families.length}
deliveries_today:${deliveredToday.length}
items_delivered_today:${itemsToday}
sectors_active:${sectors.length} [${sectors.join(', ')}]
priority_buckets: CRITICAL=${buckets.CRITICAL}, HIGH=${buckets.HIGH}, MEDIUM=${buckets.MEDIUM}, NORMAL=${buckets.NORMAL}
order_status: pending=${statusCounts.pending}, out_for_delivery=${statusCounts.out_for_delivery}, delivered=${statusCounts.delivered}, failed=${statusCounts.failed}, cancelled=${statusCounts.cancelled}
stuck_orders_24h+:${stuck}
new_needs_flagged:${snap.families.filter((f) => f.new_need_flagged).length}
`;
}

// ---- Top-level prompt builder -------------------------------------------

interface BuildOpts {
  language: 'en' | 'ar' | 'fr' | 'es';
}

export function buildSystemPrompt(snap: AppSnapshot, opts: BuildOpts): string {
  const langName =
    opts.language === 'ar'
      ? 'Arabic'
      : opts.language === 'fr'
      ? 'French'
      : opts.language === 'es'
      ? 'Spanish'
      : 'English';

  return [
    `You are AidFlow Pro's organizational AI assistant, powered by Gemma 4. Always respond in ${langName}.`,
    ``,
    `You have READ access to a snapshot of every module in the app: families, distributions, knowledge base, aid usage guides, children content library, Starlink country availability + authorized retailers, Bitchat messages, and dashboard stats. You do NOT have access to user account settings or system configuration.`,
    ``,
    `## Rules`,
    `1. Only reference data that appears in the snapshot below. Never invent IDs, names, countries, retailers, or facts.`,
    `2. When the user asks "which families need X in sector Y", filter the FAMILIES section by the matching attribute(s) and list family_id + head_name.`,
    `3. For prioritization questions, refer to priority_score / priority_level and explain the contributing factors (children<5, medical, days_since_last_aid, displacement, income, new_need_flagged).`,
    `4. For aid item questions, consult the AID USAGE GUIDES section. For protocol questions (medical / cholera / starvation / shelter), tell the user to enable "Search knowledge base" — that runs the RAG pipeline over uploaded PDFs and returns cited excerpts.`,
    `5. For Starlink coverage questions ("is Starlink available in X?"), use STARLINK COUNTRY AVAILABILITY. For "where can I buy Starlink in X?" or "which retailers sell Starlink in country Y", use STARLINK AUTHORIZED RETAILERS — list every retailer for the requested country exactly as written. Do not invent retailers; if the country is not in the section, say so and suggest the user check the official Starlink article.`,
    `6. For distribution operations questions: use ACTIVE DISTRIBUTION ORDERS for "what's pending/in-progress", "who is unassigned", "which orders are stuck", "today's workload by team". Use DISTRIBUTION HISTORY for "what was delivered last week", "which deliveries failed", "delivery success rate by sector". Always refer to orders by distribution_id and family_id. When suggesting actions (dispatch / cancel / reassign), describe them clearly so the supervisor can perform them in the Distribute tab.`,
    `7. For team coordination questions, use the BITCHAT section.`,
    `8. For high-level summaries, use the TODAY'S DASHBOARD section. The "stuck_orders_24h+" field flags orders that have been out_for_delivery for more than a day — surface these proactively when relevant.`,
    `9. If the question requires data outside this snapshot (e.g. live outbreak alerts, weather forecasts), say so plainly. Never fabricate.`,
    `10. Be concise. Use bulleted lists when listing multiple records. Avoid markdown tables.`,
    ``,
    `# APP SNAPSHOT`,
    dashboardBlock(snap),
    familiesBlock(snap.families),
    distributionsBlock(snap.distributions, snap.families),
    documentsBlock(snap.documents),
    guidesBlock(snap.guides),
    kidsBlock(snap.kids),
    starlinkCountriesBlock(),
    resellersBlock(snap.resellers),
    messagesBlock(snap.messages),
  ].join('\n');
}
