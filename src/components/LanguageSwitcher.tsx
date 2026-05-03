import { Globe } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Lang } from '@/stores/settingsStore';

const LANGS: { code: Lang; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'es', label: 'Spanish', native: 'Español' },
];

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const lang = useSettingsStore((s) => s.language);
  const setLang = useSettingsStore((s) => s.setLanguage);

  return (
    <label
      className={`flex items-center gap-2 ${
        compact ? 'text-xs' : 'text-sm'
      } text-slate-300`}
    >
      <Globe size={compact ? 14 : 16} aria-hidden />
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        className="bg-surface border border-slate-600 rounded px-2 py-1 text-slate-100 focus:border-brand"
        aria-label="Language"
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
    </label>
  );
}
