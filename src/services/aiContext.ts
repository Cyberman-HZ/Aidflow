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
import { formatOrderNumber } from '@/services/orderNumber';
import type {
  Family,
  AidDistribution,
  KnowledgeDocument,
  AidGuide,
  KidsContent,
  StarlinkReseller,
  BitchatMessage,
  Continent,
  Worker,
} from '@/types';

export interface AppSnapshot {
  families: Family[];
  distributions: AidDistribution[];
  workers: Worker[];
  documents: KnowledgeDocument[];
  guides: AidGuide[];
  kids: KidsContent[];
  resellers: StarlinkReseller[];
  messages: BitchatMessage[];
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const [families, distributions, workers, documents, guides, kids, resellers, messages] =
    await Promise.all([
      db.families.toArray(),
      db.distributions.toArray(),
      db.workers.toArray(),
      db.documents.toArray(),
      db.guides.toArray(),
      db.kids.toArray(),
      db.resellers.toArray(),
      db.messages.toArray(),
    ]);
  return { families, distributions, workers, documents, guides, kids, resellers, messages };
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

// Helper — render a single distribution order with EVERY field on the card so
// the assistant can answer any question about any order ("show me ORD-007",
// "who delivered the order to Ahmed last week", "why did D-… fail").
function fmtFullOrder(
  x: AidDistribution,
  familyMap: Map<string, Family>,
  workerMap: Map<string, Worker>
): string {
  const fam = familyMap.get(x.family_id);
  const familyLabel = fam ? `${fam.head_name} (sector:${fam.location_sector}, ${fam.member_count} members)` : '?';

  const workerLabel = (id?: string) => {
    if (!id) return undefined;
    const w = workerMap.get(id);
    return w ? `${w.first_name} ${w.last_name} [${w.position}, ${w.id}]` : id;
  };
  const assignedLabel = workerLabel(x.assigned_to);
  const deliveredByLabel = workerLabel(x.delivered_by);

  const itemsLabel = x.items_distributed
    .map((i) => `${i.item_name}×${i.quantity} (${i.category})`)
    .join(', ');
  const totalQty = x.items_distributed.reduce((a, b) => a + b.quantity, 0);

  const priorityLevel =
    x.ai_priority_score >= 80
      ? 'CRITICAL'
      : x.ai_priority_score >= 60
      ? 'HIGH'
      : x.ai_priority_score >= 40
      ? 'MEDIUM'
      : 'NORMAL';

  const lines = [
    `### ${formatOrderNumber(x.order_number)} — ${x.distribution_id}`,
    `  status: ${x.status.toUpperCase()}`,
    `  family: ${x.family_id} → ${familyLabel}`,
    `  priority_at_creation: ${x.ai_priority_score}/${priorityLevel}`,
    x.ai_reasoning ? `  ai_reasoning: "${x.ai_reasoning}"` : '',
    `  items (${x.items_distributed.length} type${x.items_distributed.length === 1 ? '' : 's'}, ${totalQty} total): ${itemsLabel}`,
    `  created_at: ${x.created_at} (by ${x.created_by})`,
    x.scheduled_for ? `  scheduled_for: ${x.scheduled_for}` : '',
    x.dispatched_at ? `  dispatched_at: ${x.dispatched_at}` : '',
    x.delivered_at ? `  delivered_at: ${x.delivered_at}` : '',
    x.closed_at ? `  closed_at: ${x.closed_at}` : '',
    assignedLabel ? `  assigned_to: ${assignedLabel}` : '  assigned_to: UNASSIGNED',
    deliveredByLabel ? `  delivered_by: ${deliveredByLabel}` : '',
    x.notes ? `  pre_delivery_notes: "${x.notes}"` : '',
    x.post_update_notes ? `  post_delivery_notes: "${x.post_update_notes}"` : '',
    x.failure_reason ? `  failure_reason: "${x.failure_reason}"` : '',
    x.new_needs_flagged ? `  flags: NEW_NEED_FLAGGED` : '',
  ];
  return lines.filter((l) => l).join('\n');
}

function distributionsBlock(d: AidDistribution[], families: Family[], workers: Worker[]): string {
  if (d.length === 0) return '## DISTRIBUTIONS\n— none —\n';
  const familyMap = new Map(families.map((f) => [f.family_id, f]));
  const workerMap = new Map(workers.map((w) => [w.id, w]));

  // Split into active (pending + out_for_delivery) vs completed
  const active = d.filter((x) => x.status === 'pending' || x.status === 'out_for_delivery');
  const closed = d.filter((x) => x.status !== 'pending' && x.status !== 'out_for_delivery');

  const sortedActive = [...active].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });

  const recentClosed = [...closed]
    .sort((a, b) =>
      (b.delivered_at || b.closed_at || b.created_at).localeCompare(
        a.delivered_at || a.closed_at || a.created_at
      )
    )
    .slice(0, 30);

  return [
    `## ACTIVE DISTRIBUTION ORDERS (${active.length}: ${active.filter((x) => x.status === 'pending').length} pending + ${active.filter((x) => x.status === 'out_for_delivery').length} out-for-delivery)`,
    `(Each order below shows every field on the order card. Refer to orders by their ORD-### number first, then by distribution_id.)`,
    sortedActive.length === 0 ? '— none —' : sortedActive.map((x) => fmtFullOrder(x, familyMap, workerMap)).join('\n\n'),
    ``,
    `## DISTRIBUTION HISTORY (${closed.length} closed, showing last ${recentClosed.length} most recent)`,
    recentClosed.length === 0 ? '— none —' : recentClosed.map((x) => fmtFullOrder(x, familyMap, workerMap)).join('\n\n'),
  ].join('\n') + '\n';
}

