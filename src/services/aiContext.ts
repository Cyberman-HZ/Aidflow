// Builds the global system-prompt context that the AI Assistant uses.
//
// Goal: give Gemma 4 read-access to every module's data — families, distributions,
// uploaded knowledge documents, aid usage guides, children content metadata,
// Starlink providers, Bitchat channels, and computed dashboard stats — EXCEPT
// app Settings (per the user's request).
//
// Heavy media (base64 image/video data, PDF bodies) is intentionally excluded.
// PDF content remains queryable via the RAG pipeline triggered by the
// "Search knowledge base" toggle.

import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import type {
  Family,
  AidDistribution,
  KnowledgeDocument,
  AidGuide,
  KidsContent,
  StarlinkProvider,
  BitchatMessage,
} from '@/types';

export interface AppSnapshot {
  families: Family[];
  distributions: AidDistribution[];
  documents: KnowledgeDocument[];
  guides: AidGuide[];
  kids: KidsContent[];
  providers: StarlinkProvider[];
  messages: BitchatMessage[];
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const [families, distributions, documents, guides, kids, providers, messages] = await Promise.all([
    db.families.toArray(),
    db.distributions.toArray(),
    db.documents.toArray(),
    db.guides.toArray(),
    db.kids.toArray(),
    db.providers.toArray(),
    db.messages.toArray(),
  ]);
  return { families, distributions, documents, guides, kids, providers, messages };
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
  const recent = [...d].sort((a, b) => b.distributed_at.localeCompare(a.distributed_at)).slice(0, 25);
  const familyMap = new Map(families.map((f) => [f.family_id, f.head_name]));
  const lines = recent.map(
    (x) =>
      `${x.distribution_id} | family:${x.family_id} (${familyMap.get(x.family_id) ?? '?'}) | when:${x.distributed_at.slice(0, 10)} | items:${x.items_distributed
        .map((i) => `${i.item_name}×${i.quantity}`)
        .join(', ')} | by:${x.distributed_by}${x.new_needs_flagged ? ' | NEW_NEED_FLAGGED' : ''}${x.post_update_notes ? ` | notes:"${x.post_update_notes}"` : ''}`
  );
  return `## DISTRIBUTIONS (${d.length}, showing last ${recent.length})\n${lines.join('\n')}\n`;
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

function providersBlock(p: StarlinkProvider[]): string {
  if (p.length === 0) return '## STARLINK PROVIDERS\n— none —\n';
  const lines = p.map(
    (x) =>
      `${x.id} | ${x.name} | ${x.region}, ${x.country} | type:${x.type} | signal:${x.signal} | lat:${x.lat.toFixed(3)} lng:${x.lng.toFixed(3)}${x.phone ? ` | phone:${x.phone}` : ''}`
  );
  return `## STARLINK PROVIDERS (${p.length})\n${lines.join('\n')}\n`;
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
  const todayCount = snap.distributions.filter((d) => d.distributed_at.slice(0, 10) === today).length;
  const itemsToday = snap.distributions
    .filter((d) => d.distributed_at.slice(0, 10) === today)
    .reduce((s, d) => s + d.items_distributed.reduce((a, b) => a + b.quantity, 0), 0);
  const buckets = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, NORMAL: 0 };
  for (const f of snap.families) {
    const score = (f.priority_score ?? computeRuleScore(f).priority_score) | 0;
    const lvl = score >= 80 ? 'CRITICAL' : score >= 60 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'NORMAL';
    buckets[lvl] += 1;
  }
  const sectors = Array.from(new Set(snap.families.map((f) => f.location_sector)));
  return `## TODAY'S DASHBOARD
date:${today}
families_tracked:${snap.families.length}
distributions_today:${todayCount}
items_distributed_today:${itemsToday}
sectors_active:${sectors.length} [${sectors.join(', ')}]
priority_buckets: CRITICAL=${buckets.CRITICAL}, HIGH=${buckets.HIGH}, MEDIUM=${buckets.MEDIUM}, NORMAL=${buckets.NORMAL}
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
    `You have READ access to a snapshot of every module in the app (families, distributions, knowledge base, aid usage guides, children content library, Starlink providers, Bitchat messages, dashboard stats). You do NOT have access to user account settings or system configuration.`,
    ``,
    `## Rules`,
    `1. Only reference data that appears in the snapshot below. Never invent IDs, names, sectors, or facts.`,
    `2. When the user asks "which families need X in sector Y", filter the FAMILIES section by the matching attribute(s) and list family_id + head_name.`,
    `3. For prioritization questions, refer to priority_score / priority_level and explain the contributing factors (children<5, medical, days_since_last_aid, displacement, income, new_need_flagged).`,
    `4. For aid item questions, consult the AID USAGE GUIDES section. For protocol questions (medical / cholera / starvation / shelter), tell the user to enable "Search knowledge base" — that runs the RAG pipeline over uploaded PDFs and returns cited excerpts.`,
    `5. For connectivity / map questions, use the STARLINK PROVIDERS section. Sort by signal strength when relevant.`,
    `6. For team coordination questions, use the BITCHAT section.`,
    `7. For high-level summaries, use the TODAY'S DASHBOARD section.`,
    `8. If the question requires data outside this snapshot (e.g. live outbreak alerts, weather forecasts), say so plainly. Never fabricate.`,
    `9. Be concise. Use bulleted lists when listing multiple records. Avoid markdown tables.`,
    ``,
    `# APP SNAPSHOT`,
    dashboardBlock(snap),
    familiesBlock(snap.families),
    distributionsBlock(snap.distributions, snap.families),
    documentsBlock(snap.documents),
    guidesBlock(snap.guides),
    kidsBlock(snap.kids),
    providersBlock(snap.providers),
    messagesBlock(snap.messages),
  ].join('\n');
}
