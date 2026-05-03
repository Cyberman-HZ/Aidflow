import { useTranslation } from 'react-i18next';
import type { PriorityLevel } from '@/types';

const STYLES: Record<PriorityLevel, string> = {
  CRITICAL: 'bg-priority-critical/20 text-priority-critical ring-1 ring-priority-critical/40',
  HIGH: 'bg-priority-high/20 text-priority-high ring-1 ring-priority-high/40',
  MEDIUM: 'bg-priority-medium/20 text-priority-medium ring-1 ring-priority-medium/40',
  NORMAL: 'bg-priority-normal/20 text-priority-normal ring-1 ring-priority-normal/40',
};

export default function PriorityBadge({
  level,
  score,
  size = 'md',
}: {
  level: PriorityLevel;
  score?: number;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { t } = useTranslation();
  const sizes = {
    sm: 'text-[10px] px-1.5 py-0.5 gap-1',
    md: 'text-xs px-2 py-0.5 gap-1.5',
    lg: 'text-sm px-3 py-1 gap-2',
  }[size];

  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full ${sizes} ${STYLES[level]} whitespace-nowrap`}
    >
      <span className="uppercase tracking-wide">{t(`priority.${level}`)}</span>
      {typeof score === 'number' && <span className="opacity-70">· {score}</span>}
    </span>
  );
}

export function levelFromScore(score: number): PriorityLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'NORMAL';
}
