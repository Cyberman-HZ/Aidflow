// Deterministic rule-based priority scoring engine.
// Used (a) as the offline / "Disconnected" fallback when Ollama is unreachable
// and (b) by the AI prompt as the canonical rubric.
// Algorithm matches PDF Appendix C exactly.

import type { Family, PrioritizationResult, PriorityLevel } from '@/types';

function levelFromScore(score: number): PriorityLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'NORMAL';
}

function recommend(family: Family): string[] {
  const items: string[] = [];
  if (family.children_under_5 > 0) items.push('infant formula', 'high-protein rations');
  if (family.has_pregnant_member) items.push('prenatal supplements');
  if (family.elderly_count > 0) items.push('soft food kit');
  const medsLower = family.medical_conditions.join(' ').toLowerCase();
  if (medsLower.includes('diabet')) items.push('diabetic-safe rations');
  if (medsLower.includes('cholera') || medsLower.includes('diarrh'))
    items.push('oral rehydration salts', 'water purification');
  if (medsLower.includes('tubercul')) items.push('TB hygiene kit', 'medical referral');
  if (medsLower.includes('malaria')) items.push('mosquito net', 'antimalarials');
  if (medsLower.includes('asthma')) items.push('inhaler', 'masks');
  if (family.displacement_status !== 'resident') items.push('shelter tarp', 'blankets');
  if (items.length === 0) items.push('family food parcel', 'drinking water');
  // Dedupe + cap at 4
  return Array.from(new Set(items)).slice(0, 4);
}

export function computeRuleScore(family: Family): PrioritizationResult {
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
    //   day0 → ×0.5   day1 → ×0.6   day2 → ×0.7   day3 → ×0.8   day4 → ×0.9
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

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    family_id: family.family_id,
    priority_score: score,
    priority_level: levelFromScore(score),
    reason: reasons.length ? reasons.join('; ') + '.' : 'No urgent factors detected.',
    recommended_items: recommend(family),
    sector: family.location_sector,
  };
}

export function sortByScore(results: PrioritizationResult[]): PrioritizationResult[] {
  return [...results].sort((a, b) => b.priority_score - a.priority_score);
}
