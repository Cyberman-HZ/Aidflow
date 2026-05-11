// DeleteFamilyModal — in-app confirmation dialog for soft-deleting a family.
//
// Why this exists (vs. relying on the browser's native confirm dialog):
//   1. Native browser confirm dialogs don't accept input — we need a
//      required free-text "reason for deletion" field for the audit
//      trail.
//   2. Native dialogs ignore the app's dark-teal theme and right-to-left
//      Arabic layout; this matches the rest of AidFlow Pro.
//   3. PWA / mobile webviews handle native dialogs inconsistently.
//
// Behavior contract:
//   - Reason is required (non-whitespace, >= 4 chars). Delete button
//     stays disabled until the reason validates.
//   - Esc cancels (unless a delete is mid-flight).
//   - Backdrop click cancels (unless mid-flight).
//   - Body scroll is locked while open.
//   - Focus jumps to the textarea on mount so the admin can start typing
//     immediately.
//
// The persistence is the caller's job — this component just collects
// confirmation + reason and surfaces it via onConfirm(reason).

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import type { Family } from '@/types';

/** Minimum non-whitespace chars required in the reason. Matches the
 *  hint shown next to the textarea so behaviour and UI agree. */
export const MIN_REASON_LENGTH = 4;

/** Pure helper exported for unit tests. Returns true when the trimmed
 *  reason meets the minimum length. */
export function isReasonValid(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LENGTH;
}

export default function DeleteFamilyModal({
  family,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  family: Family;
  deleting: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Called with the trimmed reason once the admin clicks Delete. */
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // a11y: Esc cancels (unless mid-delete), focus the textarea on mount,
  // lock body scroll so the page underneath doesn't move on mobile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    textareaRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [deleting, onCancel]);

  const reasonOk = isReasonValid(reason);
  const canDelete = reasonOk && !deleting;

  const submit = async () => {
    if (!canDelete) return;
    await onConfirm(reason.trim());
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-family-title"
      aria-describedby="delete-family-body"
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-priority-critical/40 rounded-xl shadow-2xl p-5 space-y-4"
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-priority-critical/15 text-priority-critical grid place-items-center flex-shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="delete-family-title"
              className="text-base font-bold text-slate-100"
            >
              {t('families_delete.title') ?? 'Delete family?'}
            </h2>
            <p id="delete-family-body" className="text-sm text-slate-300 mt-1">
              {t('families_delete.body', { name: family.head_name }) ??
                `Soft-delete the family record for ${family.head_name}. Historic distribution rows referencing this family will keep working, but the family will no longer appear in the registry.`}
            </p>
          </div>
        </div>

        {/* Reason — required */}
        <div>
          <label
            htmlFor="delete-family-reason"
            className="block text-xs font-semibold text-slate-300 mb-1.5"
          >
            {t('families_delete.reason_label') ?? 'Reason for deletion'}{' '}
            <span className="text-priority-critical" aria-hidden="true">*</span>
          </label>
          <textarea
            id="delete-family-reason"
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={deleting}
            placeholder={
              t('families_delete.reason_placeholder') ??
              'e.g. relocated out of operational area; duplicate of F-0123; data entry error'
            }
            aria-required="true"
            aria-invalid={reason.length > 0 && !reasonOk}
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-priority-critical outline-none resize-none disabled:opacity-50"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            {t('families_delete.reason_hint', { min: MIN_REASON_LENGTH }) ??
              `Required. At least ${MIN_REASON_LENGTH} characters. Stored on the row for audit.`}
          </p>
        </div>

        {/* Server / write error */}
        {error && (
          <div
            className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-700">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={deleting}
            type="button"
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded-lg text-sm flex items-center gap-1"
          >
            <X size={14} /> {t('common.cancel')}
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canDelete}
            type="button"
            className="touch-target px-4 py-2 bg-priority-critical hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold flex items-center gap-1"
            title={
              !reasonOk
                ? t('families_delete.reason_too_short') ??
                  'Enter a reason of at least 4 characters before deleting.'
                : undefined
            }
          >
            <Trash2 size={14} />
            {deleting
              ? t('common.saving') ?? 'Deleting…'
              : t('families_delete.delete') ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