function workersBlock(workers: Worker[], distributions: AidDistribution[]): string {
  if (workers.length === 0) {
    return '## WORKERS\n— no workers in the database — tell the user to add one in the Workers tab —\n';
  }

  // Compute per-worker stats so the assistant can answer "who is the busiest
  // field worker", "show me Tariq's history", etc.
  const stats = new Map<string, { active: number; out: number; delivered: number; failed: number; total: number }>();
  for (const w of workers) {
    stats.set(w.id, { active: 0, out: 0, delivered: 0, failed: 0, total: 0 });
  }
  for (const d of distributions) {
    const wid = d.assigned_to ?? d.delivered_by;
    if (!wid) continue;
    const s = stats.get(wid);
    if (!s) continue;
    s.total++;
    if (d.status === 'pending' || d.status === 'out_for_delivery') s.active++;
    if (d.status === 'out_for_delivery') s.out++;
    if (d.status === 'delivered') s.delivered++;
    if (d.status === 'failed') s.failed++;
  }

  const lines = workers
    .slice()
    .sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
    )
    .map((w) => {
      const s = stats.get(w.id)!;
      const phone = w.phone ? ` | phone:${w.phone}` : '';
      const notes = w.notes ? ` | notes:"${w.notes}"` : '';
      const busy = s.out > 0 ? ' | CURRENTLY OUT FOR DELIVERY' : '';
      return `${w.id} | ${w.first_name} ${w.last_name} | position:${w.position}${phone}${notes} | active:${s.active} delivered:${s.delivered} failed:${s.failed} total:${s.total}${busy}`;
    });

  return `## WORKERS (${workers.length} — field staff who deliver aid orders; not app users)\n${lines.join('\n')}\n`;
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
  const queued = m.filter((x) => x.status === 'queued' || x.status === 'failed').length;
  const recent = [...m]
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
    .slice(0, 30)
    .reverse();
  const lines = recent.map(
    (x) =>
      `${x.channel} | ${x.author} | ${x.sent_at.slice(0, 16).replace('T', ' ')} | status:${x.status}${x.delivered_via ? ' via:' + x.delivered_via : ''} | ${x.body}`
  );
  return `## BITCHAT — channels: ${channels.join(', ')} | messages: ${m.length}, ${queued} queued/failed (showing last ${recent.length})\n${lines.join('\n')}\n`;
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
    `You have READ access to a snapshot of every module in the app: families, distributions (full order detail), workers, knowledge base, aid usage guides, children content library, Starlink country availability + authorized retailers, Bitchat messages, and dashboard stats. You do NOT have access to user account settings or system configuration.`,
    ``,
    `## Rules`,
    `1. Only reference data that appears in the snapshot below. Never invent IDs, names, countries, retailers, order numbers, or facts.`,
    `2. When the user asks "which families need X in sector Y", filter the FAMILIES section by the matching attribute(s) and list family_id + head_name.`,
    `3. For prioritization questions, refer to priority_score / priority_level and explain the contributing factors (children<5, medical, days_since_last_aid, displacement, income, new_need_flagged).`,
    `4. For aid item questions, consult the AID USAGE GUIDES section. For protocol questions (medical / cholera / starvation / shelter), tell the user to enable "Search knowledge base" — that runs the RAG pipeline over uploaded PDFs and returns cited excerpts.`,
    `5. For Starlink coverage questions ("is Starlink available in X?"), use STARLINK COUNTRY AVAILABILITY. For "where can I buy Starlink in X?" or "which retailers sell Starlink in country Y", use STARLINK AUTHORIZED RETAILERS — list every retailer for the requested country exactly as written. Do not invent retailers; if the country is not in the section, say so and suggest the user check the official Starlink article.`,
    `6. For ANY question about a distribution order (e.g. "show me ORD-007", "what's in order D-…", "who delivered to the Ahmed family", "why did the order to family F-… fail", "what items were in last week's delivery to sector Z"), look up the matching order in ACTIVE DISTRIBUTION ORDERS or DISTRIBUTION HISTORY and report EVERY relevant field shown on its card: ORD-### number, distribution_id, status, family + sector, items + quantities, AI priority score and reasoning at creation, all timestamps (created / scheduled / dispatched / delivered / closed), assigned worker, delivering worker, pre-delivery and post-delivery notes, and any failure reason or new-need flag. Always lead with the ORD-### number — that's how field staff identify orders.`,
    `7. For workers questions ("who is available", "who is the busiest", "show me Tariq's history", "list all drivers"), use the WORKERS section. Workers are field staff (Field Worker / Supervisor / Driver / Medical Officer / etc.) who deliver orders — they are different from app login users and don't authenticate. Refer to them by "First Last (Position)" not by their internal W-… id.`,
    `8. For team coordination questions, use the BITCHAT section.`,
    `9. For high-level summaries, use the TODAY'S DASHBOARD section. The "stuck_orders_24h+" field flags orders that have been out_for_delivery for more than a day — surface these proactively when relevant.`,
    `10. If the question requires data outside this snapshot (e.g. live outbreak alerts, weather forecasts), say so plainly. Never fabricate.`,
    `11. Be concise. Use bulleted lists when listing multiple records. Avoid markdown tables.`,
    ``,
    `# APP SNAPSHOT`,
    dashboardBlock(snap),
    familiesBlock(snap.families),
    distributionsBlock(snap.distributions, snap.families, snap.workers),
    workersBlock(snap.workers, snap.distributions),
    documentsBlock(snap.documents),
    guidesBlock(snap.guides),
    kidsBlock(snap.kids),
    starlinkCountriesBlock(),
    resellersBlock(snap.resellers),
    messagesBlock(snap.messages),
  ].join('\n');
}
