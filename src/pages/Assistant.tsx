import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sparkles,
  Database,
  Users,
  UserCircle,
  Package,
  BookOpen,
  HelpCircle,
  Smile,
  Globe,
  Store,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import AIChat from '@/components/AIChat';
import { Card } from '@/components/Card';
import { db } from '@/db/database';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildSystemPrompt } from '@/services/aiContext';
import { COUNTRIES as STARLINK_COUNTRIES } from '@/services/starlinkCountries';

// Capability self-description shown when the admin clicks the
// "Ask me what I can do?" suggested prompt in the chat. Hand-authored
// (instead of generated) so it stays accurate, instant, and offline-safe.
const ASSISTANT_CAPABILITIES_REPLY = `Here's what I can help you with — all answered offline using **Gemma 4** running locally on this machine.

## Coordinator decision support
- **Morning briefing** — summarize yesterday vs today, surface what needs attention before noon.
- **Demand pacing** — name the highest-velocity items so procurement can react before stock runs out.
- **Anomaly review** — flag stuck orders, repeat deliveries to the same family, possible duplicate registrations, worker-load imbalance.

## Family registry & priorities
- Ranked priority list with explanations for each score.
- Look up any family by name or family ID; show composition, medical flags, displacement, current needs (with quantities).
- Distribution history: "When did the Hassan family last receive food?", "What was given on the last visit?" — answers grounded in the actual ledger.
- Propose record edits (sector, displacement, current needs) that you Apply or Discard before any write.

## Distribution ledger
- Look up any order by \`ORD-NNNN\` or distribution ID.
- Status of pending / out-for-delivery / delivered / failed / cancelled orders.
- Per-worker active workload right now.
- Today's deliveries broken down by sector, by worker, or by item.

## Workers
- Roster lookup (first / last name, position, email, address).
- Who's busy out for delivery, who's available to take a new order.

## Knowledge Base (uploaded PDFs)
- Retrieval-augmented answers with **source citations** — e.g. *"What's the oral rehydration ratio for a 2-year-old?"*
- Per-document summaries on demand (use the **Summarize** button on each PDF).
- Cross-document synthesis across your whole library at once.

## Starlink reference
- Country availability (live / coming soon / waitlist / unavailable).
- Authorized resellers grouped by continent and country.

## Languages
- I respond in **English, Arabic (RTL), French, or Spanish** depending on your UI setting.

To get started, click any prompt on the right or just type a question.`;

// "Try asking" sidebar — three categories the admin should reach for first,
// two prompts each. Click a prompt to copy it to the clipboard, then paste
// it into the chat input. Kept at file scope so the array isn't rebuilt on
// every render.
const PROMPT_GROUPS: ReadonlyArray<{ label: string; prompts: readonly string[] }> = [
  {
    label: 'Morning briefing',
    prompts: [
      'Give me a 4-sentence briefing on yesterday vs today.',
      "List critical-priority families that haven't received aid in 14+ days.",
    ],
  },
  {
    label: 'Demand pacing',
    prompts: [
      "What's our highest-velocity item this week, and at what daily rate?",
      'If our pace holds, what should procurement reorder first?',
    ],
  },
  {
    label: 'Anomaly review',
    prompts: [
      'Any families that received the same item 3+ times in the last 7 days?',
      'Are there orders stuck out for delivery for more than 24 hours?',
    ],
  },
];

export default function Assistant() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);

  // Live queries: any change to underlying tables triggers a re-render
  // and the system prompt is rebuilt automatically.
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const distributions = useLiveQuery(() => db.distributions.toArray()) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray()) ?? [];
  const documents = useLiveQuery(() => db.documents.toArray()) ?? [];
  const guides = useLiveQuery(() => db.guides.toArray()) ?? [];
  const kids = useLiveQuery(() => db.kids.toArray()) ?? [];
  const resellers = useLiveQuery(() => db.resellers.toArray()) ?? [];

  const systemPrompt = useMemo(
    () =>
      buildSystemPrompt(
        { families, distributions, workers, documents, guides, kids, resellers },
        { language }
      ),
    [families, distributions, workers, documents, guides, kids, resellers, language]
  );

  const dataChips: { icon: React.ReactNode; label: string; count: number }[] = [
    { icon: <Users size={11} />, label: 'families', count: families.length },
    { icon: <Package size={11} />, label: 'distributions', count: distributions.length },
    { icon: <UserCircle size={11} />, label: 'workers', count: workers.length },
    { icon: <BookOpen size={11} />, label: 'PDFs', count: documents.length },
    { icon: <HelpCircle size={11} />, label: 'guides', count: guides.length },
    { icon: <Smile size={11} />, label: 'kids', count: kids.length },
    { icon: <Globe size={11} />, label: 'Starlink countries', count: STARLINK_COUNTRIES.length },
    { icon: <Store size={11} />, label: 'Starlink retailers', count: resellers.length },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] gap-4">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="text-ai" size={22} />
          {t('assistant.title')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">{t('assistant.system_note')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300">
          <Database size={12} className="text-ai" />
          <span className="text-ai font-medium me-1">Loaded into context:</span>
          {dataChips.map((c) => (
            <span
              key={c.label}
              className="inline-flex items-center gap-1 bg-surface-light px-2 py-0.5 rounded-full"
            >
              {c.icon} {c.count} {c.label}
            </span>
          ))}
        </div>
      </header>

      <div className="grid lg:grid-cols-[1fr_280px] gap-4 flex-1 min-h-0">
        <AIChat
          systemPrompt={systemPrompt}
          enableRag
          placeholder={t('assistant.placeholder')}
          suggestedPrompts={[
            {
              label: 'Ask me what I can do?',
              reply: ASSISTANT_CAPABILITIES_REPLY,
            },
          ]}
        />

        <aside className="hidden lg:block">
          <Card title="Try asking">
            <div className="space-y-4">
              {PROMPT_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] uppercase tracking-wider text-ai font-semibold mb-1.5">
                    {group.label}
                  </div>
                  <ul className="space-y-1.5">
                    {group.prompts.map((p) => (
                      <li
                        key={p}
                        className="bg-surface-light p-2 rounded-md text-xs text-slate-300 hover:text-white cursor-pointer leading-snug"
                        onClick={() => navigator.clipboard.writeText(p)}
                        title="Click to copy"
                      >
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
