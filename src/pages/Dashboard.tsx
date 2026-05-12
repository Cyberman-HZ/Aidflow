// Dashboard & Reports — merged page.
// Combines the live KPIs/recent-distributions view with the historical charts,
// CSV export, and AI executive summary that used to live on /reports.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Users,
  Package,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  Activity,
  Download,
  BarChart3,
  RefreshCw,
  WifiOff,
  Trash2,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LineChart,
  Line,
} from 'recharts';
import { Card, StatCard } from '@/components/Card';
import PriorityBadge, { levelFromScore } from '@/components/PriorityBadge';
import Loading from '@/components/Loading';
import { db } from '@/db/database';
import { useConnectivityStore } from '@/stores/connectivityStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { computeRuleScore } from '@/services/priorityRules';
import { chatStream, pingOllama } from '@/services/ollama';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PRIORITY_COLORS = {
  CRITICAL: '#ef4444',
  HIGH: '#f97316',
  MEDIUM: '#eab308',
  NORMAL: '#22c55e',
};

// =========================================================================
// PDF export helpers — used by the "Export PDF" button on the AI Executive
// Summary card. We render a small standalone HTML document and let the
// browser's native print-to-PDF do the rest. No new dependency, no bundle
// bloat, full RTL support, real selectable text in the resulting file.
// =========================================================================

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Apply inline emphasis AFTER HTML escaping so the asterisks survive the
// escape but our markers still match.
const formatInline = (s: string): string => {
  let html = escapeHtml(s);
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  // simple `code` spans
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  return html;
};

