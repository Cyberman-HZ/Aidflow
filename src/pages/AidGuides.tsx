import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Sparkles, BookOpen } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import AIChat from '@/components/AIChat';
import type { AidGuide } from '@/types';

export default function AidGuides() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AidGuide | null>(null);

  const guides = useLiveQuery(() => db.guides.toArray(), []) ?? [];
  const filtered = guides.filter(
    (g) =>
      !search ||
      g.item_name.toLowerCase().includes(search.toLowerCase()) ||
      g.body.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t('guides.title')}</h1>
        <p className="text-sm text-slate-400 mt-1">{t('guides.subtitle')}</p>
      </header>

      <Card>
        <div className="relative">
          <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('guides.search')}
            className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-9 pe-3 py-2 text-sm focus:border-brand outline-none touch-target"
          />
        </div>
      </Card>

      <div className="grid lg:grid-cols-[1fr_400px] gap-5">
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <Card>
              <EmptyState icon={<BookOpen size={28} />} title={t('guides.no_guides')} />
            </Card>
          ) : (
            filtered.map((g) => (
              <article
                key={g.guide_id}
                className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
                  selected?.guide_id === g.guide_id
                    ? 'border-ai/50 ring-1 ring-ai/30'
                    : 'border-slate-700 hover:border-brand/40'
                }`}
                onClick={() => setSelected(g)}
              >
                <h3 className="font-semibold text-base">{g.item_name}</h3>
                <div className="text-xs text-slate-400 mt-1 flex gap-2">
                  <span className="bg-surface-light px-2 py-0.5 rounded capitalize">{g.category}</span>
                  <span className="bg-surface-light px-2 py-0.5 rounded uppercase">{g.language}</span>
                </div>
                <pre className="text-sm text-slate-200 whitespace-pre-wrap font-sans mt-3">
                  {g.body}
                </pre>
              </article>
            ))
          )}
        </div>

        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            {selected ? t('guides.ask_gemma') : 'Ask Gemma 4 about any guide'}
          </h2>
          <AIChat
            enableRag={false}
            flex={false}
            systemPrompt={
              selected
                ? `You are AidFlow Pro's guide assistant powered by Gemma 4. The field worker is asking about the "${selected.item_name}" guide. Guide content:\n\n${selected.body}\n\nAnswer questions about this specific item — usage, dosing, safety, troubleshooting. Be concise and practical.`
                : `You are AidFlow Pro's guide assistant powered by Gemma 4. Help the field worker understand how to use distributed aid items. Be concise and practical.`
            }
          />
        </div>
      </div>
    </div>
  );
}
