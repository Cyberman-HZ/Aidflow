import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smile, Upload, Image as ImageIcon, Film, FileText, BookOpen } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import type { KidsContent as KidsItem } from '@/types';

export default function KidsContentPage() {
  const { t } = useTranslation();
  const [age, setAge] = useState<KidsItem['age_group'] | ''>('');
  const [lang, setLang] = useState<KidsItem['language'] | ''>('');

  const items = useLiveQuery(() => db.kids.toArray(), []) ?? [];
  const filtered = items.filter(
    (it) => (!age || it.age_group === age) && (!lang || it.language === lang)
  );

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const data_url = reader.result as string;
      const type: KidsItem['type'] = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
        ? 'video'
        : file.type === 'application/pdf'
        ? 'pdf'
        : 'story';
      await db.kids.add({
        content_id: `K-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: file.name,
        age_group: '6-10',
        language: 'en',
        type,
        data_url,
        mime: file.type,
        uploaded_at: new Date().toISOString(),
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Smile size={22} className="text-priority-medium" />
          {t('kids.title')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">{t('kids.subtitle')}</p>
      </header>

      <Card>
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={age}
            onChange={(e) => setAge(e.target.value as KidsItem['age_group'] | '')}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('kids.all_ages')}</option>
            <option value="0-5">0–5</option>
            <option value="6-10">6–10</option>
            <option value="11-15">11–15</option>
          </select>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as KidsItem['language'] | '')}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('kids.all_languages')}</option>
            <option value="en">EN</option>
            <option value="ar">AR</option>
            <option value="fr">FR</option>
            <option value="es">ES</option>
          </select>
          <label className="touch-target cursor-pointer ms-auto px-3 py-2 bg-brand hover:bg-brand-dark rounded-lg text-sm flex items-center gap-2 font-semibold">
            <Upload size={14} /> {t('kids.upload')}
            <input
              type="file"
              accept="image/*,video/*,application/pdf,text/plain"
              onChange={onUpload}
              className="hidden"
            />
          </label>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card><EmptyState icon={<Smile size={28} />} title={t('kids.no_content')} /></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c) => <KidsCard key={c.content_id} item={c} />)}
        </div>
      )}
    </div>
  );
}

function KidsCard({ item }: { item: KidsItem }) {
  const Icon = item.type === 'image' ? ImageIcon : item.type === 'video' ? Film : item.type === 'pdf' ? FileText : BookOpen;
  return (
    <article className="bg-surface border border-slate-700 rounded-xl overflow-hidden">
      <div className="aspect-video bg-surface-deep grid place-items-center">
        {item.type === 'image' ? (
          <img src={item.data_url} alt={item.title} className="object-contain max-h-full" />
        ) : item.type === 'video' ? (
          <video src={item.data_url} controls className="max-h-full" />
        ) : (
          <Icon size={40} className="text-slate-500" />
        )}
      </div>
      <div className="p-3">
        <div className="font-medium text-sm truncate">{item.title}</div>
        <div className="text-xs text-slate-400 flex gap-2 mt-1">
          <span className="bg-surface-light px-2 rounded">{item.age_group}</span>
          <span className="bg-surface-light px-2 rounded uppercase">{item.language}</span>
          <span className="bg-surface-light px-2 rounded capitalize">{item.type}</span>
        </div>
        {item.type === 'story' && (
          <details className="mt-2 text-xs text-slate-300">
            <summary className="cursor-pointer">Read story</summary>
            <p className="mt-1 whitespace-pre-wrap">{atob(item.data_url.split(',')[1] || '')}</p>
          </details>
        )}
      </div>
    </article>
  );
}
