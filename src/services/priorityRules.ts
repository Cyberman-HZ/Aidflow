// Deterministic rule-based priority scoring engine.
// Used (a) as the offline / "Disconnected" fallback when Ollama is unreachable
// and (b) by the AI prompt as the canonical rubric.
// Algorithm extends PDF Appendix C with two extra factors:
//   * Pending-needs count — each unmet need on the family card adds slightly
//     to urgency (capped so a long list doesn't dominate).
//   * Aid delivery history — recent successful deliveries lower the score
//     (the family has been served), recent failed/cancelled attempts raise
//     it (their attempt failed, the need is still unmet).

import type {
  AidDistribution,
  Family,
  NeededItem,
  PrioritizationResult,
  PriorityLevel,
} from '@/types';

function levelFromScore(score: number): PriorityLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'NORMAL';
}

// Default-quantity recipe per dependent person:
//   * infant formula scales with children<5
//   * prenatal supplements: 1 per pregnant member
//   * soft food kit: 1 per elderly member
//   * everything else: 1 per family
function recommend(family: Family): NeededItem[] {
  const items: NeededItem[] = [];
  const push = (name: string, quantity = 1) => {
    if (!items.some((x) => x.name === name)) items.push({ name, quantity });
  };

  if (family.children_under_5 > 0) {
    push('infant formula', family.children_under_5);
    push('high-protein rations', family.children_under_5);
  }
  if (family.has_pregnant_member) push('prenatal supplements', 1);
  if (family.elderly_count > 0) push('soft food kit', family.elderly_count);
  const medsLower = family.medical_conditions.join(' ').toLowerCase();
  if (medsLower.includes('diabet')) push('diabetic-safe rations');
  if (medsLower.includes('cholera') || medsLower.includes('diarrh')) {
    push('oral rehydration salts', 2);
    push('water purification');
  }
  if (medsLower.includes('tubercul')) {
    push('TB hygiene kit');
    push('medical referral');
  }
  if (medsLower.includes('malaria')) {
    push('mosquito net', Math.max(1, Math.ceil(family.member_count / 2)));
    push('antimalarials');
  }
  if (medsLower.includes('asthma')) {
    push('inhaler');
    push('masks');
  }
  if (family.displacement_status !== 'resident') {
    push('shelter tarp');
    push('blankets', family.member_count);
  }
  if (items.length === 0) {
    push('family food parcel');
    push('drinking water', Math.max(1, Math.ceil(family.member_count / 2)));
  }
  // Cap at 4 entries
  return items.slice(0, 4);
}

/**
 * Compute the rule-based priority for a family.
 *
 * @param family The family record (priority cache may be stale; we recompute
 *   from the source-of-truth fields below).
 * @param distributions Optional list of THIS family's distribution orders.
 *   When provided, the score factors in recent delivery history. Pass an
 *   empty array (or omit) when distribution data isn't readily available —
 *   the score will simply ignore those factors.
 */
export function computeRuleScore(
  family: Family,
  distributions: AidDistribution[] = []
): PrioritizationResult {
  let score = 0;
  const reasons: string[] = [];

  if (family.children_under_5 > 0) {
    score += family.children_under_5 * 20;
    reasons.push(`${family.children_under_5} child(ren) under 5`);
  }
  if (family.has_pregnant_member) {
    score += 15;
    reasons.push('pregnant/nursing member');
  }
  if (family.elderly_count > 0) {
    score += family.elderly_count * 10;
    reasons.push(`${family.elderly_count} elderly`);
  }

  for (const cond of family.medical_conditions) {
    if (cond.toLowerCase().includes('critical')) score += 25;
    else if (cond.toLowerCase().includes('chronic')) score += 10;
    else score += 8;
  }
  if (family.medical_conditions.length) {
    reasons.push(`${family.medical_conditions.length} medical condition(s)`);
  }

  const days = family.last_aid_at
    ? Math.floor((Date.now() - new Date(family.last_aid_at).getTime()) / 86_400_000)
    : 30;
  if (days >= 0 && days < 5) {
    // Multiplicative damping so the score visibly drops even for very vulnerable
    // families whose raw score would otherwise saturate at 100. Recovers over 5 days.
    const damping = 0.5 + days * 0.1;
    score = Math.round(score * damping);
    const label =
      days === 0 ? 'served today' : days === 1 ? 'served yesterday' : `served ${days}d ago`;
    reasons.push(label);
  } else {
    score += days * 2;
    reasons.push(`${days} days without aid`);
  }

  if (family.displacement_status === 'recently_displaced') {
    score += 15;
    reasons.push('recently displaced');
  } else if (family.displacement_status === 'refugee') {
    score += 10;
    reasons.push('refugee');
  }

  if (family.income_level === 'none') {
    score += 15;
    reasons.push('no income');
  } else if (family.income_level === 'minimal') {
    score += 5;
  }

  if (family.new_need_flagged) {
    score += 20;
    reasons.push('new need flagged');
  }

  if (family.member_count > 8) {
    score = Math.round(score * 0.9);
  }

  // ---- Needed-items factor ----------------------------------------------
  const neededItemsCount = family.recommended_items?.length ?? 0;
  if (neededItemsCount > 0) {
    const bump = Math.min(10, neededItemsCount * 2);
    score += bump;
    reasons.push(
      `${neededItemsCount} unmet need${neededItemsCount === 1 ? '' : 's'} listed`
    );
  }

  // ---- Distribution history factor --------------------------------------
  if (distributions.length > 0) {
    const now = Date.now();
    const cutoff = now - 30 * 86_400_000;

    const recentDelivered = distributions.filter(
      (d) =>
        d.status === 'delivered' &&
        d.delivered_at &&
        new Date(d.delivered_at).getTime() >= cutoff
    ).length;
    const recentFailed = distributions.filter(
      (d) =>
        (d.status === 'failed' || d.status === 'cancelled') &&
        d.closed_at &&
        new Date(d.closed_at).getTime() >= cutoff
    ).length;

    if (recentDelivered > 0) {
      const credit = Math.min(15, recentDelivered * 5);
      score -= credit;
      reasons.push(
        `${recentDelivered} delivery${recentDelivered === 1 ? '' : 'ies'} in last 30 days`
      );
    }
    if (recentFailed > 0) {
      score += recentFailed * 5;
      reasons.push(
        `${recentFailed} failed/cancelled attempt${recentFailed === 1 ? '' : 's'} in last 30 days`
      );
    }
  }

  // Clamp into the 0–100 band that levelFromScore expects.
  score = Math.max(0, Math.min(100, score));

  return {
    family_id: family.family_id,
    priority_score: score,
    priority_level: levelFromScore(score),
    reason: reasons.join('; '),
    recommended_items: recommend(family),
  };
}

/**
 * Sort an array of PrioritizationResult by descending priority score (default)
 * or ascending. Used by the Families list to render the most urgent family
 * first.
 */
export function sortByScore(
  results: PrioritizationResult[],
  direction: 'desc' | 'asc' = 'desc'
): PrioritizationResult[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...results].sort((a, b) => sign * (a.priority_score - b.priority_score));
}
