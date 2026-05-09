// Knowledge Base — single-section page for the PDF document library.
// All knowledge surfaces as PDFs uploaded into the same library here.
//
// Aid-guide data (db.guides) is still seeded and continues to feed the
// AidFlow Assistant's system context (see services/aiContext.ts), so the
// AI can still answer aid-item how-to questions even though there is no
// dedicated UI for managing guides any more.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Upload,
  FileText,
  Trash2,
  BookOpen,
  Sparkles,
  Search,
  X as XIcon,
  ScrollText,
  AlertTriangle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { ingestPdf, summarizeDocumentStream } from '@/services/rag';
import { useSettingsStore } from '@/stores/settingsStore';
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

  const docs = useLiveQuery(() => db.documents.toArray(), []) ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t('knowledge.title')}</h1>
        <p className="text-sm text-slate-400 mt-1">{t('knowledge.subtitle')}</p>
      </header>

      <div className="grid lg:grid-cols-[1fr_400px] gap-5">
        <div className="space-y-3">
          <DocumentsSection docs={docs} />
        </div>

        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            {t('knowledge.ask_question')}
          </h2>
          <AIChat enableRag forceRag flex={false} />
        </div>
      </div>
    </div>
  );
}

// ===== Documents section =================================================

// One in-flight summary (open card) at a time.
type SummaryState = {
  docId: string;
  text: string;
  truncated: boolean;
  done: boolean;
  error?: string;
};

