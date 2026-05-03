import { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      className={`bg-surface rounded-xl border border-slate-700 ${className}`}
    >
      {(title || action) && (
        <header className="px-5 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent = 'brand',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: 'brand' | 'critical' | 'high' | 'medium' | 'normal' | 'ai';
  icon?: ReactNode;
}) {
  const accentMap: Record<string, string> = {
    brand: 'text-brand',
    critical: 'text-priority-critical',
    high: 'text-priority-high',
    medium: 'text-priority-medium',
    normal: 'text-priority-normal',
    ai: 'text-ai',
  };
  return (
    <div className="bg-surface rounded-xl border border-slate-700 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400 uppercase tracking-wider font-medium">{label}</span>
        {icon && <div className={accentMap[accent]}>{icon}</div>}
      </div>
      <div className={`text-2xl font-bold ${accentMap[accent]}`}>{value}</div>
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}
