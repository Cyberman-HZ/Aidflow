import { ReactNode } from 'react';

export default function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-4">
      {icon && <div className="mx-auto mb-3 text-slate-500">{icon}</div>}
      <h3 className="text-base font-medium text-slate-200">{title}</h3>
      {body && <p className="text-sm text-slate-400 mt-1">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
