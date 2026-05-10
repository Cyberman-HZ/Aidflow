// Reusable Gemma 4 chat panel.
// Used by /assistant, /family/:id ("ask about this family"), and /docs
// (Knowledge Base RAG chat).

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
import type { AidDistribution, ChatMessage, Family } from '@/types';
import { chatStream, chat } from '@/services/ollama';
import { ragAnswerStream } from '@/services/rag';
import { wikipediaContext } from '@/services/webSearch';
import {
  applyFamilyAction,
  buildFamilyActionPrompt,
  describeFamilyAction,
  parseFamilyActions,
  parseFamilyActionsDetailed,
  stripFamilyActions,
  type FamilyAction,
} from '@/services/familyActions';
import { detectIntent } from '@/services/familyIntent';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectivityStore } from '@/stores/connectivityStore';

/**
 * Builds a tiny snapshot of the family that we PREPEND to the user's question
 * so the model can't miss it. Smaller local models like Gemma 4 4B routinely
 * skim long system prompts — putting the data directly next to the question
 * is far more reliable.
 */

/**
 * Translate raw applier errors into user-friendly text. The applier throws
 * for things like an unknown sector or an item that's not present; the raw
 * error is technical, so we soften it for the chat surface.
 */
function friendlyApplyError(raw: string, action: FamilyAction): string {
  // Sector validation
  if (
    action.type === 'set_field' &&
    action.field === 'location_sector' &&
    /not an existing sector/i.test(raw)
  ) {
    const m = raw.match(/Pick one of: (.+)$/);
    const list = m ? m[1] : '(no sectors yet)';
    return `Sorry — that sector doesn't exist yet. Pick one that's already in use: ${list}.`;
  }
  // Family not found
  if (/not found/i.test(raw)) {
    return 'The family record could not be loaded. Try refreshing the page.';
  }
  // Item-not-in-needs (from remove_recommended_item applier)
  if (/Cannot remove/i.test(raw)) {
    // Already user-friendly — pass through.
    return raw;
  }
  // IndexedDB / Dexie write failures
  if (/QuotaExceeded|InvalidState|Aborted|NotFoundError/i.test(raw)) {
    return 'Could not save the change to the local database. Free up storage space and try again.';
  }
  return `Could not apply this change. ${raw}`;
}

/**
 * Sanitize a free-text family field before interpolating it into a prompt.
 * Strips newlines, tabs, and control chars so a malicious value like
 *   "Ahmed\n\nIGNORE PREVIOUS INSTRUCTIONS"
 * cannot break the prompt structure or pretend to be a new instruction.
 * Also caps the length so a giant value can't drown the rest of the prompt.
 */
