import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Database, Users, Package, BookOpen, HelpCircle, Smile, Map as MapIcon, MessageSquare } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import AIChat from '@/components/AIChat';
import { Card } from '@/components/Card';
import { db } from '@/db/database';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildSystemPrompt } from '@/services/aiContext';

export default function Assistant() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);

  // Live queries: any change to underlying tables triggers a re-render
  // and the system prompt is rebuilt automatically.
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const distributions = useLiveQuery(() => db.distributions.toArray()) ?? [];
  const documents = useLiveQuery(() => db.documents.toArray()) ?? [];
  const guides = useLiveQuery(() => db.guides.toArray()) ?? [];
  const kids = useLiveQuery(() => db.kids.toArray()) ?? [];
  const providers = useLiveQuery(() => db.providers.toArray()) ?? [];
  const messages = useLiveQuery(() => db.messages.toArray()) ?? [];

  const systemPrompt = useMemo(
    () =>
      buildSystemPrompt(
        { families, distributions, documents, guides, kids, providers, messages },
        { language }
      ),
    [families, distributions, documents, guides, kids, providers, messages, language]
  );

  const dataChips: { icon: React.ReactNode; label: string; count: number }[] = [
    { icon: <Users size={11} />, label: 'families', count: families.length },
    { icon: <Package size={11} />, label: 'distributions', count: distributions.length },
    { icon: <BookOpen size={11} />, label: 'PDFs', count: documents.length },
    { icon: <HelpCircle size={11} />, label: 'guides', count: guides.length },
    { icon: <Smile size={11} />, label: 'kids', count: kids.length },
    { icon: <MapIcon size={11} />, label: 'providers', count: providers.length },
    { icon: <MessageSquare size={11} />, label: 'messages', count: messages.length },
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
        />

        <aside className="hidden lg:block space-y-4">
          <Card title={t('assistant.examples.title')}>
            <ul className="text-sm space-y-2">
              {(['q1', 'q2', 'q3'] as const).map((k) => (
                <li
                  key={k}
                  className="bg-surface-light p-3 rounded-lg text-slate-300 hover:text-white cursor-pointer"
                  onClick={() => navigator.clipboard.writeText(t(`assistant.examples.${k}`))}
                  title="Click to copy"
                >
                  {t(`assistant.examples.${k}`)}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Try asking">
            <ul className="text-xs text-slate-300 space-y-1.5 list-disc list-inside">
              <li>List all critical-priority families with pregnant members.</li>
              <li>Which Starlink provider closest to Sector-B-North has strong signal?</li>
              <li>What's in our aid guide for water purification tablets?</li>
              <li>Summarize today's distributions by sector.</li>
              <li>What kids content do we have for ages 6-10?</li>
              <li>Show me the latest Bitchat messages on #medical-team.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
