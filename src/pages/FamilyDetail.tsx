import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, MapPin, Heart, Users, Baby, Sparkles, Calendar, CheckCircle2 } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import { Card } from '@/components/Card';
import PriorityBadge from '@/components/PriorityBadge';
import StatusBadge from '@/components/StatusBadge';
import EmptyState from '@/components/EmptyState';
import AIChat from '@/components/AIChat';
import type { Family, AidDistribution } from '@/types';

export default function FamilyDetail() {
  const { id } = useParams();
  const { t } = useTranslation();

  // Live queries — auto-refresh whenever the underlying tables change
  // (e.g. after a delivery confirmed in the Distribute tab).
  const family = useLiveQuery(
    () => (id ? db.families.get(id) : undefined),
    [id]
  ) as Family | undefined;
  const history =
    useLiveQuery(
      () =>
        id
          ? db.distributions
              .where('family_id')
              .equals(id)
              .toArray()
              .then((rows) =>
                rows.sort((a, b) =>
                  (b.delivered_at ?? b.created_at ?? '').localeCompare(
                    a.delivered_at ?? a.created_at ?? ''
                  )
                )
              )
          : Promise.resolve([] as AidDistribution[]),
      [id]
    ) ?? [];

  if (!family) {
    return (
      <div>
        <Link to="/families" className="text-sm text-brand hover:underline inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Families
        </Link>
        <Card><EmptyState title="Family not found" /></Card>
      </div>
    );
  }

  const rule = computeRuleScore(family);
  const score = family.priority_score ?? rule.priority_score;
  const level = family.priority_level ?? rule.priority_level;
  const reason = family.ai_reason ?? rule.reason;
  const recommended = family.recommended_items ?? rule.recommended_items;

  return (
    <div className="space-y-5">
      <Link to="/families" className="text-sm text-brand hover:underline inline-flex items-center gap-1">
        <ArrowLeft size={14} /> {t('families.title')}
      </Link>

      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{family.head_name}</h1>
          <div className="text-sm text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{t('family_detail.title', { id: family.family_id })}</span>
            <span>·</span>
            <span><MapPin size={12} className="inline" /> {family.location_sector}</span>
            <span>·</span>
            <LastAidIndicator lastAidAt={family.last_aid_at} />
          </div>
        </div>
        <PriorityBadge level={level} score={score} size="lg" />
      </header>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title={t('family_detail.demographics')} className="lg:col-span-1">
          <dl className="space-y-3 text-sm">
            <Row icon={<Users size={14} />} label={t('families.members')} value={family.member_count} />
            <Row icon={<Baby size={14} />} label={t('families.children_under5')} value={family.children_under_5} />
            <Row icon={<Heart size={14} />} label={t('families.elderly')} value={family.elderly_count} />
            {family.has_pregnant_member && (
              <Row icon={<Heart size={14} />} label={t('families.pregnant')} value="Yes" />
            )}
            <Row label={t('family_detail.displacement')} value={family.displacement_status} />
            <Row label={t('family_detail.income')} value={family.income_level} />
          </dl>
        </Card>

        <Card title={t('family_detail.medical')} className="lg:col-span-2">
          {family.medical_conditions.length === 0 ? (
            <p className="text-sm text-slate-400">No medical conditions on record.</p>
          ) : (
            <ul className="text-sm space-y-1.5">
              {family.medical_conditions.map((c, i) => (
                <li
                  key={i}
                  className={`px-3 py-2 rounded-lg border ${
                    c.toLowerCase().includes('critical')
                      ? 'bg-priority-critical/10 border-priority-critical/30 text-priority-critical'
                      : 'bg-surface-light border-slate-700'
                  }`}
                >
                  {c}
                </li>
              ))}
            </ul>
          )}
          {family.notes && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="text-xs text-slate-400 mb-1 font-medium">Field notes</div>
              <p className="text-sm text-slate-200">{family.notes}</p>
            </div>
          )}
        </Card>
      </div>

      <Card title={
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-ai" />
          {t('family_detail.ai_breakdown')}
        </div>
      }>
        <p className="text-sm text-slate-200 mb-3">{reason}</p>
        <div className="flex flex-wrap gap-2">
          {recommended.map((item) => (
            <span
              key={item}
              className="text-xs bg-ai/15 text-ai border border-ai/30 px-2 py-1 rounded-full"
            >
              {item}
            </span>
          ))}
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-5 lg:items-stretch">
        <Card title={t('family_detail.history')}>
          {history.length === 0 ? (
            <EmptyState title={t('family_detail.no_history')} icon={<Calendar size={24} />} />
          ) : (
            <ul className="divide-y divide-slate-700">
              {history.map((d) => (
                <li key={d.distribution_id} className="py-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={d.status} size="sm" />
                        <span className="text-xs text-slate-500">{d.distribution_id}</span>
                      </div>
                      <div className="text-sm">
                        {d.items_distributed.map((i) => `${i.item_name} ×${i.quantity}`).join(', ')}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {new Date(d.delivered_at ?? d.created_at ?? '').toLocaleDateString()}{' '}
                        · {d.delivered_by ?? d.assigned_to ?? d.distributed_by ?? '—'}
                      </div>
                    </div>
                    <PriorityBadge
                      level={
                        d.ai_priority_score >= 80 ? 'CRITICAL'
                          : d.ai_priority_score >= 60 ? 'HIGH'
                          : d.ai_priority_score >= 40 ? 'MEDIUM' : 'NORMAL'
                      }
                      score={d.ai_priority_score}
                      size="sm"
                    />
                  </div>
                  {d.post_update_notes && (
                    <p className="text-xs text-slate-300 mt-1.5 bg-surface-light px-3 py-1.5 rounded">
                      {d.post_update_notes}
                    </p>
                  )}
                  {d.failure_reason && (
                    <p className="text-xs text-priority-critical mt-1.5 italic">
                      {d.status === 'failed' ? 'Failed: ' : 'Cancelled: '}{d.failure_reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            {t('family_detail.ask_about')}
          </h3>
          <AIChat
            systemPrompt={`You are AidFlow Pro's AI assistant powered by Gemma 4. You are answering questions about family ${family.family_id} (${family.head_name}). Family data: ${JSON.stringify(
              {
                ...family,
                last_aid_at: family.last_aid_at,
              }
            )}. Be concise, practical, and reference the family's specific situation.`}
            contextLabel={`Family ${family.family_id} — ${family.head_name}`}
            placeholder={t('assistant.placeholder')}
          />
        </div>
      </div>
    </div>
  );
}

function LastAidIndicator({ lastAidAt }: { lastAidAt?: string }) {
  if (!lastAidAt) {
    return <span className="text-priority-medium">Last aid: never</span>;
  }
  const days = Math.floor((Date.now() - new Date(lastAidAt).getTime()) / 86_400_000);
  const label =
    days <= 0 ? 'served today' : days === 1 ? 'served yesterday' : `${days}d ago`;
  const colorClass =
    days < 3 ? 'text-priority-normal' : days < 7 ? 'text-priority-medium' : 'text-priority-high';
  return (
    <span className={`flex items-center gap-1 ${colorClass}`}>
      {days < 3 && <CheckCircle2 size={12} />}
      Last aid: {label}
    </span>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400 capitalize flex items-center gap-2">
        {icon}
        {label.replace('_', ' ')}
      </dt>
      <dd className="text-slate-100 font-medium">{value}</dd>
    </div>
  );
}