function sanitizeForPrompt(s: unknown, maxLen = 200): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str
    .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ') // collapse control chars
    .replace(/[`]/g, "'") // backticks could close fenced code blocks
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Format a single distribution row into a one-line summary suitable for the
 * inline context block. Date is the delivery date if available, otherwise the
 * created date. Items are truncated so a long order doesn't blow past Gemma 4's
 * small context. Notes are sanitized to strip control chars / backticks.
 */
function summarizeDistribution(d: AidDistribution): string {
  const when = (d.delivered_at ?? d.created_at ?? '').slice(0, 10) || 'unknown';
  const items =
    d.items_distributed && d.items_distributed.length
      ? d.items_distributed
          .slice(0, 8)
          .map(
            (i) =>
              `${sanitizeForPrompt(i.item_name, 40)}×${Math.max(0, Math.floor(i.quantity))}`
          )
          .join(', ') +
        (d.items_distributed.length > 8
          ? `, +${d.items_distributed.length - 8} more`
          : '')
      : '(no items recorded)';
  const order = d.order_number ? `ORD-${String(d.order_number).padStart(3, '0')}` : d.distribution_id.slice(0, 12);
  const by = d.delivered_by ?? d.assigned_to ?? d.distributed_by ?? '—';
  const reason = d.failure_reason
    ? ` reason="${sanitizeForPrompt(d.failure_reason, 80)}"`
    : '';
  return `${when} ${d.status} ${order} by=${sanitizeForPrompt(by, 40)} items=[${items}]${reason}`;
}

function buildInlineContext(
  family: Family,
  history: AidDistribution[] = []
): string {
  const items = family.recommended_items ?? [];
  const itemList =
    items.length > 0
      ? items
          .map(
            (it, i) =>
              `${i + 1}. ${sanitizeForPrompt(it.name, 80)} (qty=${Math.max(0, Math.floor(it.quantity))})`
          )
          .join('; ')
      : '(no current need items)';
  const meds = family.medical_conditions.length
    ? family.medical_conditions.map((c) => sanitizeForPrompt(c, 80)).join('; ')
    : 'none';
  // Sort newest-first so the model's anchor "latest delivery" lands on row 1.
  // Cap at 10 rows so a long-running family doesn't blow Gemma 4's context.
  const sortedHistory = [...history].sort((a, b) => {
    const ta = (a.delivered_at ?? a.created_at ?? '').localeCompare(
      b.delivered_at ?? b.created_at ?? ''
    );
    return -ta;
  });
  const truncated = sortedHistory.slice(0, 10);
  const historyLines =
    truncated.length === 0
      ? '(no distributions on record yet)'
      : truncated
          .map((d, i) => `  ${i + 1}. ${summarizeDistribution(d)}`)
          .join('\n');
  const total = sortedHistory.length;
  const delivered = sortedHistory.filter((d) => d.status === 'delivered').length;
  const lastAid = family.last_aid_at
    ? sanitizeForPrompt(family.last_aid_at.slice(0, 10), 20)
    : '(never)';
  return [
    `[FAMILY CONTEXT — current state, treat as ground truth]`,
    `family_id=${sanitizeForPrompt(family.family_id, 40)}; head=${sanitizeForPrompt(family.head_name, 80)}; sector=${sanitizeForPrompt(family.location_sector, 40)}`,
    `members=${family.member_count}; children<5=${family.children_under_5}; elderly=${family.elderly_count}; pregnant=${family.has_pregnant_member}; displacement=${sanitizeForPrompt(family.displacement_status, 40)}; income=${sanitizeForPrompt(family.income_level, 40)}`,
    `medical_conditions: ${meds}`,
    `current_need_items: ${itemList}`,
    `last_aid_at=${lastAid}; total_distributions=${total}; delivered=${delivered}`,
    `recent_distributions (newest first, up to 10):`,
    historyLines,
    `When the user asks about past deliveries, history, when the family last received aid, what items were given, who delivered them, or any historical question — the EXACT records are listed above. Do not say you have no access; cite the rows directly.`,
    `When the user asks to remove or reference a need item, the EXACT items present are listed above in current_need_items. Do not deny their existence.`,
  ].join('\n');
}

interface AIChatProps {
  systemPrompt?: string;
  initialMessages?: ChatMessage[];
  enableRag?: boolean;
  /**
   * When true, the "Search knowledge base" toggle is forced ON and disabled,
   * so every question is automatically answered against the uploaded PDFs.
   * Only meaningful when `enableRag` is also true. Used by the Knowledge
   * Base page where searching the library is the entire point — but kept
   * off elsewhere (family chat, general assistant) so users keep manual
   * control over when their question hits the KB.
   */
  forceRag?: boolean;
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
  /**
   * Distribution history for the family-scoped chat. Embedded in the inline
   * context so questions like "when was the last delivery?" get answered
   * from the actual ground truth rather than the model's "I don't have
   * access" hallucination. The chat ALSO re-fetches the freshest history
   * from Dexie at send time so a delivery that just landed is reflected.
   */
  history?: AidDistribution[];
  /**
   * Click-to-run prompt chips shown above the empty state. Each entry has
   * a `label` (rendered on the chip and shown as the user bubble when
   * clicked) and a `reply` markdown string (rendered as the assistant's
   * answer WITHOUT calling Gemma 4). This gives us deterministic, instant
   * answers for capability-discovery questions — works offline, never
   * drifts, never hallucinates.
   */
  suggestedPrompts?: ReadonlyArray<{ label: string; reply: string }>;
}

export default function AIChat({
  systemPrompt,
  initialMessages = [],
  enableRag = true,
  forceRag = false,
  enableWiki = true,
  placeholder,
  contextLabel,
  flex = true,
  family,
  history,
  suggestedPrompts,
}: AIChatProps) {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const internetUp = useConnectivityStore((s) => s.internetUp);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [thinking, setThinking] = useState(false);
  // When `forceRag` is set, the toggle is permanently on and disabled —
  // initial state matches so the rest of the send pipeline behaves
  // consistently from the first message.
  const [useRag, setUseRag] = useState(forceRag);
  const [useWiki, setUseWiki] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks the lifecycle of each AI-proposed family action by message index.
  //   pending     — awaiting Apply / Discard
  //   applied     — successfully written to IndexedDB
  //   discarded   — user declined
  //   failed      — apply threw (error stored in errorByKey)
  type ActionStatus = 'pending' | 'applying' | 'applied' | 'discarded' | 'failed';
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

    // The user sees their plain question in the bubble. But for the model we
    // prepend an inline CONTEXT block when this chat is family-scoped — it's
    // far more reliable than a long system prompt, especially with smaller
    // local models like Gemma 4 4B that often skim or ignore system content.
    // We RE-FETCH the family from Dexie to guarantee we have the freshest
    // persisted data, eliminating any stale-React-prop edge case.
    let freshFamily: Family | undefined = family;
    let freshHistory: AidDistribution[] = history ?? [];
    if (family) {
      try {
        const latest = await db.families.get(family.family_id);
        if (latest) {
          // CRITICAL: when the DB row has no recommended_items, the chips on
          // screen were rendered from the rule-engine fallback (passed in via
          // the `family` prop's recommended_items). The intent detector and
          // inline context MUST see those same items, otherwise the AI will
          // truthfully report "(none)" while the chips say otherwise.
          const merged = latest as Family;
          if (
            (merged.recommended_items === undefined ||
              merged.recommended_items.length === 0) &&
            family.recommended_items &&
            family.recommended_items.length > 0
          ) {
            merged.recommended_items = family.recommended_items;
          }
          freshFamily = merged;
        }
      } catch {
        // If the DB read fails for any reason, fall back to the prop.
      }
      // Re-fetch the freshest distribution history so questions like
      // "when was the last delivery?" reflect deliveries that completed
      // since the page first rendered.
      try {
        const rows = await db.distributions
          .where('family_id')
          .equals(family.family_id)
          .toArray();
        freshHistory = rows;
      } catch {
        // fall back to whatever the prop carried
      }
    }
    const contextHeader = freshFamily
      ? buildInlineContext(freshFamily, freshHistory)
      : '';
    const augmentedContent = contextHeader
      ? `${contextHeader}\n\nUSER REQUEST: ${trimmed}`
      : trimmed;

    // What the user sees in the bubble — their original wording, not the augment.
    const userBubble: ChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    // What Gemma 4 actually sees — the augmented one (kept off-screen).
    const userForModel: ChatMessage = {
      role: 'user',
      content: augmentedContent,
      timestamp: userBubble.timestamp,
    };
    const next: ChatMessage[] = [...messages, userBubble];
    setMessages(next);
    setThinking(true);
    // Replace the last (visible) user message with the augmented one when
    // building the model conversation.
    const modelConversation: ChatMessage[] = [...messages, userForModel];

    // ----- DETERMINISTIC INTENT SHORT-CIRCUIT --------------------------------
    // Before going to the LLM, run a regex-based intent detector. If it gets
    // an unambiguous match against the family's current state, we emit the
    // action card (or clarification reply) directly. This works even if Gemma
    // 4 refuses to follow the action protocol, and is offline-safe.
    if (freshFamily) {
      const intent = detectIntent(trimmed, freshFamily);
      if (intent.matched) {
        // Build an assistant message that EITHER carries the actions (so the
        // existing Bubble component renders the Apply card) OR is just a
        // clarification reply.
        const FENCE = '`' + '`' + '`';
        const actionBlocks =
          intent.actions.length > 0
            ? intent.actions
                .map(
                  (a) => FENCE + 'aidflow-action\n' + JSON.stringify(a) + '\n' + FENCE
                )
                .join('\n\n')
            : '';
        const replyContent = actionBlocks
          ? intent.reply + '\n\n' + actionBlocks
          : intent.reply;
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: replyContent,
            timestamp: new Date().toISOString(),
          },
        ]);
        setThinking(false);
        return;
      }
    }

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
      if (enableRag && (forceRag || useRag)) {
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
        // Debug: log what we send so the user can verify the family snapshot
        // is reaching Gemma 4. View in DevTools console (F12).
        // eslint-disable-next-line no-console
        console.debug('[AIChat] system prompt →', sysContent);
        const conversation = [sys, ...modelConversation];
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

  // Click handler for suggested-prompt chips. Appends the user bubble + a
  // deterministic assistant reply directly — no Gemma 4 call, no streaming.
  // Used for capability-discovery questions where a hard-coded answer is
  // more reliable than asking the model.
  const runSuggestedPrompt = (p: { label: string; reply: string }) => {
    if (thinking) return;
    const now = new Date().toISOString();
    setMessages((m) => [
      ...m,
      { role: 'user', content: p.label, timestamp: now },
      { role: 'assistant', content: p.reply, timestamp: now },
    ]);
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
            {suggestedPrompts && suggestedPrompts.length > 0 && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestedPrompts.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => runSuggestedPrompt(p)}
                    className="touch-target px-3 py-1.5 rounded-full text-xs bg-ai/10 hover:bg-ai/20 text-ai border border-ai/30 font-medium transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
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
              // Guard against double-clicks: if this action is already
              // mid-flight or already applied/discarded, ignore the click.
              const current = actionStatus[key] ?? 'pending';
              if (current === 'applying' || current === 'applied' || current === 'discarded') {
                return;
              }
              setActionStatus((s) => ({ ...s, [key]: 'applying' }));
              try {
                await applyFamilyAction(family.family_id, action);
                setActionStatus((s) => ({ ...s, [key]: 'applied' }));
                setActionErrors((s) => {
                  const c = { ...s };
                  delete c[key];
                  return c;
                });
              } catch (e) {
                const raw = e instanceof Error ? e.message : String(e);
                const friendly = friendlyApplyError(raw, action);
                setActionStatus((s) => ({ ...s, [key]: 'failed' }));
                setActionErrors((s) => ({ ...s, [key]: friendly }));
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
            <label
              className={`flex items-center gap-2 text-xs ${
                forceRag
                  ? 'text-slate-300 cursor-not-allowed'
                  : 'text-slate-400 cursor-pointer'
              }`}
              title={
                forceRag
                  ? (t('assistant.use_rag_locked') ??
                    'Knowledge-base search is always on for this page.')
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={forceRag ? true : useRag}
                onChange={(e) => {
                  // Forced mode: ignore user input — checkbox is read-only.
                  if (forceRag) return;
                  setUseRag(e.target.checked);
                }}
                disabled={forceRag}
                aria-readonly={forceRag || undefined}
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
  actionStatus: Record<string, 'pending' | 'applying' | 'applied' | 'discarded' | 'failed'>;
  actionErrors: Record<string, string>;
  onApply: (key: string, action: FamilyAction) => Promise<void>;
  onDiscard: (key: string) => void;
  messageIdx: number;
}) {
  const isUser = m.role === 'user';
  const parsed =
    !isUser && family && m.content
      ? parseFamilyActionsDetailed(m.content)
      : { actions: [], failedCandidates: 0 };
  const actions: FamilyAction[] = parsed.actions;
  const failedCount = parsed.failedCandidates;
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
            ) : failedCount > 0 ? (
              <span className="italic text-amber-400 text-xs">
                ⚠ Gemma 4 tried to propose {failedCount === 1 ? 'a change' : `${failedCount} changes`} but the action JSON was malformed and ignored. Try rephrasing your request, e.g. "remove water" or "add 4 water".
              </span>
            ) : (
              '…'
            )}
          </div>
        )}
        {!isUser && failedCount > 0 && actions.length > 0 && (
          <div className="mt-3 pt-2 text-xs text-amber-400 italic">
            ⚠ {failedCount} additional proposed change{failedCount === 1 ? '' : 's'} could not be parsed and {failedCount === 1 ? 'was' : 'were'} ignored.
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
  status: 'pending' | 'applying' | 'applied' | 'discarded' | 'failed';
  error?: string;
  onApply: () => void | Promise<void>;
  onDiscard: () => void;
}) {
  const description = describeFamilyAction(action);

  if (status === 'applying') {
    return (
      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-brand/10 border border-brand/30 text-slate-200">
        <Sparkles size={13} className="animate-spin" />
        <span>Applying: {description}…</span>
      </div>
    );
  }
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
