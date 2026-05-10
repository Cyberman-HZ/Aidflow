import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Smile,
  Upload,
  Image as ImageIcon,
  Film,
  FileText,
  BookOpen,
  Sparkles,
  Trash2,
  Download,
  AlertTriangle,
  X as XIcon,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import EmotionalSupportGenModal from '@/components/EmotionalSupportGenModal';
import { decodeDataUrlText } from '@/services/emotionalSupportGen';
import type { KidsContent as KidsItem } from '@/types';

export default function KidsContentPage() {
  const { t } = useTranslation();
  const [age, setAge] = useState<KidsItem['age_group'] | ''>('');
  const [lang, setLang] = useState<KidsItem['language'] | ''>('');
  const [genOpen, setGenOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<KidsItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const items = useLiveQuery(() => db.kids.toArray(), []) ?? [];

  const performDelete = async () => {
    if (!deleteCandidate || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await db.kids.delete(deleteCandidate.content_id);
      setDeleteCandidate(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };
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
            <option value="5-7">5–7</option>
            <option value="8-11">8–11</option>
            <option value="12-15">12–15</option>
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
          <button
            type="button"
            onClick={() => setGenOpen(true)}
            className="touch-target ms-auto px-3 py-2 bg-ai hover:bg-violet-600 rounded-lg text-sm flex items-center gap-2 font-semibold text-white"
            title={t(
              'kids.generate_tooltip',
              'Use Gemma 4 to generate trauma-informed content in any supported language.'
            )}
          >
            <Sparkles size={14} /> {t('kids.generate', 'Generate with AI')}
          </button>
          <label className="touch-target cursor-pointer px-3 py-2 bg-brand hover:bg-brand-dark rounded-lg text-sm flex items-center gap-2 font-semibold">
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

      {genOpen && (
        <EmotionalSupportGenModal onClose={() => setGenOpen(false)} />
      )}

      {filtered.length === 0 ? (
        <Card><EmptyState icon={<Smile size={28} />} title={t('kids.no_content')} /></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c) => (
            <KidsCard
              key={c.content_id}
              item={c}
              onDelete={() => {
                setDeleteError(null);
                setDeleteCandidate(c);
              }}
            />
          ))}
        </div>
      )}

      {deleteCandidate && (
        <DeleteContentModal
          item={deleteCandidate}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (deleting) return;
            setDeleteCandidate(null);
            setDeleteError(null);
          }}
          onConfirm={performDelete}
        />
      )}
    </div>
  );
}

// =========================================================================
// Download helpers — turn a stored data URL back into a real file the
// user can save to disk. Picks a sensible extension from the MIME type
// and sanitizes the title for use as a filename.
// =========================================================================

function extensionForMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'text/markdown') return 'md';
  if (m === 'text/plain' || m.startsWith('text/')) return 'txt';
  if (m === 'image/svg+xml') return 'svg';
  if (m.startsWith('image/')) return m.split('/')[1]?.split('+')[0] || 'img';
  if (m.startsWith('video/')) return m.split('/')[1] || 'mp4';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/json') return 'json';
  return 'bin';
}

