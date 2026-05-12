// EmotionalSupportGenModal — AI-assisted content generator for the
// Emotional Support library.
//
// Three states:
//   1. Form     — admin picks format / age / theme / language / situation.
//   2. Streaming — Gemma 4 streams content into a preview.
//   3. Review   — admin edits title + body inline, saves to db.kids.
// Same a11y plumbing as the other in-app modals (Escape-to-close when not
// busy, focus on the primary action, body scroll lock).

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Sparkles,
  Save,
  RefreshCw,
  AlertTriangle,
  BookOpen,
  Wind,
  Pencil,
  Gamepad2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { db } from '@/db/database';
import {
  generateEmotionalSupportStream,
  parseGeneratedContent,
  utf8ToBase64,
  THEME_KEYS,
  type ContentFormat,
  type AgeGroup,
  type ContentLanguage,
} from '@/services/emotionalSupportGen';

type Step = 'form' | 'streaming' | 'review';

const FORMAT_OPTIONS: { value: ContentFormat; icon: typeof BookOpen; labelKey: string; defaultLabel: string }[] = [
  { value: 'story', icon: BookOpen, labelKey: 'kids_gen.format_story', defaultLabel: 'Short story' },
  { value: 'breathing', icon: Wind, labelKey: 'kids_gen.format_breathing', defaultLabel: 'Breathing exercise' },
  { value: 'journaling', icon: Pencil, labelKey: 'kids_gen.format_journaling', defaultLabel: 'Journaling prompt' },
  { value: 'game', icon: Gamepad2, labelKey: 'kids_gen.format_game', defaultLabel: 'Game / activity' },
];

const AGE_OPTIONS: AgeGroup[] = ['5-7', '8-11', '12-15'];

const LANGUAGE_OPTIONS: { value: ContentLanguage; label: string; native: string }[] = [
  { value: 'en', label: 'English', native: 'English' },
  { value: 'ar', label: 'Arabic', native: 'العربية' },
  { value: 'fr', label: 'French', native: 'Français' },
  { value: 'es', label: 'Spanish', native: 'Español' },
];

