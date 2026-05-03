import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, FileText, Trash2, BookOpen, Sparkles } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { ingestPdf } from '@/services/rag';
import { useAuthStore } from '@/stores/authStore';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import AIChat from '@/components/AIChat';
import type { KnowledgeDocument } from '@/types';

const CATEGORIES: KnowledgeDocument['category'][] = [
  'medical',
  'food',
  'shelter',
  'water',
  'protection',
  'general',
];

export default function KnowledgeBase() {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const user = useAuthStore((s) => s.user);

  const [uploading, setUploading] = useState<string | null>(null);
  const [phase, setPhase] = useState<'extract' | 'embed' | 'save' | null>(null);
  const [pendingTitle, setPendingTitle] = useState('');
  const [pendingCategory, setPendingCategory] = useState<KnowledgeDocument['category']>('general');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const docs = useLiveQuery(() => db.documents.toArray(), []) ?? [];

  const onPick = (f: File) => {
    setPendingFile(f);
    setPendingTitle(f.name.replace(/\.pdf$/i, ''));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/pdf') onPick(file);
  };

  const upload = async () => {
    if (!pendingFile || !user) return;
    setUploading(pendingFile.name);
    setPhase('extract');
    try {
      // We can't observe phases from inside ingestPdf without a callback API,
      // so we do a small, decorative phase progression based on time.
      const promise = ingestPdf(pendingFile, {
        title: pendingTitle.trim() || pendingFile.name,
        category: pendingCategory,
        uploaded_by: user.user_id,
      });
      setTimeout(() => setPhase('embed'), 600);
      const result = await promise;
      setPhase('save');
      await new Promise((r) => setTimeout(r, 200));
      console.log('[KnowledgeBase] ingested', result.doc_id, result.chunks.length, 'chunks');
    } catch (e) {
      console.error('[KnowledgeBase] ingest failed', e);
      alert('Failed to process PDF: ' + (e as Error).message);
    } finally {
      setUploading(null);
      setPhase(null);
      setPendingFile(null);
      setPendingTitle('');
    }
  };

  const remove = async (doc: KnowledgeDocument) => {
    if (!confirm(`Delete "${doc.title}"?`)) return;
    await db.documents.delete(doc.doc_id);
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t('knowledge.title')}</h1>
        <p className="text-sm text-slate-400 mt-1">{t('knowledge.subtitle')}</p>
      </header>

      <Card>
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-slate-600 hover:border-brand rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="mx-auto mb-3 text-slate-500" size={28} />
          <p className="text-sm text-slate-300">{t('knowledge.drop_zone')}</p>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
          />
        </div>

        {pendingFile && !uploading && (
          <div className="mt-4 space-y-3">
            <div className="bg-surface-light px-3 py-2 rounded-lg text-sm flex items-center gap-2">
              <FileText size={16} className="text-brand" />
              <span className="flex-1 truncate">{pendingFile.name}</span>
              <span className="text-xs text-slate-400">
                {(pendingFile.size / 1024).toFixed(0)} KB
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t('knowledge.title_label')}</label>
                <input
                  value={pendingTitle}
                  onChange={(e) => setPendingTitle(e.target.value)}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t('knowledge.category')}</label>
                <select
                  value={pendingCategory}
                  onChange={(e) => setPendingCategory(e.target.value as KnowledgeDocument['category'])}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{t(`knowledge.categories.${c}`)}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              onClick={() => void upload()}
              className="touch-target w-full sm:w-auto px-4 py-2 bg-brand text-white rounded-lg font-semibold flex items-center justify-center gap-2"
            >
              <Upload size={16} /> Upload & process
            </button>
          </div>
        )}

        {uploading && (
          <div className="mt-4 bg-ai/10 border border-ai/30 rounded-lg p-3 text-sm">
            <div className="font-medium text-ai mb-1">
              {t('knowledge.uploading', { name: uploading })}
            </div>
            <div className="text-xs text-slate-400">
              {phase === 'extract' && t('knowledge.extracting')}
              {phase === 'embed' && t('knowledge.embedding')}
              {phase === 'save' && t('knowledge.saving')}
            </div>
            <div className="mt-2 h-1 bg-surface-light rounded overflow-hidden">
              <div
                className="h-full bg-ai transition-all duration-700"
                style={{ width: phase === 'extract' ? '33%' : phase === 'embed' ? '66%' : '100%' }}
              />
            </div>
          </div>
        )}
      </Card>

      <div className="grid lg:grid-cols-[1fr_400px] gap-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">Library ({docs.length})</h2>
          {docs.length === 0 ? (
            <Card>
              <EmptyState
                icon={<BookOpen size={28} />}
                title={t('knowledge.no_docs')}
                body="Upload a PDF protocol to get started."
              />
            </Card>
          ) : (
            docs
              .slice()
              .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
              .map((d) => (
                <div
                  key={d.doc_id}
                  className="bg-surface border border-slate-700 rounded-xl p-4 flex items-start gap-3"
                >
                  <FileText className="text-ai flex-shrink-0 mt-0.5" size={20} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{d.title}</div>
                    <div className="text-xs text-slate-400 flex flex-wrap gap-2 mt-0.5">
                      <span className="capitalize bg-surface-light px-2 py-0.5 rounded">
                        {t(`knowledge.categories.${d.category}`)}
                      </span>
                      <span>{t('knowledge.pages', { n: d.page_count })}</span>
                      <span>{t('knowledge.chunks', { n: d.chunks.length })}</span>
                      <span>{new Date(d.uploaded_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(d)}
                    className="touch-target p-2 hover:bg-red-500/10 hover:text-red-400 rounded-lg"
                    aria-label={t('knowledge.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
          )}
        </div>

        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            {t('knowledge.ask_question')}
          </h2>
          <AIChat enableRag flex={false} />
        </div>
      </div>
    </div>
  );
}
