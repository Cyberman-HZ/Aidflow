// Reusable Gemma 4 chat panel.
// Used by /assistant, /family/:id ("ask about this family"), and /guides.

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sparkles,
  Send,
  BookOpen,
  Globe,
  ExternalLink,
  CheckCircle2,
  X as XIcon,
  AlertTriangle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, Family } from '@/types';
import { chatStream, chat } from '@/services/ollama';
import { ragAnswerStream } from '@/services/rag';
import { wikipediaContext } from '@/services/webSearch';
import {
  applyFamilyAction,
  buildFamilyActionPrompt,
  describeFamilyAction,
  parseFamilyActions,
  stripFamilyActions,
  type FamilyAction,
} from '@/services/familyActions';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectivityStore } from '@/stores/connectivityStore';

interface AIChatProps {
  systemPrompt?: string;
  initialMessages?: ChatMessage[];
  enableRag?: boolean;
  enableWiki?: boolean;
  placeholder?: string;
  contextLabel?: string;
  /** When true the chat fills its container */
  flex?: boolean;
  /**
   * Enable AI-proposed edits for this family. When set, the chat appends an
   * action protocol to the system prompt and renders Apply/Discard cards
   * under any assistant message that proposes mutations.
   */
  family?: Family;
}

export default function AIChat({
  systemPrompt,
  initialMessages = [],
  enableRag = true,
  enableWiki = true,
  placeholder,
  contextLabel,
  flex = true,
  family,
}: AIChatProps) {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const internetUp = useConnectivityStore((s) => s.internetUp);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [thinking, setThinking] = useState(false);
  const [useRag, setUseRag] = useState(false);
  const [useWiki, setUseWiki] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks the lifecycle of each AI-proposed family action by message index.
  //   pending     — awaiting Apply / Discard
  //   applied     — successfully written to IndexedDB
  //   discarded   — user declined
  //   failed      — apply threw (error stored in errorByKey)
  type ActionStatus = 'pending' | 'applied' | 'discarded' | 'failed';
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // Live list of distinct sectors used across all families. Passed into the
  // AI action prompt so Gemma 4 can only propose sector changes to values
  // that actually exist (closed-set validation). Only fetches when the chat
  // is family-scoped; otherwise it returns an empty array.
  const sectorsLive = useLiveQuery<string[]>(async () => {
    if (!family) return [];
    const all = await db.families.toArray();
    return all.map((f) => f.location_sector).filter((s): s is string => !!s);
  }, [family?.family_id]);
  const allowedSectors = Array.from(new Set(sectorsLive ?? [])).sort();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  // Disable Wikipedia toggle automatically if internet drops
  useEffect(() => {
    if (!internetUp && useWiki) setUseWiki(false);
  }, [internetUp, useWiki]);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || thinking) return;
    setInput('');
    const userMsg: ChatMessage = { role: 'user', content: trimmed, timestamp: new Date().toISOString() };
    const next: ChatMessage[] = [...messages, userMsg];
    setMessages(next);
    setThinking(true);

    try {
      // ---- Step 1: build any optional augmentations (Wikipedia, RAG) ----
      // Privacy contract: ONLY the user's question goes to Wikipedia.
      // Family data, distributions, names, etc. never leave the device.
      let wikiBlock = '';
      let wikiInstruction = '';
      let allCitations: NonNullable<ChatMessage['citations']> = [];
      if (useWiki && internetUp) {
        const wiki = await wikipediaContext(trimmed, language);
        if (wiki.context) {
          wikiBlock = `\n\n## WIKIPEDIA SEARCH RESULTS (searched for: "${wiki.searchedFor}" — only the question was sent, no family data)\n${wiki.context}`;
          wikiInstruction =
            '\n\n## WIKIPEDIA RULES\n' +
            '1. The Wikipedia excerpts above are the ONLY external information you have access to.\n' +
            '2. Base your answer strictly on the excerpts. Do NOT invent or recall facts that are not in the excerpts.\n' +
            '3. Cite the article title in parentheses for any fact you draw from Wikipedia, e.g. (Wikipedia: Cholera).\n' +
            '4. If the excerpts do not contain information that answers the question, reply exactly: "The Wikipedia search did not return articles relevant to this question. Try rephrasing or uploading a PDF to the Knowledge Base."\n' +
            '5. Do NOT mention the article URLs in your answer — they are shown automatically as citations.';
          allCitations = [...allCitations, ...wiki.citations];
        } else {
          wikiInstruction =
            '\n\n## WIKIPEDIA\nThe Wikipedia search returned no results. If the user asked for general/encyclopedic information, tell them: "The Wikipedia search did not return articles for this query." Do not invent facts.';
        }
      }

      // ---- Step 2: dispatch on whether RAG is requested ----
      if (enableRag && useRag) {
        // The dedicated RAG path retrieves PDF chunks and asks Gemma 4 with citations.
        // We append Wikipedia context to the question so Gemma sees both.
        const augmentedQuestion = wikiBlock
          ? `${trimmed}\n${wikiBlock}${wikiInstruction}\n\nUse both your local knowledge base AND the Wikipedia excerpts above. Cite each.`
          : trimmed;
        let buffer = '';
        const placeholderMsg: ChatMessage = {
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
        };
        setMessages((m) => [...m, placeholderMsg]);
        for await (const evt of ragAnswerStream(augmentedQuestion, language)) {
          if (evt.kind === 'delta') {
            buffer += evt.text;
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { ...copy[copy.length - 1], content: buffer };
              return copy;
            });
          } else {
            // 'done' — attach citations
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = {
                ...copy[copy.length - 1],
                citations: [...allCitations, ...evt.citations],
              };
              return copy;
            });
          }
        }
      } else {
        // Plain chat — system prompt + (optional) Wikipedia context block
        const baseSys = systemPrompt
          ? systemPrompt
          : `You are AidFlow Pro's humanitarian field assistant powered by Gemma 4. Respond in ${
              language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English'
            }. Be concise and practical.`;
        // If this chat is family-scoped, append the action protocol so the
        // AI knows it can propose edits via fenced aidflow-action blocks. We
        // pass the live list of sectors so Gemma can't invent new ones.
        const actionBlock = family
          ? buildFamilyActionPrompt({ allowedSectors })
          : '';
        const sysContent = baseSys + actionBlock + wikiBlock + wikiInstruction;

        const sys: ChatMessage = { role: 'system', content: sysContent };
        const conversation = [sys, ...next];
        let buffer = '';
        const placeholderMsg: ChatMessage = {
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          citations: allCitations.length ? allCitations : undefined,
        };
        setMessages((m) => [...m, placeholderMsg]);
        try {
          for await (const delta of chatStream(conversation, { temperature: 0.5, maxTokens: 1024 })) {
            buffer += delta;
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { ...copy[copy.length - 1], content: buffer };
              return copy;
            });
          }
        } catch (e) {
          console.warn('[AIChat] stream failed, falling back to non-streaming', e);
          const text = await chat(conversation, { temperature: 0.5, maxTokens: 1024 });
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], content: text };
            return copy;
          });
        }
      }
    } catch (e) {
      console.error('[AIChat] failed', e);
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content:
            'Sorry — I could not reach Gemma 4. Make sure Ollama is running with `OLLAMA_ORIGINS=*` and the model `gemma4:e4b` is pulled.',
        },
      ]);
    } finally {
      setThinking(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div
      className={`bg-surface rounded-xl border border-slate-700 ${
        flex ? 'flex flex-col flex-1 min-h-0' : ''
      }`}
    >
      {contextLabel && (
        <div className="px-4 py-2 text-xs text-slate-400 border-b border-slate-700">
          {contextLabel}
        </div>
      )}
      <div ref={scrollRef} className={`p-4 space-y-3 overflow-y-auto ${flex ? 'flex-1' : 'max-h-[60vh]'}`}>
        {messages.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">
            <Sparkles className="mx-auto mb-2 text-ai" size={24} />
            <p>{t('assistant.system_note')}</p>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble
            key={i}
            m={m}
            family={family}
            actionStatus={actionStatus}
            actionErrors={actionErrors}
            onApply={async (key, action) => {
              if (!family) return;
              setActionStatus((s) => ({ ...s, [key]: 'pending' }));
              try {
                await applyFamilyAction(family.family_id, action);
                setActionStatus((s) => ({ ...s, [key]: 'applied' }));
                setActionErrors((s) => {
                  const c = { ...s };
                  delete c[key];
                  return c;
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setActionStatus((s) => ({ ...s, [key]: 'failed' }));
                setActionErrors((s) => ({ ...s, [key]: msg }));
              }
            }}
            onDiscard={(key) =>
              setActionStatus((s) => ({ ...s, [key]: 'discarded' }))
            }
            messageIdx={i}
          />
        ))}
        {thinking && (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Sparkles size={16} className="text-ai pulse-soft" />
            <span>{t('assistant.thinking')}</span>
          </div>
        )}
      </div>
      <div className="border-t border-slate-700 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {enableRag && (
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={useRag}
                onChange={(e) => setUseRag(e.target.checked)}
                className="accent-ai"
              />
              <BookOpen size={14} />
              {t('assistant.use_rag')}
            </label>
          )}
          {enableWiki && (
            <label
              className={`flex items-center gap-2 text-xs cursor-pointer ${
                internetUp ? 'text-slate-400' : 'text-slate-600 cursor-not-allowed'
              }`}
              title={
                internetUp
                  ? 'Searches Wikipedia in your UI language. Only the question is sent — no family data.'
                  : 'No internet — Wikipedia search disabled'
              }
            >
              <input
                type="checkbox"
                checked={useWiki}
                onChange={(e) => setUseWiki(e.target.checked)}
                disabled={!internetUp}
                className="accent-ai"
              />
              <Globe size={14} />
              {t('assistant.use_wiki')}
            </label>
          )}
        </div>
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder ?? t('assistant.placeholder')}
            rows={2}
            className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm resize-none focus:border-brand outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={thinking || !input.trim()}
            className="touch-target h-11 px-4 bg-ai hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center gap-2 text-white text-sm font-medium transition-colors"
          >
            <Send size={16} />
            <span className="hidden sm:inline">{t('assistant.send')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  m,
  family,
  actionStatus,
  actionErrors,
  onApply,
  onDiscard,
  messageIdx,
}: {
  m: ChatMessage;
  family?: Family;
  actionStatus: Record<string, 'pending' | 'applied' | 'discarded' | 'failed'>;
  actionErrors: Record<string, string>;
  onApply: (key: string, action: FamilyAction) => Promise<void>;
  onDiscard: (key: string) => void;
  messageIdx: number;
}) {
  const isUser = m.role === 'user';
  const actions: FamilyAction[] =
    !isUser && family && m.content ? parseFamilyActions(m.content) : [];
  const visibleContent =
    !isUser && family && actions.length > 0 ? stripFamilyActions(m.content) : m.content;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-brand text-white rounded-br-sm'
            : 'bg-surface-light text-slate-100 border border-slate-700 rounded-bl-sm'
        }`}
      >
        {!isUser && (
          <div className="flex items-center gap-1.5 text-xs text-ai mb-1.5 font-medium">
            <Sparkles size={12} /> Gemma 4
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{m.content || '…'}</div>
        ) : (
          <div className="prose-ai break-words">
            {visibleContent ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node, ...props }) => (
                    <a
                      {...props}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline hover:text-sky-300"
                    />
                  ),
                }}
              >
                {visibleContent}
              </ReactMarkdown>
            ) : actions.length > 0 ? (
              <span className="italic text-slate-400">
                Proposed change{actions.length === 1 ? '' : 's'} below.
              </span>
            ) : (
              '…'
            )}
          </div>
        )}
        {!isUser && actions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-700 space-y-2">
            {actions.map((action, idx) => {
              const key = `${messageIdx}:${idx}`;
              const status = actionStatus[key] ?? 'pending';
              const err = actionErrors[key];
              return (
                <ActionCard
                  key={key}
                  action={action}
                  status={status}
                  error={err}
                  onApply={() => onApply(key, action)}
                  onDiscard={() => onDiscard(key)}
                />
              );
            })}
          </div>
        )}
        {m.citations && m.citations.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-700 text-xs text-slate-400 space-y-0.5">
            {m.citations.map((c, idx) =>
              c.url ? (
                <a
                  key={idx}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:text-ai transition-colors"
                >
                  <Globe size={11} />
                  <span className="italic">{c.title}</span>
                  <ExternalLink size={10} className="opacity-60" />
                </a>
              ) : (
                <div key={idx} className="flex items-center gap-1.5">
                  <BookOpen size={11} />
                  <span className="italic">"{c.title}"</span>
                  <span>p. {c.page}</span>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionCard({
  action,
  status,
  error,
  onApply,
  onDiscard,
}: {
  action: FamilyAction;
  status: 'pending' | 'applied' | 'discarded' | 'failed';
  error?: string;
  onApply: () => void | Promise<void>;
  onDiscard: () => void;
}) {
  const description = describeFamilyAction(action);

  if (status === 'applied') {
    return (
      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-priority-normal/10 border border-priority-normal/30 text-priority-normal">
        <CheckCircle2 size={13} />
        <span>Applied: {description}</span>
      </div>
    );
  }
  if (status === 'discarded') {
    return (
      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-surface-deep border border-slate-700 text-slate-400">
        <XIcon size={13} />
        <span className="line-through">{description}</span>
        <span className="ms-auto italic">discarded</span>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="text-xs px-3 py-2 rounded-lg bg-priority-critical/10 border border-priority-critical/30 text-priority-critical flex items-start gap-2">
        <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Could not apply</div>
          <div className="opacity-80">{description}</div>
          {error && <div className="opacity-70 italic mt-0.5">{error}</div>}
        </div>
        <button
          onClick={() => void onApply()}
          className="text-[11px] underline hover:no-underline ms-auto"
        >
          retry
        </button>
      </div>
    );
  }

  return (
    <div className="text-xs px-3 py-2 rounded-lg bg-brand/10 border border-brand/30">
      <div className="text-slate-200 font-medium mb-1.5 flex items-center gap-1.5">
        <Sparkles size={12} className="text-ai" />
        Proposed change
      </div>
      <div className="text-slate-100 mb-2">{description}</div>
      <div className="flex gap-2">
        <button
          onClick={() => void onApply()}
          className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded-md text-xs font-semibold flex items-center gap-1"
        >
          <CheckCircle2 size={12} /> Apply
        </button>
        <button
          onClick={onDiscard}
          className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded-md text-xs flex items-center gap-1"
        >
          <XIcon size={12} /> Discard
        </button>
      </div>
    </div>
  );
}
