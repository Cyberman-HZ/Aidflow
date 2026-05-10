import {
  Clock,
  Truck,
  CheckCircle2,
  XCircle,
  AlertOctagon,
} from 'lucide-react';
import type { DistributionStatus } from '@/types';

const STATUS_META: Record<
  DistributionStatus,
  { label: string; cls: string; icon: typeof Clock }
> = {
  pending: {
    label: 'Pending',
    cls: 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/40',
    icon: Clock,
  },
  out_for_delivery: {
    label: 'Out for delivery',
    cls: 'bg-priority-medium/15 text-priority-medium ring-1 ring-priority-medium/40',
    icon: Truck,
  },
  delivered: {
    label: 'Delivered',
    cls: 'bg-priority-normal/15 text-priority-normal ring-1 ring-priority-normal/40',
    icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    cls: 'bg-priority-critical/15 text-priority-critical ring-1 ring-priority-critical/40',
    icon: AlertOctagon,
  },
  cancelled: {
    label: 'Cancelled',
    cls: 'bg-slate-700/40 text-slate-400 ring-1 ring-slate-600/40 line-through decoration-2',
    icon: XCircle,
  },
};

const SIZES = {
  sm: { wrap: 'text-[10px] px-1.5 py-0.5 gap-1', icon: 10 },
  md: { wrap: 'text-xs px-2 py-0.5 gap-1.5', icon: 12 },
  lg: { wrap: 'text-sm px-3 py-1 gap-2', icon: 14 },
};

export default function StatusBadge({
  status,
  size = 'md',
}: {
  status: DistributionStatus;
  size?: 'sm' | 'md' | 'lg';
}) {
  const m = STATUS_META[status];
  const s = SIZES[size];
  const Icon = m.icon;
  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full whitespace-nowrap ${s.wrap} ${m.cls}`}
    >
      <Icon size={s.icon} />
      <span className="uppercase tracking-wide">{m.label}</span>
    </span>
  );
}

/** Which statuses a given status is allowed to transition to. */
export const ALLOWED_TRANSITIONS: Record<DistributionStatus, DistributionStatus[]> = {
  pending: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'failed', 'cancelled'],
  delivered: [], // terminal
  failed: ['out_for_delivery'], // can retry
  cancelled: [], // terminal
};