// Minimal markdown-to-HTML converter — tuned to the four shapes the AI
// summary actually uses: ## / ### headers, "- " or "* " bullets, blank
// lines as paragraph separators, and inline **bold** / *italic* / `code`.
const summaryMarkdownToHtml = (md: string): string => {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${formatInline(line.slice(3))}</h2>`);
    } else if (line.startsWith('### ')) {
      closeList();
      out.push(`<h3>${formatInline(line.slice(4))}</h3>`);
    } else if (line.startsWith('# ')) {
      closeList();
      out.push(`<h1>${formatInline(line.slice(2))}</h1>`);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInline(line.slice(2))}</li>`);
    } else {
      closeList();
      out.push(`<p>${formatInline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
};

const buildSummaryPrintDoc = (
  body: string,
  source: 'ai' | 'rules' | null,
  lang: 'en' | 'ar' | 'fr' | 'es'
): string => {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const generatedLabels: Record<string, string> = {
    en: 'Generated',
    ar: 'تم الإنشاء',
    fr: 'Généré le',
    es: 'Generado',
  };
  const titleLabels: Record<string, string> = {
    en: 'AidFlow Pro — Operations brief',
    ar: 'AidFlow Pro — تقرير العمليات',
    fr: 'AidFlow Pro — Note d’opérations',
    es: 'AidFlow Pro — Resumen de operaciones',
  };
  const sourceLabel =
    source === 'ai'
      ? 'AI brief (local model via Ollama)'
      : source === 'rules'
      ? 'Rule-based fallback (Ollama unreachable)'
      : '';

  const title = titleLabels[lang] ?? titleLabels.en;
  const generatedAt = new Date();
  const generatedHuman = generatedAt.toLocaleString();
  const isoStamp = generatedAt.toISOString().slice(0, 19).replace('T', ' ');

  const fontStack =
    lang === 'ar'
      ? `"Tahoma", "Arial", "Segoe UI", sans-serif`
      : `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const listSidePadding = lang === 'ar' ? 'padding-right: 22px; padding-left: 0' : 'padding-left: 22px; padding-right: 0';

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — ${escapeHtml(generatedAt.toLocaleDateString())}</title>
<style>
  @page { size: A4; margin: 18mm; }
  html, body { background: #fff; }
  body {
    font-family: ${fontStack};
    color: #222831;
    line-height: 1.55;
    max-width: 720px;
    margin: 24px auto;
    padding: 0 24px;
    font-size: 12.5pt;
  }
  header {
    border-bottom: 2px solid #00ADB5;
    padding-bottom: 12px;
    margin-bottom: 18px;
  }
  header h1 {
    font-size: 22px;
    margin: 0 0 4px;
    color: #222831;
  }
  header .meta { font-size: 11px; color: #666; }
  h2 {
    font-size: 16px;
    color: #00ADB5;
    margin: 18px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #eee;
  }
  h3 { font-size: 14px; margin: 14px 0 6px; }
  ul { ${listSidePadding}; margin: 6px 0; }
  li { margin: 4px 0; }
  p { margin: 6px 0; }
  strong { color: #222831; }
  em { color: #393E46; }
  code {
    background: #f3f4f6;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: "Menlo", "Consolas", monospace;
    font-size: 0.9em;
  }
  footer {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid #eee;
    font-size: 10px;
    color: #888;
  }
  @media print {
    body { margin: 0; max-width: none; padding: 0; }
    header { break-after: avoid; page-break-after: avoid; }
    h2, h3 { break-after: avoid; page-break-after: avoid; }
    li { break-inside: avoid; page-break-inside: avoid; }
  }
</style>
</head>
<body dir="${dir}">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      ${escapeHtml(generatedLabels[lang] ?? generatedLabels.en)} ${escapeHtml(generatedHuman)}${
    sourceLabel ? ` · ${escapeHtml(sourceLabel)}` : ''
  }
    </div>
  </header>
  <main>
${summaryMarkdownToHtml(body)}
  </main>
  <footer>
    AidFlow Pro · Gemma 4 Good Hackathon · ${escapeHtml(isoStamp)}
  </footer>
</body>
</html>`;
};

export default function Dashboard() {
  const { t } = useTranslation();
  const conn = useConnectivityStore();
  const language = useSettingsStore((s) => s.language);

  // Live queries — react to any DB change so the dashboard always reflects
  // current state (and the AI summary, when generated, uses the latest data).
  const families = useLiveQuery(
    () => db.families.toArray().then((rows) => rows.filter((f) => !f.deleted_at)),
    []
  ) ?? [];

  // Sibling query — the *deleted* families, sorted newest-first. Used by
  // the "Recent family deletions" audit card lower on this page. We keep
  // these in a separate query (rather than filtering the same array twice)
  // so the main `families` array stays cheap to use everywhere it's
  // already passed around without callers having to remember "oh, also
  // exclude deleted_at."
  const deletedFamilies =
    useLiveQuery(
      () =>
        db.families
          .toArray()
          .then((rows) =>
            rows
              .filter((f) => !!f.deleted_at)
              .sort((a, b) =>
                (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '')
              )
          ),
      []
    ) ?? [];
  const distributions = useLiveQuery(() => db.distributions.toArray(), []) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray(), []) ?? [];

  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summarySource, setSummarySource] = useState<'ai' | 'rules' | null>(null);
  const [generating, setGenerating] = useState(false);

  // ---- Derived data --------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const todayDistros = distributions.filter(
    (d) =>
      d.status === 'delivered' &&
      (d.delivered_at ?? d.created_at ?? '').slice(0, 10) === today
  );
  const totalItemsToday = todayDistros.reduce(
    (sum, d) => sum + d.items_distributed.reduce((s, it) => s + it.quantity, 0),
    0
  );
  const activeOrders = distributions.filter(
    (d) => d.status === 'pending' || d.status === 'out_for_delivery'
  ).length;

  const scored = useMemo(
    () =>
      families.map((f) => ({
        ...f,
        score: f.priority_score ?? computeRuleScore(f).priority_score,
        level: f.priority_level ?? computeRuleScore(f).priority_level,
      })),
    [families]
  );
  const criticalCount = scored.filter((f) => f.score >= 80).length;

  const priorityDist = (['CRITICAL', 'HIGH', 'MEDIUM', 'NORMAL'] as const).map((lvl) => ({
    name: t(`priority.${lvl}`),
    level: lvl,
    value: scored.filter((f) => f.level === lvl).length,
  }));

  // Distributions per sector (bar) — only count delivered, not pending/cancelled
  const sectorData = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of distributions) {
      if (d.status !== 'delivered') continue;
      const sector =
        families.find((f) => f.family_id === d.family_id)?.location_sector ?? 'Unknown';
      map.set(sector, (map.get(sector) ?? 0) + 1);
    }
    return Array.from(map, ([sector, count]) => ({ sector, count }));
  }, [families, distributions]);

  // Distributions over time (last 14 days, line chart from /reports) — count deliveries
  const timeData = useMemo(() => {
    const days: { day: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push({
        day: key.slice(5),
        count: distributions.filter(
          (x) =>
            x.status === 'delivered' &&
            (x.delivered_at ?? x.created_at ?? '').slice(0, 10) === key
        ).length,
      });
    }
    return days;
  }, [distributions]);

  const recentDistros = [...distributions]
    .sort((a, b) =>
      (b.delivered_at ?? b.created_at ?? '').localeCompare(a.delivered_at ?? a.created_at ?? '')
    )
    .slice(0, 6);

  const aiStatus =
    conn.state === 'online'
      ? t('connectivity.online')
      : conn.state === 'local'
      ? t('connectivity.local')
      : t('connectivity.disconnected');

  // ---- Actions ------------------------------------------------------------

  // ---- PDF export of the AI executive summary ----------------------------
  //
  // Strategy: we use the browser's native print-to-PDF rather than bundling
  // jsPDF or pdfmake — it costs zero bytes in the bundle, works fully
  // offline, produces a real PDF with selectable text, and handles RTL
  // Arabic perfectly. The button opens a small new window with the summary
  // already styled for print and auto-triggers the OS print dialog where
  // "Save as PDF" is the default destination on every modern OS.

  const exportSummaryAsPdf = () => {
    if (!summary || generating) return;
    const html = buildSummaryPrintDoc(summary, summarySource, language);
    const win = window.open('', '_blank', 'width=820,height=900');
    if (!win) {
      setSummaryError(
        'Pop-up blocked. Please allow pop-ups for this site so the PDF export window can open.'
      );
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    const trigger = () => {
      try {
        win.focus();
        win.print();
      } catch {
        // some browsers throw if the window was closed before print fires
      }
    };
    if (win.document.readyState === 'complete') {
      setTimeout(trigger, 80);
    } else {
      win.addEventListener('load', () => setTimeout(trigger, 80));
    }
  };

  // ---- AI executive summary ----------------------------------------------
  //
  // Builds a rich snapshot of the operation (counts + named sectors + top
  // critical families + recent failures + worker workload) and asks Gemma 4
  // to produce a director-friendly brief. Streams the response so the user
  // sees text appear progressively instead of staring at a blank card for
  // 30+ seconds.
  //
  // If Ollama is unreachable we fall back to a deterministic rule-based
  // summary built from the same snapshot — the button is never silently
  // broken.

  const buildSummaryPayload = () => {
    const familyMap = new Map(families.map((f) => [f.family_id, f]));
    const workerMap = new Map(workers.map((w) => [w.id, w]));

    // Per-sector aggregates
    const sectorStats = new Map<
      string,
      { families: number; critical: number; deliveries: number; pending: number; out_for_delivery: number; failed: number }
    >();
    for (const f of families) {
      const s = f.location_sector;
      const cur = sectorStats.get(s) ?? { families: 0, critical: 0, deliveries: 0, pending: 0, out_for_delivery: 0, failed: 0 };
      cur.families++;
      const score = f.priority_score ?? computeRuleScore(f).priority_score;
      if (score >= 80) cur.critical++;
      sectorStats.set(s, cur);
    }
    for (const d of distributions) {
      const sector = familyMap.get(d.family_id)?.location_sector;
      if (!sector) continue;
      const cur = sectorStats.get(sector);
      if (!cur) continue;
      if (d.status === 'delivered') cur.deliveries++;
      else if (d.status === 'pending') cur.pending++;
      else if (d.status === 'out_for_delivery') cur.out_for_delivery++;
      else if (d.status === 'failed') cur.failed++;
    }

    // Top 5 critical families with reason summary
    const topCritical = [...families]
      .map((f) => {
        const score = f.priority_score ?? computeRuleScore(f).priority_score;
        const reason = f.ai_reason ?? computeRuleScore(f).reason;
        const days = f.last_aid_at
          ? Math.floor((Date.now() - new Date(f.last_aid_at).getTime()) / 86_400_000)
          : null;
        return { family_id: f.family_id, head_name: f.head_name, sector: f.location_sector, score, reason, days_since_last_aid: days, new_need_flagged: !!f.new_need_flagged };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Recent failed/cancelled deliveries
    const recentIssues = distributions
      .filter((d) => d.status === 'failed' || d.status === 'cancelled')
      .sort((a, b) => (b.closed_at ?? b.created_at).localeCompare(a.closed_at ?? a.created_at))
      .slice(0, 5)
      .map((d) => ({
        order: d.order_number ?? d.distribution_id,
        family: familyMap.get(d.family_id)?.head_name ?? d.family_id,
        sector: familyMap.get(d.family_id)?.location_sector ?? '',
        status: d.status,
        reason: d.failure_reason ?? '',
      }));

    // Stuck orders (out_for_delivery > 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stuckOrders = distributions
      .filter((d) => d.status === 'out_for_delivery' && d.dispatched_at && new Date(d.dispatched_at).getTime() < cutoff)
      .map((d) => ({
        order: d.order_number ?? d.distribution_id,
        family: familyMap.get(d.family_id)?.head_name ?? d.family_id,
        sector: familyMap.get(d.family_id)?.location_sector ?? '',
        worker: d.assigned_to ? workerMap.get(d.assigned_to) ?? null : null,
        dispatched_at: d.dispatched_at,
      }));

    // Worker workload (active orders per worker)
    const workerLoad = workers
      .map((w) => {
        const active = distributions.filter(
          (d) => (d.assigned_to === w.id) && (d.status === 'pending' || d.status === 'out_for_delivery')
        ).length;
        return { name: `${w.first_name} ${w.last_name}`, position: w.position, active };
      })
      .sort((a, b) => b.active - a.active);

    // ---- AI-augmented signals (added for richer briefings) ----------------
    //
    // These three blocks turn the AI summary from a pure status report into
    // something that can also surface (a) supply-pacing intelligence and
    // (b) anomalies worth investigating — without inventing data the system
    // doesn't have. All numbers are derived from the same Dexie tables the
    // dashboard already shows; the AI just gets to reason over them.

    const sevenDaysAgo = Date.now() - 7 * 86_400_000;

    // Items velocity — top 5 items by quantity distributed in the last 7 days.
    // Lets the AI say "hygiene kits going out at ~12/day" so procurement can
    // anticipate without us shipping a full stock register.
    const itemCounts = new Map<string, number>();
    for (const d of distributions) {
      if (d.status !== 'delivered') continue;
      const ts = new Date(d.delivered_at ?? d.created_at ?? '').getTime();
      if (Number.isNaN(ts) || ts < sevenDaysAgo) continue;
      for (const it of d.items_distributed) {
        const key = (it.item_name ?? '').trim().toLowerCase();
        if (!key) continue;
        itemCounts.set(key, (itemCounts.get(key) ?? 0) + (Number(it.quantity) || 0));
      }
    }
    const itemsVelocity = Array.from(itemCounts.entries())
      .map(([item, qty_7d]) => ({
        item,
        qty_7d,
        qty_per_day: Math.round((qty_7d / 7) * 10) / 10,
      }))
      .sort((a, b) => b.qty_7d - a.qty_7d)
      .slice(0, 5);

    // Repeat-delivery anomalies — same family received the same item type
    // 3+ times in the last 7 days. Often legitimate (recurring need), but
    // worth a glance to rule out duplicate orders or fraud.
    const repeatMap = new Map<
      string,
      { family_id: string; family: string; item: string; count: number }
    >();
    for (const d of distributions) {
      if (d.status !== 'delivered') continue;
      const ts = new Date(d.delivered_at ?? d.created_at ?? '').getTime();
      if (Number.isNaN(ts) || ts < sevenDaysAgo) continue;
      const fam = familyMap.get(d.family_id);
      if (!fam) continue;
      for (const it of d.items_distributed) {
        const itemName = (it.item_name ?? '').trim();
        if (!itemName) continue;
        const key = `${d.family_id}|${itemName.toLowerCase()}`;
        const cur = repeatMap.get(key) ?? {
          family_id: d.family_id,
          family: fam.head_name,
          item: itemName,
          count: 0,
        };
        cur.count += 1;
        repeatMap.set(key, cur);
      }
    }
    const repeatDeliveryAlerts = Array.from(repeatMap.values())
      .filter((r) => r.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Unserved-too-long — critical-priority families with no recorded aid
    // in 14+ days (or never). The dashboard already shows critical count,
    // but this is the *high-priority + neglected* intersection that
    // genuinely needs the admin's attention first thing in the morning.
    const unservedTooLong = scored
      .filter((f) => f.score >= 80)
      .map((f) => {
        const days = f.last_aid_at
          ? Math.floor((Date.now() - new Date(f.last_aid_at).getTime()) / 86_400_000)
          : null;
        return {
          family_id: f.family_id,
          head_name: f.head_name,
          sector: f.location_sector,
          score: f.score,
          days_since_last_aid: days,
        };
      })
      .filter((f) => f.days_since_last_aid === null || f.days_since_last_aid >= 14)
      .sort((a, b) => (b.days_since_last_aid ?? 9999) - (a.days_since_last_aid ?? 9999))
      .slice(0, 5);

    // Audit log — soft-deleted families with their captured reason and
    // timestamp. Capped at 5 in the AI payload so the prompt stays
    // compact; the full list still renders on the dashboard card.
    const recentDeletions = deletedFamilies
      .slice(0, 5)
      .map((f) => ({
        family_id: f.family_id,
        head_name: f.head_name,
        sector: f.location_sector,
        deleted_at: f.deleted_at ?? null,
        reason: f.deletion_reason ?? '(no reason recorded)',
      }));

    return {
      generated_at: new Date().toISOString(),
      totals: {
        families: families.length,
        critical_priority: criticalCount,
        new_needs_flagged: families.filter((f) => f.new_need_flagged).length,
        deliveries_today: todayDistros.length,
        items_delivered_today: totalItemsToday,
        active_orders: activeOrders,
        pending_orders: distributions.filter((d) => d.status === 'pending').length,
        out_for_delivery_orders: distributions.filter((d) => d.status === 'out_for_delivery').length,
        delivered_lifetime: distributions.filter((d) => d.status === 'delivered').length,
        failed_lifetime: distributions.filter((d) => d.status === 'failed').length,
        stuck_24h: stuckOrders.length,
        sectors_active: sectorStats.size,
        workers_total: workers.length,
        families_deleted_total: deletedFamilies.length,
      },
      sectors: Array.from(sectorStats.entries())
        .map(([sector, s]) => ({ sector, ...s }))
        .sort((a, b) => b.critical - a.critical),
      top_critical_families: topCritical,
      stuck_orders: stuckOrders,
      recent_failures_or_cancellations: recentIssues,
      recent_family_deletions: recentDeletions,
      worker_workload: workerLoad,
      // AI-augmented signals
      items_velocity_7d: itemsVelocity,
      repeat_delivery_alerts_7d: repeatDeliveryAlerts,
      unserved_too_long_critical: unservedTooLong,
    };
  };

  // Deterministic, no-AI fallback. Always works offline.
  const ruleBasedSummary = (payload: ReturnType<typeof buildSummaryPayload>) => {
    // Pluralize helpers — picks the right form based on count.
    const plural = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
    const t = payload.totals;
    const lines: string[] = [];
    lines.push(`# Operations brief — ${new Date().toLocaleDateString()}`);
    lines.push('');
    lines.push('## Impact');
    lines.push(
      `- ${plural(t.deliveries_today, 'delivery', 'deliveries')} confirmed today (${plural(t.items_delivered_today, 'item', 'items')} total).`
    );
    lines.push(
      `- ${t.delivered_lifetime} lifetime deliveries across ${plural(t.sectors_active, 'sector', 'sectors')}; ${t.failed_lifetime} failed.`
    );
    lines.push(`- ${plural(t.families, 'family', 'families')} tracked, ${plural(t.workers_total, 'worker', 'workers')} on roster.`);
    lines.push('');
    lines.push('## Gaps');
    const gapsBefore = lines.length;
    if (t.critical_priority > 0)
      lines.push(`- ${plural(t.critical_priority, 'family', 'families')} currently at CRITICAL priority — need attention.`);
    if (t.new_needs_flagged > 0)
      lines.push(`- ${plural(t.new_needs_flagged, 'family', 'families')} flagged with a new urgent need on the last visit.`);
    if (t.stuck_24h > 0)
      lines.push(`- ${plural(t.stuck_24h, 'order', 'orders')} stuck in out-for-delivery for over 24h — investigate or reassign.`);
    if (payload.unserved_too_long_critical.length > 0) {
      lines.push(
        `- ${plural(payload.unserved_too_long_critical.length, 'critical family', 'critical families')} unserved 14+ days: ` +
          payload.unserved_too_long_critical
            .map(
              (f) =>
                `**${f.head_name}** (${f.sector}, ${f.days_since_last_aid === null ? 'never' : `${f.days_since_last_aid}d`})`
            )
            .join('; ') +
          '.'
      );
    }
    if (payload.repeat_delivery_alerts_7d.length > 0) {
      lines.push(
        `- Repeat-delivery to verify: ` +
          payload.repeat_delivery_alerts_7d
            .map((r) => `**${r.family}** received "${r.item}" ×${r.count} in 7d`)
            .join('; ') +
          '.'
      );
    }
    if (payload.recent_failures_or_cancellations.length > 0) {
      lines.push(
        `- Recent failures/cancellations: ${payload.recent_failures_or_cancellations
          .map((r) => `ORD-${r.order} (${r.family}${r.reason ? ` — ${r.reason}` : ''})`)
          .join('; ')}.`
      );
    }
    if (lines.length === gapsBefore) lines.push('- No major operational gaps detected.');
    lines.push('');
    lines.push('## Top critical families');
    for (const f of payload.top_critical_families) {
      const days = f.days_since_last_aid === null ? 'never' : `${f.days_since_last_aid}d ago`;
      lines.push(`- **${f.head_name}** (${f.family_id}, ${f.sector}) — score ${f.score}, last aid ${days}. ${f.reason}`);
    }
    lines.push('');
    lines.push('## Recommended next actions');
    const recBefore = lines.length;
    if (t.pending_orders > 0) lines.push(`- Dispatch the ${plural(t.pending_orders, 'pending order', 'pending orders')}.`);
    if (t.stuck_24h > 0) lines.push(`- Reach out on the ${plural(t.stuck_24h, 'stuck order', 'stuck orders')} — confirm delivery or mark failed.`);
    if (t.critical_priority > 0)
      lines.push(`- Prioritise the ${plural(t.critical_priority, 'CRITICAL family', 'CRITICAL families')} listed above for the next distribution session.`);
    if (payload.worker_workload[0]?.active >= 2)
      lines.push(`- Workload is concentrated on ${payload.worker_workload[0].name} (${payload.worker_workload[0].active} active) — consider rebalancing.`);
    if (payload.items_velocity_7d.length > 0) {
      const top = payload.items_velocity_7d[0];
      lines.push(
        `- Supply pacing (last 7d): top item is **${top.item}** at ${top.qty_per_day}/day (${top.qty_7d} this week) — review stock and reorder lead time.`
      );
    }
    if (lines.length === recBefore) lines.push('- Operations are steady; continue current cadence.');

    // Registry hygiene — recent family deletions with their audit reason.
    // Rendered as its own section so donors / auditors can see *why* a row
    // disappeared from the active list without digging through IndexedDB.
    if (payload.recent_family_deletions.length > 0) {
      lines.push('');
      lines.push('## Registry deletions');
      for (const d of payload.recent_family_deletions) {
        const when = d.deleted_at
          ? new Date(d.deleted_at).toLocaleDateString()
          : 'unknown date';
        lines.push(
          `- **${d.head_name}** (${d.family_id}, ${d.sector}) — deleted ${when}. Reason: ${d.reason}.`
        );
      }
      if (payload.totals.families_deleted_total > payload.recent_family_deletions.length) {
        lines.push(
          `- +${
            payload.totals.families_deleted_total - payload.recent_family_deletions.length
          } more in the registry.`
        );
      }
    }
    return lines.join('\n');
  };

  const generateSummary = async () => {
    if (generating) return;
    setGenerating(true);
    setSummary('');
    setSummaryError(null);
    setSummarySource(null);

    const payload = buildSummaryPayload();

    // Probe Ollama first so we can fall back gracefully.
    const reachable = await pingOllama();
    if (!reachable) {
      setSummary(ruleBasedSummary(payload));
      setSummarySource('rules');
      setSummaryError('Ollama is not reachable at localhost:11434 — showing a rule-based summary instead. Start Ollama (with `OLLAMA_ORIGINS=*`) and click again for the AI version.');
      setGenerating(false);
      return;
    }

    const langName =
      language === 'ar'
        ? 'Arabic'
        : language === 'fr'
        ? 'French'
        : language === 'es'
        ? 'Spanish'
        : 'English';

    // Compact system prompt — short and direct so the model spends its
    // tokens on the brief itself, not on parroting back instructions. We
    // pre-compute a few summary lines so the model doesn't have to re-derive
    // them, and pass the full JSON only as reference for citations.
    const t2 = payload.totals;
    const briefingFacts = [
      `Today: ${t2.deliveries_today} deliveries, ${t2.items_delivered_today} items.`,
      `Active: ${t2.pending_orders} pending + ${t2.out_for_delivery_orders} out-for-delivery (${t2.stuck_24h} stuck >24h).`,
      `Families: ${t2.families} tracked, ${t2.critical_priority} CRITICAL, ${t2.new_needs_flagged} flagged with new urgent need.`,
      `Lifetime: ${t2.delivered_lifetime} delivered, ${t2.failed_lifetime} failed.`,
      `Sectors: ${t2.sectors_active}. Workers: ${t2.workers_total}.`,
      `Registry hygiene: ${t2.families_deleted_total} families soft-deleted (latest ${payload.recent_family_deletions.length} listed below).`,
    ].join(' ');

    const systemPrompt =
      `You are AidFlow Pro's reporting AI. Respond in ${langName}. ` +
      `Write a director-style executive brief in markdown with EXACTLY these sections, in this order: ` +
      `## Impact, ## Gaps & risks, ## Top critical cases, ## Recommended actions, ## Registry deletions. ` +
      `Each section MUST be filled out — never leave a section empty or with a single bullet. Aim for 4-6 substantive bullet points per section, EXCEPT ## Registry deletions which has one bullet per deleted family. ` +
      `Cite real family names, family_ids, sectors, order numbers, worker names, and item names from the JSON below. ` +
      `## Impact — cover deliveries today, items distributed, lifetime delivered count, sectors active, and any new-needs flags. ` +
      `## Gaps & risks — cover stuck_orders >24h, repeat_delivery_alerts_7d (same family + same item 3+ times in a week — flag for review), unserved_too_long_critical (critical families with no aid in 14+ days), recent failed/cancelled orders, and worker-load imbalance. ` +
      `## Top critical cases — list the top 3-5 critical families with name, family_id, sector, score, and last-aid recency, plus their reason. ` +
      `## Recommended actions — give 4-6 concrete next steps. Name the highest-paced item from items_velocity_7d with its qty/day so procurement can react. Reference specific stuck orders or unserved families by id when proposing follow-up. ` +
      `## Registry deletions — one bullet per entry in recent_family_deletions. EACH BULLET MUST INCLUDE: the head_name, the family_id, the sector, the deletion date (from deleted_at), and the verbatim reason. Format: **{head_name}** ({family_id}, {sector}) — deleted {date}. Reason: "{reason}". If recent_family_deletions is empty, write exactly: "- No families have been deleted from the registry." ` +
      `Never invent data; if a signal is genuinely empty, briefly note "none" rather than skipping the section. Aim for 500-700 words total. Plain markdown only — no tables, no code fences, no preamble. ` +
      `Start your response directly with "## Impact".`;

    const userPrompt =
      `Snapshot summary: ${briefingFacts}\n\n` +
      `Full JSON snapshot for citations:\n` +
      JSON.stringify(payload);

    try {
      let acc = '';
      for await (const delta of chatStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.4, maxTokens: 2048 }
      )) {
        acc += delta;
        setSummary(acc);
      }
      // Strip any leading whitespace / preamble before the first markdown
      // heading so the rendered document always starts cleanly.
      const cleaned = acc.replace(/^[\s\S]*?(?=## )/, '').trim();
      if (!cleaned) {
        setSummary(ruleBasedSummary(payload));
        setSummarySource('rules');
        setSummaryError('The local AI returned an empty response — showing a rule-based summary instead.');
      } else {
        setSummary(cleaned);
        setSummarySource('ai');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSummary(ruleBasedSummary(payload));
      setSummarySource('rules');
      setSummaryError(`AI request failed: ${msg}. Showing a rule-based summary instead.`);
    } finally {
      setGenerating(false);
    }
  };

  // ---- Render -------------------------------------------------------------
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 size={22} />
          {t('nav.dashboard')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">{new Date().toLocaleDateString()}</p>
      </header>

      {/* AI Executive Summary — placed at the top so it's the first thing
          the admin sees on landing. Export PDF lives here too, right next to
          Regenerate, and only appears once a summary has actually been
          generated. */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-ai" /> AI Executive Summary
            {summarySource === 'ai' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ai/15 text-ai font-semibold">
                AI
              </span>
            )}
            {summarySource === 'rules' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-priority-medium/15 text-priority-medium font-semibold flex items-center gap-1">
                <WifiOff size={10} /> Rule-based fallback
              </span>
            )}
          </div>
        }
        action={
          <div className="flex items-center gap-2">
            {summary && !generating && (
              <button
                onClick={exportSummaryAsPdf}
                title={t('reports.export_pdf', 'Export PDF')}
                className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark rounded-lg text-xs flex items-center gap-1 font-semibold"
              >
                <Download size={12} /> {t('reports.export_pdf', 'Export PDF')}
              </button>
            )}
            <button
              onClick={() => void generateSummary()}
              disabled={generating}
              className="touch-target px-3 py-1.5 bg-ai hover:bg-violet-600 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1 font-semibold"
            >
              {generating ? (
                <Loading />
              ) : summary ? (
                <RefreshCw size={12} />
              ) : (
                <Sparkles size={12} />
              )}
              {generating
                ? 'Generating…'
                : summary
                ? 'Regenerate'
                : t('reports.summary')}
            </button>
          </div>
        }
      >
        {summaryError && (
          <div className="mb-3 text-xs px-3 py-2 rounded-lg bg-priority-medium/10 border border-priority-medium/30 text-priority-medium flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{summaryError}</span>
          </div>
        )}
        {summary ? (
          <div className="prose-ai text-sm text-slate-200 leading-relaxed break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
          </div>
        ) : generating ? (
          <p className="text-sm text-slate-500 italic">Drafting the executive brief…</p>
        ) : (
          <p className="text-sm text-slate-500">{t('reports.summary_placeholder')}</p>
        )}
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          label={t('dashboard.kpi_families')}
          value={todayDistros.length}
          hint={`${families.length} families tracked`}
          accent="brand"
          icon={<Users size={18} />}
        />
        <StatCard
          label="Active orders"
          value={activeOrders}
          hint="pending + out for delivery"
          accent="medium"
          icon={<Package size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_items')}
          value={totalItemsToday}
          hint={`${distributions.filter((d) => d.status === 'delivered').length} delivered all-time`}
          accent="normal"
          icon={<Package size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_critical')}
          value={criticalCount}
          hint={`${scored.filter((f) => f.level === 'HIGH').length} high priority`}
          accent="critical"
          icon={<AlertTriangle size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_ai_status')}
          value={
            <span className="text-base">
              {conn.ollamaUp ? '✓ AidFlow AI' : '— offline'}
            </span>
          }
          hint={aiStatus}
          accent={conn.ollamaUp ? 'ai' : 'medium'}
          icon={<Sparkles size={18} />}
        />
      </div>

      {/* Priority + sector charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card title={t('dashboard.priority_distribution')}>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={priorityDist}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {priorityDist.map((p) => (
                    <Cell key={p.level} fill={PRIORITY_COLORS[p.level]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: '#1e293b',
                    border: '1px solid #475569',
                    borderRadius: 8,
                    color: '#f1f5f9',
                  }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={t('reports.by_sector')}>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={sectorData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--slate-700))" />
                <XAxis
                  dataKey="sector"
                  stroke="rgb(var(--slate-500))"
                  tick={{ fontSize: 11, fill: 'rgb(var(--slate-300))' }}
                />
                <YAxis stroke="rgb(var(--slate-500))" tick={{ fill: 'rgb(var(--slate-300))' }} />
                <Tooltip
                  contentStyle={{
                    background: 'rgb(var(--surface))',
                    border: '1px solid rgb(var(--slate-700))',
                    borderRadius: 8,
                    color: 'rgb(var(--slate-200))',
                  }}
                />
                <Bar dataKey="count" fill="#00ADB5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Distributions over time (from /reports) */}
      <Card title={t('reports.over_time')}>
        <div style={{ height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={timeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--slate-700))" />
              <XAxis
                dataKey="day"
                stroke="rgb(var(--slate-500))"
                tick={{ fontSize: 11, fill: 'rgb(var(--slate-300))' }}
              />
              <YAxis stroke="rgb(var(--slate-500))" tick={{ fill: 'rgb(var(--slate-300))' }} />
              <Tooltip
                contentStyle={{
                  background: 'rgb(var(--surface))',
                  border: '1px solid rgb(var(--slate-700))',
                  color: 'rgb(var(--slate-200))',
                }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Recent distributions (from old /dashboard) */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-ai" />
            {t('dashboard.recent_distributions')}
          </div>
        }
        action={
          <Link to="/families" className="text-xs text-brand hover:underline">
            {t('dashboard.view_all')} →
          </Link>
        }
      >
        {recentDistros.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">No distributions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-700">
            {recentDistros.map((d) => {
              const family = families.find((f) => f.family_id === d.family_id);
              return (
                <li key={d.distribution_id} className="py-3 flex items-center gap-3">
                  <Activity size={16} className="text-brand flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {family?.head_name ?? d.family_id}{' '}
                      <span className="text-slate-500">— {d.family_id}</span>
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {d.items_distributed
                        .map((i) => `${i.item_name} ×${i.quantity}`)
                        .join(', ')}
                    </div>
                  </div>
                  <PriorityBadge
                    level={levelFromScore(d.ai_priority_score)}
                    score={d.ai_priority_score}
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Recent family deletions — audit log. Every soft-deleted family
          (db.families row with deleted_at set) shows up here with the
          admin-captured reason. The list pulls from a sibling live query
          so it updates in real time when an admin clicks Delete in the
          Families tab. We only render the section when at least one
          deletion exists — no empty-state clutter on a fresh install. */}
      {deletedFamilies.length > 0 && (
        <Card
          title={
            <div className="flex items-center gap-2">
              <Trash2 size={16} className="text-priority-critical" />
              {t('dashboard.recent_deletions') ?? 'Recent family deletions'}
              <span className="text-xs text-slate-500 font-normal">
                ({deletedFamilies.length})
              </span>
            </div>
          }
        >
          <ul className="divide-y divide-slate-700">
            {deletedFamilies.slice(0, 10).map((f) => {
              const deletedDate = f.deleted_at
                ? new Date(f.deleted_at)
                : null;
              return (
                <li key={f.family_id} className="py-3 flex items-start gap-3">
                  <Trash2
                    size={14}
                    className="text-priority-critical flex-shrink-0 mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {f.head_name}{' '}
                      <span className="text-slate-500">— {f.family_id}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      <span className="text-slate-500 me-1">
                        {t('dashboard.deletion_reason') ?? 'Reason:'}
                      </span>
                      {f.deletion_reason || (
                        <span className="italic text-slate-600">
                          {t('dashboard.deletion_reason_missing') ??
                            '(no reason recorded)'}
                        </span>
                      )}
                    </div>
                    {deletedDate && (
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {t('dashboard.deleted_at') ?? 'Deleted'}{' '}
                        {deletedDate.toLocaleDateString()}
                        {' · '}
                        {deletedDate.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {deletedFamilies.length > 10 && (
            <p className="text-[11px] text-slate-500 mt-2 italic">
              {t('dashboard.deletions_more', {
                count: deletedFamilies.length - 10,
              }) ?? `+${deletedFamilies.length - 10} more in the registry.`}
            </p>
          )}
        </Card>
      )}

    </div>
  );
}
