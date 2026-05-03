import { Loader2 } from 'lucide-react';

export default function Loading({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-400 text-sm">
      <Loader2 size={16} className="animate-spin text-brand" />
      {label && <span>{label}</span>}
    </div>
  );
}