function sanitizeFilename(s: string): string {
  // Strip path / control / Windows-illegal chars, collapse whitespace.
  return (
    s
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl) return null;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return null;
  const meta = dataUrl.slice(5, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const mimeMatch = meta.match(/^[^;,]+/);
  const mime = mimeMatch ? mimeMatch[0] : 'application/octet-stream';
  const isBase64 = /;\s*base64\s*$/.test(meta);
  try {
    if (isBase64) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// =========================================================================
// Print-to-PDF — shared by stories and images. Builds a styled standalone
// HTML page, opens it in a popup, and auto-fires window.print() so the
// OS's "Save as PDF" destination kicks in. Same approach as the Dashboard
// summary export and Knowledge Base translation export — zero new deps,
// fully offline, real selectable text in the resulting file, RTL-correct
// for Arabic content.
// =========================================================================

const escapeHtmlForPdf = (s: string): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatInline = (s: string): string => {
  let html = escapeHtmlForPdf(s);
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  return html;
};

// Same minimal markdown converter used by the other print exports —
// covers exactly what Gemma 4's templated content emits (## / ### / #
// headings, "- " or "* " bullets, blank-line paragraph breaks).
function mdToHtml(md: string): string {
  const lines = (md ?? '').split('\n');
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
}

function buildItemPrintDoc(item: KidsItem): string {
  const lang = item.language;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const fontStack =
    lang === 'ar'
      ? `"Tahoma", "Arial", "Segoe UI", sans-serif`
      : `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const listSidePadding =
    lang === 'ar' ? 'padding-right: 22px; padding-left: 0' : 'padding-left: 22px; padding-right: 0';

  // Body shape depends on item type:
  //   - image: data URL embedded directly into <img>, centered, capped at 80vh
  //   - markdown: mdToHtml render
  //   - plain text: pre-wrapped escape
  let bodyHtml: string;
  if (item.type === 'image') {
    bodyHtml = `
  <figure class="image-figure">
    <img src="${escapeHtmlForPdf(item.data_url)}" alt="${escapeHtmlForPdf(item.title)}" />
  </figure>`;
  } else if (item.mime === 'text/markdown') {
    bodyHtml = mdToHtml(decodeDataUrlText(item.data_url));
  } else {
    // text/plain or unknown — render as a single pre-wrapped paragraph
    const decoded = decodeDataUrlText(item.data_url);
    bodyHtml = `<p style="white-space: pre-wrap;">${escapeHtmlForPdf(decoded)}</p>`;
  }

  const generated = new Date().toLocaleString();
  const generatedLabel: Record<string, string> = {
    en: 'Generated',
    ar: 'تم الإنشاء',
    fr: 'Généré le',
    es: 'Generado',
  };

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<title>${escapeHtmlForPdf(item.title)}</title>
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
  header { border-bottom: 2px solid #00ADB5; padding-bottom: 12px; margin-bottom: 18px; }
  header h1 { font-size: 22px; margin: 0 0 4px; color: #222831; }
  header .meta { font-size: 11px; color: #666; }
  header .tags { margin-top: 6px; }
  header .tag {
    display: inline-block;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: #f1f5f9;
    color: #475569;
    margin-${dir === 'rtl' ? 'left' : 'right'}: 4px;
    text-transform: capitalize;
  }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; color: #00ADB5; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #eee; }
  h3 { font-size: 14px; margin: 14px 0 6px; }
  ul { ${listSidePadding}; margin: 6px 0; }
  li { margin: 4px 0; }
  p { margin: 6px 0; }
  strong { color: #222831; }
  em { color: #393E46; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-family: "Menlo", "Consolas", monospace; font-size: 0.9em; }
  .image-figure {
    margin: 16px 0;
    text-align: center;
    page-break-inside: avoid;
  }
  .image-figure img {
    max-width: 100%;
    max-height: 80vh;
    object-fit: contain;
  }
  footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #eee; font-size: 10px; color: #888; }
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
    <h1>${escapeHtmlForPdf(item.title)}</h1>
    <div class="tags">
      <span class="tag">${escapeHtmlForPdf(item.age_group)}</span>
      <span class="tag" style="text-transform: uppercase;">${escapeHtmlForPdf(item.language)}</span>
      <span class="tag">${escapeHtmlForPdf(item.type)}</span>
    </div>
    <div class="meta" style="margin-top: 6px;">
      ${escapeHtmlForPdf(generatedLabel[lang] ?? generatedLabel.en)} ${escapeHtmlForPdf(generated)} · AidFlow Pro
    </div>
  </header>
  <main>
${bodyHtml}
  </main>
  <footer>
    AidFlow Pro · Emotional Support library
  </footer>
</body>
</html>`;
}

function printItemAsPdf(item: KidsItem): boolean {
  const html = buildItemPrintDoc(item);
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  const trigger = () => {
    try {
      win.focus();
      win.print();
    } catch {
      /* some browsers throw if the window was closed before print fires */
    }
  };
  if (win.document.readyState === 'complete') {
    setTimeout(trigger, 80);
  } else {
    win.addEventListener('load', () => setTimeout(trigger, 80));
  }
  return true;
}

/**
 * Per-card download. Routes by item type:
 *   - story / image  → print-to-PDF (one-page styled layout)
 *   - pdf            → direct download (already a PDF)
 *   - video          → direct download (PDFs can't carry video)
 * Returns false only if the popup was blocked while trying to print.
 */
function downloadItem(item: KidsItem): boolean {
  // Video and PDF download natively — PDFs are already PDFs, and video
  // cannot be meaningfully embedded in a PDF (no inline playback).
  if (item.type === 'video' || item.type === 'pdf') {
    const blob = dataUrlToBlob(item.data_url);
    if (!blob) return false;
    triggerBlobDownload(
      blob,
      `${sanitizeFilename(item.title)}.${extensionForMime(item.mime)}`
    );
    return true;
  }
  // Story (text/*) and image → render through print-to-PDF.
  return printItemAsPdf(item);
}

function KidsCard({
  item,
  onDelete,
}: {
  item: KidsItem;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Icon = item.type === 'image' ? ImageIcon : item.type === 'video' ? Film : item.type === 'pdf' ? FileText : BookOpen;
  return (
    <article className="bg-surface border border-slate-700 rounded-xl overflow-hidden relative group">
      {/* Floating action cluster — top-right of the card. Two clean
          circular buttons with soft shadows: download (brand-teal on
          hover) on the left, destructive delete (red on hover) on the
          right. Same FAB style for visual consistency. */}
      <div className="absolute top-2 end-2 z-10 flex gap-1.5">
        <button
          type="button"
          onClick={() => downloadItem(item)}
          className="w-8 h-8 grid place-items-center rounded-full bg-white/95 hover:bg-brand/10 text-slate-400 hover:text-brand shadow-sm hover:shadow-md ring-1 ring-black/5 hover:ring-brand/30 backdrop-blur-sm transition-all dark:bg-surface/90 dark:hover:bg-brand/15 dark:text-slate-400 dark:hover:text-brand dark:ring-white/10 dark:hover:ring-brand/40"
          aria-label={t('kids.download', 'Download')}
          title={t('kids.download', 'Download')}
        >
          <Download size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="w-8 h-8 grid place-items-center rounded-full bg-white/95 hover:bg-red-50 text-slate-400 hover:text-red-500 shadow-sm hover:shadow-md ring-1 ring-black/5 hover:ring-red-200 backdrop-blur-sm transition-all dark:bg-surface/90 dark:hover:bg-red-500/15 dark:text-slate-400 dark:hover:text-red-400 dark:ring-white/10 dark:hover:ring-red-500/30"
          aria-label={t('kids.delete', 'Delete')}
          title={t('kids.delete', 'Delete')}
        >
          <Trash2 size={14} strokeWidth={2} />
        </button>
      </div>
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
            <div
              className="prose-ai mt-2 max-h-72 overflow-y-auto pe-1"
              dir={item.language === 'ar' ? 'rtl' : 'ltr'}
            >
              {/* Decode the data URL with UTF-8 awareness so Arabic /
                  French / Spanish content displays correctly. Markdown
                  payloads (text/markdown) render with formatting; plain
                  text falls through to whitespace-pre-wrap. */}
              {item.mime === 'text/markdown' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {decodeDataUrlText(item.data_url)}
                </ReactMarkdown>
              ) : (
                <p className="whitespace-pre-wrap">
                  {decodeDataUrlText(item.data_url)}
                </p>
              )}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

// =========================================================================
// Inline confirmation modal — same a11y plumbing as the other in-app
// modals: Escape closes when not deleting, focus jumps to Cancel on
// mount, body scroll lock, ARIA dialog role.
// =========================================================================

function DeleteContentModal({
  item,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  item: KidsItem;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || deleting) return;
      e.preventDefault();
      onCancel();
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
      aria-labelledby="kids-delete-title"
      onClick={() => {
        if (deleting) return;
        onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-priority-critical/40 rounded-xl shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            size={20}
            className="text-priority-critical flex-shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <h2
              id="kids-delete-title"
              className="font-semibold text-slate-100 mb-1"
            >
              {t('kids.delete_title', 'Delete this content?')}
            </h2>
            <p className="text-sm text-slate-300">
              {t('kids.delete_body', 'This permanently removes')}{' '}
              <span className="font-semibold text-slate-100">"{item.title}"</span>{' '}
              {t('kids.delete_body_2', 'from the library. This cannot be undone.')}
            </p>
            <div className="mt-2 text-xs text-slate-500 flex gap-2 flex-wrap">
              <span className="bg-surface-light px-2 py-0.5 rounded">
                {item.age_group}
              </span>
              <span className="bg-surface-light px-2 py-0.5 rounded uppercase">
                {item.language}
              </span>
              <span className="bg-surface-light px-2 py-0.5 rounded capitalize">
                {item.type}
              </span>
            </div>
          </div>
        </div>
        {error && (
          <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1"
          >
            <XIcon size={12} />
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="touch-target px-3 py-1.5 bg-priority-critical hover:bg-red-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
          >
            <Trash2 size={12} />
            {deleting
              ? t('common.deleting', 'Deleting…')
              : t('kids.delete_confirm', 'Delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
