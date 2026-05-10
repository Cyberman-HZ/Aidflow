// Builds the global system-prompt context that the AI Assistant uses.

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
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const [families, distributions, workers, documents, guides, kids, resellers] =
    await Promise.all([
      db.families.toArray(),
      db.distributions.toArray(),
      db.workers.toArray(),
      db.documents.toArray(),
      db.guides.toArray(),
      db.kids.toArray(),
      db.resellers.toArray(),
    ]);
  return { families, distributions, workers, documents, guides, kids, resellers };
}

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
      f.new_need_flagged ? `NEW_NEED_FLAGGED` : '',
      f.recommended_items?.length
        ? `next_needs:[${f.recommended_items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}]`
        : '',
      f.last_medical_notes ? `last_medical:"${f.last_medical_notes}"` : '',
      f.last_delivery_notes ? `last_delivery_notes:"${f.last_delivery_notes}"` : '',
      f.notes ? `notes:"${f.notes}"` : '',
    ]
      .filter(Boolean)
      .join(' | ');
  });
  return `## FAMILIES (${families.length})\n${lines.join('\n')}\n`;
}

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
    return '## KNOWLEDGE BASE\n— no PDFs uploaded —\n';
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

  const statusCounts = { pending: 0, out_for_delivery: 0, delivered: 0, failed: 0, cancelled: 0 };
  for (const d of snap.distributions) statusCounts[d.status] += 1;

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
    `You have READ access to a snapshot of every module in the app: families, distributions (full order detail), workers, knowledge base, aid usage guides, children content library, Starlink country availability + authorized retailers, and dashboard stats. You do NOT have access to user account settings or system configuration.`,
    ``,
    `## Rules`,
    `1. Only reference data that appears in the snapshot below. Never invent IDs, names, countries, retailers, order numbers, or facts.`,
    `2. When the user asks "which families need X in sector Y", filter the FAMILIES section by the matching attribute(s) and list family_id + head_name.`,
    `3. For prioritization questions, refer to priority_score / priority_level and explain the contributing factors.`,
    `4. For aid item questions, consult the AID USAGE GUIDES section. For protocol questions, tell the user to enable "Search knowledge base".`,
    `5. For Starlink coverage questions, use STARLINK COUNTRY AVAILABILITY. For retailer questions, use STARLINK AUTHORIZED RETAILERS.`,
    `6. For ANY question about a distribution order, look up the matching order and report EVERY relevant field. Always lead with the ORD-### number.`,
    `7. For workers questions, use the WORKERS section. Refer to them by "First Last (Position)" not by their internal W-… id.`,
    `8. For high-level summaries, use the TODAY'S DASHBOARD section.`,
    `9. If the question requires data outside this snapshot, say so plainly. Never fabricate.`,
    `10. Be concise. Use bulleted lists when listing multiple records. Avoid markdown tables.`,
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
  ].join('\n');
}

/**
 * Compact briefing for the Dashboard's executive summary. Kept short because
 * Gemma 4's context window is small and the summary needs to render fast.
 */
export function briefingFacts(snap: AppSnapshot): string {
  return dashboardBlock(snap);
}