export default function EmotionalSupportGenModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // ---- Form state ------------------------------------------------------
  const [format, setFormat] = useState<ContentFormat>('story');
  const [ageGroup, setAgeGroup] = useState<AgeGroup>('8-11');
  const [theme, setTheme] = useState<string>('fear');
  const [customTheme, setCustomTheme] = useState('');
  const [language, setLanguage] = useState<ContentLanguage>('en');
  const [situation, setSituation] = useState('');

  // ---- Stream state ----------------------------------------------------
  const [step, setStep] = useState<Step>('form');
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamedText, setStreamedText] = useState('');

  // ---- Review state (editable after stream) ----------------------------
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewBody, setReviewBody] = useState('');

  // ---- Save state ------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const primaryRef = useRef<HTMLButtonElement | null>(null);

  // ---- Modal a11y -------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (streaming || saving) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    primaryRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, streaming, saving]);

  // ---- Generation ------------------------------------------------------
  const runGenerate = async () => {
    if (streaming) return;
    setStreamError(null);
    setStreamedText('');
    setStep('streaming');
    setStreaming(true);

    const finalTheme = theme === '__custom__' ? customTheme.trim() : theme;
    if (!finalTheme) {
      setStreamError(t('kids_gen.theme_required', 'Please pick or enter a theme.'));
      setStreaming(false);
      setStep('form');
      return;
    }

    let buffer = '';
    try {
      for await (const ev of generateEmotionalSupportStream({
        format,
        ageGroup,
        theme: finalTheme,
        language,
        situation: situation.trim() || undefined,
      })) {
        if (ev.kind === 'delta') {
          buffer += ev.text;
          setStreamedText(buffer);
        } else if (ev.kind === 'done') {
          setReviewTitle(ev.title);
          setReviewBody(ev.body);
          setStep('review');
        } else if (ev.kind === 'error') {
          setStreamError(ev.message);
          setStep('form');
        }
      }
    } catch (e) {
      console.error('[emotional-support] generation failed', e);
      setStreamError(e instanceof Error ? e.message : String(e));
      setStep('form');
    } finally {
      setStreaming(false);
    }
    // Defensive: if the stream finished without a 'done' event but produced
    // text, parse it ourselves so we still hand the user a review surface.
    if (buffer.trim() && step !== 'review') {
      const fallback = `${format[0].toUpperCase() + format.slice(1)} — ${finalTheme}`;
      const parsed = parseGeneratedContent(buffer, fallback);
      setReviewTitle((cur) => cur || parsed.title);
      setReviewBody((cur) => cur || parsed.body);
      setStep('review');
    }
  };

  // ---- Save to library -------------------------------------------------
  const doSave = async () => {
    if (saving) return;
    setSaveError(null);
    const cleanTitle = reviewTitle.trim();
    const cleanBody = reviewBody.trim();
    if (!cleanTitle) {
      setSaveError(t('kids_gen.title_required', 'Please give the content a title before saving.'));
      return;
    }
    if (!cleanBody) {
      setSaveError(t('kids_gen.body_required', 'The content body is empty — generate or write something first.'));
      return;
    }
    setSaving(true);
    try {
      // Build a UTF-8-safe markdown data URL so Arabic / French / Spanish
      // content survives storage and decoding cleanly.
      const dataUrl = `data:text/markdown;charset=utf-8;base64,${utf8ToBase64(cleanBody)}`;
      const id = `K-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await db.kids.add({
        content_id: id,
        title: cleanTitle.slice(0, 120),
        age_group: ageGroup,
        language: language,
        type: 'story', // text-based AI-generated content is stored as story
        data_url: dataUrl,
        mime: 'text/markdown',
        uploaded_at: new Date().toISOString(),
      });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const goBackToForm = () => {
    setStep('form');
    setStreamedText('');
    setReviewTitle('');
    setReviewBody('');
    setStreamError(null);
  };

  const dir = language === 'ar' ? 'rtl' : 'ltr';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="esg-title"
      onClick={() => {
        if (streaming || saving) return;
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[92vh] bg-surface border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="px-5 py-3 border-b border-slate-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-ai" />
            <h2 id="esg-title" className="font-semibold">
              {t('kids_gen.title', 'Generate emotional-support content')}
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ai/15 text-ai font-semibold">
              AI
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={streaming || saving}
            className="touch-target p-1.5 hover:bg-surface-light text-slate-400 hover:text-slate-200 rounded disabled:opacity-50"
            aria-label={t('common.close', 'Close')}
          >
            <X size={16} />
          </button>
        </header>

        {/* Disclaimer — always visible, never auto-publishes content. */}
        <div className="px-5 pt-3">
          <div className="text-[11px] text-priority-medium bg-priority-medium/10 border border-priority-medium/30 rounded-lg px-3 py-1.5 flex items-start gap-2">
            <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
            <span>
              {t(
                'kids_gen.disclaimer',
                'AI-assisted draft. Review for cultural fit, age-appropriateness, and trauma-informed framing before using with children. Not a substitute for trained child-psychology expertise.'
              )}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === 'form' && (
            <>
              {/* Format */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('kids_gen.format', 'Format')}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FORMAT_OPTIONS.map((opt) => {
                    const Icon = opt.icon;
                    const selected = format === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setFormat(opt.value)}
                        className={`touch-target px-3 py-2 rounded-lg border text-xs font-semibold flex flex-col items-center gap-1 ${
                          selected
                            ? 'bg-ai/15 border-ai text-ai'
                            : 'bg-surface-deep border-slate-700 text-slate-300 hover:border-slate-500'
                        }`}
                      >
                        <Icon size={16} />
                        <span>{t(opt.labelKey, opt.defaultLabel)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Age + Language side by side */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('kids_gen.age_group', 'Age group')}
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {AGE_OPTIONS.map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setAgeGroup(a)}
                        className={`touch-target px-2 py-1.5 rounded-lg border text-xs font-semibold ${
                          ageGroup === a
                            ? 'bg-brand/15 border-brand text-brand'
                            : 'bg-surface-deep border-slate-700 text-slate-300 hover:border-slate-500'
                        }`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('kids_gen.language', 'Language')}
                  </label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as ContentLanguage)}
                    className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-1.5 text-xs focus:border-brand outline-none"
                  >
                    {LANGUAGE_OPTIONS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label} — {l.native}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Theme */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('kids_gen.theme', 'Theme')}
                </label>
                <select
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-1.5 text-xs focus:border-brand outline-none"
                >
                  {THEME_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {t(`kids_gen.theme_${k}`, defaultThemeLabel(k))}
                    </option>
                  ))}
                  <option value="__custom__">
                    {t('kids_gen.theme_custom', '— Custom (type your own) —')}
                  </option>
                </select>
                {theme === '__custom__' && (
                  <input
                    value={customTheme}
                    onChange={(e) => setCustomTheme(e.target.value)}
                    maxLength={200}
                    placeholder={t(
                      'kids_gen.theme_custom_placeholder',
                      'e.g. nightmares since the earthquake'
                    )}
                    className="mt-2 w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-1.5 text-xs focus:border-brand outline-none"
                  />
                )}
              </div>

              {/* Optional situation */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('kids_gen.situation', 'Specific situation')}{' '}
                  <span className="text-slate-500 font-normal">
                    {t('kids_gen.situation_optional', '(optional)')}
                  </span>
                </label>
                <textarea
                  value={situation}
                  onChange={(e) => setSituation(e.target.value)}
                  rows={2}
                  maxLength={400}
                  placeholder={t(
                    'kids_gen.situation_placeholder',
                    'e.g. 8-year-old who lost their dog in a flood; very anxious at bedtime'
                  )}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-xs focus:border-brand outline-none resize-none"
                />
              </div>

              {streamError && (
                <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>{streamError}</span>
                </div>
              )}
            </>
          )}

          {step === 'streaming' && (
            <div className="space-y-3">
              <div className="text-xs text-ai italic flex items-center gap-2">
                <Sparkles size={12} className="animate-pulse" />
                {t('kids_gen.streaming', 'Writing…')}
              </div>
              <div
                className="prose-ai text-sm text-slate-200 bg-surface-deep border border-slate-700 rounded-lg p-3 min-h-[160px] max-h-[50vh] overflow-y-auto"
                dir={dir}
              >
                {streamedText ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedText}</ReactMarkdown>
                ) : (
                  <span className="text-slate-500 italic text-xs">
                    {t('kids_gen.streaming_wait', 'Waiting for the first words…')}
                  </span>
                )}
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('kids_gen.review_title', 'Title')}
                </label>
                <input
                  value={reviewTitle}
                  onChange={(e) => setReviewTitle(e.target.value)}
                  maxLength={120}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm font-semibold focus:border-brand outline-none"
                  dir={dir}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('kids_gen.review_body', 'Content (markdown)')}
                </label>
                <textarea
                  value={reviewBody}
                  onChange={(e) => setReviewBody(e.target.value)}
                  rows={12}
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none font-mono"
                  dir={dir}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                  {t('kids_gen.review_preview', 'Preview')}
                </label>
                <div
                  className="prose-ai text-sm text-slate-200 bg-surface-deep border border-slate-700 rounded-lg p-3 max-h-[40vh] overflow-y-auto"
                  dir={dir}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {reviewBody || ' '}
                  </ReactMarkdown>
                </div>
              </div>
              {saveError && (
                <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>{saveError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-700 flex items-center justify-between gap-3 bg-surface-light/30">
          <div className="text-[11px] text-slate-500">
            {step === 'form' && t('kids_gen.footer_form', 'AI runs locally on your laptop via Ollama.')}
            {step === 'streaming' && t('kids_gen.footer_streaming', 'You can stop and start over after the stream finishes.')}
            {step === 'review' && t('kids_gen.footer_review', 'Edit the title and content, then save to the library.')}
          </div>
          <div className="flex items-center gap-2">
            {step === 'form' && (
              <button
                ref={primaryRef}
                onClick={() => void runGenerate()}
                disabled={streaming}
                className="touch-target px-3 py-1.5 bg-ai hover:bg-violet-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                <Sparkles size={12} />
                {t('kids_gen.generate', 'Generate')}
              </button>
            )}
            {step === 'streaming' && (
              <span className="text-xs text-slate-400 italic">
                {t('kids_gen.streaming_short', 'Streaming…')}
              </span>
            )}
            {step === 'review' && (
              <>
                <button
                  onClick={goBackToForm}
                  disabled={saving}
                  className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1"
                >
                  <RefreshCw size={12} />
                  {t('kids_gen.regenerate', 'Regenerate')}
                </button>
                <button
                  ref={primaryRef}
                  onClick={() => void doSave()}
                  disabled={saving}
                  className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
                >
                  <Save size={12} />
                  {saving ? t('common.saving', 'Saving…') : t('kids_gen.save', 'Save to library')}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function defaultThemeLabel(k: (typeof THEME_KEYS)[number]): string {
  switch (k) {
    case 'loss_of_home':
      return 'Loss of home';
    case 'fear':
      return 'Fear and feeling unsafe';
    case 'displacement':
      return 'Displacement';
    case 'separation':
      return 'Separation from family or friends';
    case 'returning_to_school':
      return 'Returning to school after a disaster';
  }
}