function DocumentsSection({ docs }: { docs: KnowledgeDocument[] }) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const user = useAuthStore((s) => s.user);
  const language = useSettingsStore((s) => s.language);

  const [summary, setSummary] = useState<SummaryState | null>(null);
  const summaryBusy = useRef(false);

  const startSummary = async (doc: KnowledgeDocument) => {
    if (summaryBusy.current) return;
    summaryBusy.current = true;
    setSummary({ docId: doc.doc_id, text: '', truncated: false, done: false });
    try {
      for await (const ev of summarizeDocumentStream(doc.doc_id, language)) {
        if (ev.kind === 'delta') {
          setSummary((s) =>
            s && s.docId === doc.doc_id ? { ...s, text: s.text + ev.text } : s
          );
        } else if (ev.kind === 'done') {
          setSummary((s) =>
            s && s.docId === doc.doc_id
              ? { ...s, done: true, truncated: ev.truncated }
              : s
          );
        }
      }
    } catch (e) {
      console.error('[KnowledgeBase] summarize failed', e);
      setSummary((s) =>
        s && s.docId === doc.doc_id
          ? {
              ...s,
              done: true,
              error:
                e instanceof Error
                  ? e.message
                  : 'Summary failed. Make sure Ollama is running with the gemma4:e4b model.',
            }
          : s
      );
    } finally {
      summaryBusy.current = false;
    }
  };

  const closeSummary = () => setSummary(null);

  const [uploading, setUploading] = useState<string | null>(null);
  const [phase, setPhase] = useState<'extract' | 'embed' | 'save' | null>(null);
  // Fractional embed progress (0..1) reported by ingestPdf via onPhase.
  // Drives the progress bar so the bar reflects real work instead of a
  // fake setTimeout(600) jumping the bar backward on fast uploads.
  const [embedProgress, setEmbedProgress] = useState(0);
  const [pendingTitle, setPendingTitle] = useState('');
  const [pendingCategory, setPendingCategory] =
    useState<KnowledgeDocument['category']>('general');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // In-app modals (replace browser alert / confirm).
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [confirmDelete, setConfirmDelete] =
    useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Library search — case-insensitive, trimmed, matches title/category/
  // filename + chunk text. Uses a pre-lowercased docIndex so each
  // keystroke is O(N) instead of O(N×M) over chunk text.
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const docIndex = useMemo(() => {
    const idx = new Map<string, { meta: string; content: string }>();
    for (const d of docs) {
      const meta = [d.title, d.category, d.source_filename ?? '']
        .join(' … ')
        .toLowerCase();
      const content = Array.isArray(d.chunks)
        ? d.chunks.map((c) => c.text).join(' ').toLowerCase()
        : '';
      idx.set(d.doc_id, { meta, content });
    }
    return idx;
  }, [docs]);
  const filteredDocs = useMemo(() => {
    if (!q) return docs;
    return docs.filter((d) => {
      const entry = docIndex.get(d.doc_id);
      if (!entry) return false;
      return entry.meta.includes(q) || entry.content.includes(q);
    });
  }, [docs, docIndex, q]);
  const isContentOnlyMatch = (d: KnowledgeDocument): boolean => {
    if (!q) return false;
    const entry = docIndex.get(d.doc_id);
    if (!entry) return false;
    if (entry.meta.includes(q)) return false;
    return entry.content.includes(q);
  };

  const onPick = (f: File) => {
    setPendingFile(f);
    setPendingTitle(f.name.replace(/\.pdf$/i, ''));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.type === 'application/pdf') {
      onPick(file);
    } else {
      // Bug #2: previously this branch silently did nothing. Surface an
      // in-app notice so the rejection is visible.
      setNotice({
        kind: 'warning',
        title: t('knowledge.bad_file_title') ?? 'Only PDF files are supported',
        body:
          (t('knowledge.bad_file_body') ??
            'You dropped a non-PDF file. The Knowledge Base only ingests PDF documents.') +
          `\n\n(${file.name || 'unknown file'})`,
      });
    }
  };

  const upload = async () => {
    if (!pendingFile || !user) return;
    // Bug #11: cap title at 120 chars so a paste accident can't bloat
    // the doc record + every RAG inventory line.
    const safeTitle = (pendingTitle.trim() || pendingFile.name).slice(0, 120);
    setUploading(pendingFile.name);
    setPhase('extract');
    setEmbedProgress(0);
    try {
      // Bug #3: real phase callbacks replace the fake setTimeout(600)
      // trick that made the progress bar jump backward on fast uploads.
      const doc = await ingestPdf(
        pendingFile,
        {
          title: safeTitle,
          category: pendingCategory,
          uploaded_by: user.user_id,
        },
        {
          onPhase: (p, progress) => {
            if (p === 'done') return;
            setPhase(p);
            if (p === 'embed' && typeof progress === 'number') {
              setEmbedProgress(progress);
            }
          },
        }
      );
      // Post-ingest sanity check: pdfjs returns no text for scanned PDFs
      // → 0 chunks. Doc is still saved (record + filename) but warn.
      if (!Array.isArray(doc.chunks) || doc.chunks.length === 0) {
        setNotice({
          kind: 'warning',
          title: t('knowledge.scanned_title') ?? 'Scanned PDF — not searchable',
          body:
            (t('knowledge.scanned_warning') ??
              "This PDF was uploaded but no text could be extracted. It looks like a scanned image PDF without an OCR text layer. The AI cannot read or summarize it until you re-upload an OCR'd version.") +
            `\n\n(${doc.title})`,
        });
      }
      // NOTE: this app is designed for the Gemma 4 Good Hackathon (offline-
      // first). Embeddings via Ollama's nomic-embed-text are an OPTIONAL
      // quality boost — when they aren't available, the search/RAG path
      // falls back to keyword scoring against the chunk text and the doc
      // remains fully searchable. Per the offline-first spec we do NOT
      // surface partial-embedding warnings to the user; they're not
      // actionable in an offline context. Console-log instead so a dev
      // running with Ollama can still see the signal.
      if (Array.isArray(doc.chunks) && doc.chunks.length > 0) {
        const chunksWithoutEmbedding = doc.chunks.filter(
          (c) => !Array.isArray(c.embedding)
        ).length;
        if (chunksWithoutEmbedding > 0) {
          // eslint-disable-next-line no-console
          console.info(
            `[KnowledgeBase] "${doc.title}" saved with ${chunksWithoutEmbedding}/${doc.chunks.length} chunks missing embeddings. Keyword search will be used for this doc.`
          );
        }
      }
    } catch (e) {
      console.error('[KnowledgeBase] ingest failed', e);
      setNotice({
        kind: 'error',
        title: t('knowledge.upload_failed_title') ?? 'Upload failed',
        body:
          (t('knowledge.upload_failed') ?? 'Failed to process PDF: ') +
          (e as Error).message,
      });
    } finally {
      setUploading(null);
      setPhase(null);
      setEmbedProgress(0);
      setPendingFile(null);
      setPendingTitle('');
      // Bug #10: reset category between uploads so a once-medical PDF
      // doesn't bleed its category into an unrelated next upload.
      setPendingCategory('general');
    }
  };

  // Open the in-app delete modal instead of the native confirm() dialog.
  const remove = (doc: KnowledgeDocument) => {
    setDeleteError(null);
    setConfirmDelete(doc);
  };

  const performDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await db.documents.delete(confirmDelete.doc_id);
      // Close the inline summary panel if it was the one being deleted.
      if (summary?.docId === confirmDelete.doc_id) setSummary(null);
      setConfirmDelete(null);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setDeleteError(
        (t('knowledge.delete_failed') ?? 'Could not delete the document. ') +
          raw
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Card>
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-slate-600 hover:border-brand rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => {
            // Reset value BEFORE opening so picking the same file twice in
            // a row still fires onChange. Without this, the browser sees
            // "value unchanged" after the user picks the previous file
            // again (e.g. upload → scanned-PDF warning → delete → re-upload
            // the same PDF) and silently skips onChange — leaving the user
            // staring at an empty pending panel.
            if (fileInput.current) fileInput.current.value = '';
            fileInput.current?.click();
          }}
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
              // Clear the value AFTER reading so the next click — even if
              // the user re-picks the same file — re-fires onChange.
              e.target.value = '';
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
                <label className="block text-xs text-slate-400 mb-1">
                  {t('knowledge.title_label')}
                </label>
                <input
                  value={pendingTitle}
                  onChange={(e) => setPendingTitle(e.target.value)}
                  maxLength={120}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {t('knowledge.category')}
                </label>
                <select
                  value={pendingCategory}
                  onChange={(e) =>
                    setPendingCategory(e.target.value as KnowledgeDocument['category'])
                  }
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`knowledge.categories.${c}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              onClick={() => void upload()}
              className="touch-target w-full sm:w-auto px-4 py-2 bg-brand text-white rounded-lg font-semibold flex items-center justify-center gap-2"
            >
              <Upload size={16} /> {t('knowledge.upload_and_process') ?? 'Upload & process'}
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
                className="h-full bg-ai transition-all duration-300"
                style={{
                  // Real progress (Bug #3 fix): extract = 0..15%, embed =
                  // 15..85% scaled by per-chunk fraction reported by
                  // ingestPdf, save = 85..100%.
                  width:
                    phase === 'extract'
                      ? '15%'
                      : phase === 'embed'
                      ? `${15 + Math.round(embedProgress * 70)}%`
                      : phase === 'save'
                      ? '95%'
                      : '100%',
                }}
              />
            </div>
          </div>
        )}
      </Card>

      {/* Library header: title, count, and live search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-300">
          {t('knowledge.library') ?? 'Library'} (
          {q ? `${filteredDocs.length} / ${docs.length}` : docs.length})
        </h2>
      </div>

      {docs.length > 0 && (
        <Card>
          <div className="relative">
            <Search
              size={16}
              className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500 pointer-events-none"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                t('knowledge.search_placeholder') ??
                'Search by title, category, filename, or content…'
              }
              className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-9 pe-9 py-2 text-sm focus:border-brand outline-none touch-target"
              aria-label={t('knowledge.search_placeholder') ?? 'Search documents'}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label={t('knowledge.clear_search') ?? 'Clear search'}
                title={t('knowledge.clear_search') ?? 'Clear search'}
                className="absolute top-1/2 -translate-y-1/2 end-2 p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-surface-light"
              >
                <XIcon size={14} />
              </button>
            )}
          </div>
        </Card>
      )}

      {docs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen size={28} />}
            title={t('knowledge.no_docs')}
            body={t('knowledge.no_docs_hint') ?? 'Upload a PDF protocol to get started.'}
          />
        </Card>
      ) : filteredDocs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search size={28} />}
            title={t('knowledge.no_matches') ?? 'No documents match your search.'}
            body={
              t('knowledge.no_matches_hint') ??
              'Try a different keyword, or clear the search to see the full library.'
            }
          />
        </Card>
      ) : (
        filteredDocs
          .slice()
          .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
          .map((d) => {
            const summarizing = summary?.docId === d.doc_id;
            const isStreaming = summarizing && !summary?.done;
            const noChunks = !d.chunks || d.chunks.length === 0;
            return (
              <div
                key={d.doc_id}
                className="bg-surface border border-slate-700 rounded-xl"
              >
                <div className="p-4 flex items-start gap-3">
                  <FileText className="text-ai flex-shrink-0 mt-0.5" size={20} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{d.title}</div>
                    <div className="text-xs text-slate-400 flex flex-wrap gap-2 mt-0.5">
                      <span className="capitalize bg-surface-light px-2 py-0.5 rounded">
                        {t(`knowledge.categories.${d.category}`)}
                      </span>
                      <span>{t('knowledge.pages', { n: d.page_count })}</span>
                      <span>{t('knowledge.chunks', { n: d.chunks?.length ?? 0 })}</span>
                      <span>{new Date(d.uploaded_at).toLocaleDateString()}</span>
                      {isContentOnlyMatch(d) && (
                        <span
                          className="bg-ai/15 text-ai border border-ai/30 px-2 py-0.5 rounded"
                          title={
                            t('knowledge.matched_in_content') ??
                            'Matched inside the document content, not the title.'
                          }
                        >
                          {t('knowledge.match_content') ?? 'in content'}
                        </span>
                      )}
                      {noChunks && (
                        <span
                          className="bg-priority-medium/15 text-priority-medium border border-priority-medium/30 px-2 py-0.5 rounded inline-flex items-center gap-1"
                          title={
                            t('knowledge.scanned_tooltip') ??
                            'No text could be extracted from this PDF. It looks like a scanned image without OCR — the AI cannot read or summarize it.'
                          }
                        >
                          <AlertTriangle size={10} />
                          {t('knowledge.scanned_badge') ?? 'Scanned — not searchable'}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => void startSummary(d)}
                    disabled={isStreaming || noChunks}
                    title={
                      noChunks
                        ? t('knowledge.scanned_tooltip') ??
                          'No text extracted; cannot summarize a scanned PDF.'
                        : undefined
                    }
                    className="touch-target px-2.5 py-1.5 bg-ai/10 hover:bg-ai/20 disabled:opacity-50 disabled:cursor-not-allowed text-ai border border-ai/30 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                    aria-label={t('knowledge.summarize') ?? 'Summarize'}
                  >
                    <ScrollText size={13} />
                    <span className="hidden sm:inline">
                      {isStreaming
                        ? t('knowledge.summarizing') ?? 'Summarizing…'
                        : t('knowledge.summarize') ?? 'Summarize'}
                    </span>
                  </button>
                  <button
                    onClick={() => remove(d)}
                    className="touch-target p-2 hover:bg-red-500/10 hover:text-red-400 rounded-lg"
                    aria-label={t('knowledge.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                {summarizing && (
                  <div className="border-t border-slate-700 px-4 pt-3 pb-4 bg-surface-light/30">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs font-semibold text-ai flex items-center gap-1.5">
                        <Sparkles size={12} />
                        {t('knowledge.ai_summary') ?? 'AI summary'}
                        {isStreaming && (
                          <span className="text-slate-400 italic">
                            {' '}— {t('knowledge.summarizing') ?? 'streaming…'}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={closeSummary}
                        className="touch-target p-1 hover:bg-surface text-slate-400 hover:text-slate-200 rounded"
                        aria-label={t('common.cancel') ?? 'Close'}
                      >
                        <XIcon size={14} />
                      </button>
                    </div>
                    {summary?.error ? (
                      <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-start gap-2">
                        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{summary.error}</span>
                      </div>
                    ) : (
                      <div className="prose-ai text-sm text-slate-200">
                        {summary?.text ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {summary.text}
                          </ReactMarkdown>
                        ) : (
                          <span className="text-slate-400 italic text-xs">
                            {t('knowledge.summary_loading') ??
                              'Reading the document and writing a summary…'}
                          </span>
                        )}
                      </div>
                    )}
                    {summary?.truncated && summary?.done && (
                      <div className="mt-3 text-[11px] text-priority-medium bg-priority-medium/10 border border-priority-medium/30 rounded-lg px-3 py-1.5 flex items-start gap-2">
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                        <span>
                          {t('knowledge.summary_truncated') ??
                            'The document is longer than the model can read in one pass; the summary covers only the beginning. Ask follow-up questions for later sections.'}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
      )}

      {/* In-app modals — replace browser alert() / confirm(). */}
      {notice && <NoticeModal notice={notice} onClose={() => setNotice(null)} />}
      {confirmDelete && (
        <DeleteDocumentModal
          doc={confirmDelete}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (deleting) return;
            setConfirmDelete(null);
            setDeleteError(null);
          }}
          onConfirm={performDelete}
        />
      )}
    </>
  );
}

// =========================================================================
// In-app modals — themed to match Workers' delete modal so the visual
// language stays consistent. Both lock body scroll, listen for Escape,
// and focus the primary action / cancel button on mount.
// =========================================================================

type NoticeKind = 'info' | 'warning' | 'error';
interface NoticeState {
  kind: NoticeKind;
  title: string;
  body: string;
}

function NoticeModal({
  notice,
  onClose,
}: {
  notice: NoticeState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    okRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const tone =
    notice.kind === 'error'
      ? 'border-priority-critical/40 bg-priority-critical/15 text-priority-critical'
      : notice.kind === 'warning'
      ? 'border-priority-medium/40 bg-priority-medium/15 text-priority-medium'
      : 'border-brand/40 bg-brand/15 text-brand';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kb-notice-title"
      aria-describedby="kb-notice-body"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md bg-surface border rounded-xl shadow-2xl p-5 space-y-4 ${
          notice.kind === 'error'
            ? 'border-priority-critical/40'
            : notice.kind === 'warning'
            ? 'border-priority-medium/40'
            : 'border-brand/40'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-full grid place-items-center flex-shrink-0 ${tone}`}
          >
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="kb-notice-title"
              className="text-base font-bold text-slate-100"
            >
              {notice.title}
            </h2>
            <p
              id="kb-notice-body"
              className="text-sm text-slate-300 mt-1 whitespace-pre-line"
            >
              {notice.body}
            </p>
          </div>
        </div>
        <div className="flex justify-end pt-2 border-t border-slate-700">
          <button
            ref={okRef}
            onClick={onClose}
            className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-lg text-sm font-semibold"
          >
            {t('common.ok') ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDocumentModal({
  doc,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  doc: KnowledgeDocument;
  deleting: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    cancelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [deleting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kb-delete-title"
      aria-describedby="kb-delete-body"
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-priority-critical/40 rounded-xl shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-priority-critical/15 text-priority-critical grid place-items-center flex-shrink-0">
            <Trash2 size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="kb-delete-title"
              className="text-base font-bold text-slate-100"
            >
              {t('knowledge.delete_title') ?? 'Delete document?'}
            </h2>
            <p id="kb-delete-body" className="text-sm text-slate-300 mt-1">
              {t('knowledge.delete_body', { title: doc.title }) ??
                `Are you sure you want to delete "${doc.title}"? This removes the PDF and its extracted chunks from your library. This action cannot be undone.`}
            </p>
          </div>
        </div>

        {error && (
          <div
            className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-700">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={deleting}
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded-lg text-sm flex items-center gap-1"
          >
            {t('common.cancel') ?? 'Cancel'}
          </button>
          <button
            onClick={() => void onConfirm()}
            disabled={deleting}
            className="touch-target px-4 py-2 bg-priority-critical hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold flex items-center gap-1"
          >
            <Trash2 size={14} />
            {deleting
              ? t('common.saving') ?? 'Deleting…'
              : t('knowledge.delete') ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
