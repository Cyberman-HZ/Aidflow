// Theme toggle — cycles through light → dark → system → light...
//
// Sits next to the language switcher in the top bar. The current resolved
// theme is shown via the icon (sun for light, moon for dark, monitor for
// system). Clicking advances to the next state and persists immediately
// via the settings store.

import { Sun, Moon, Monitor, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, type ThemePref } from '@/stores/settingsStore';

const ORDER: ThemePref[] = ['light', 'dark', 'system'];

const ICONS: Record<ThemePref, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export default function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  const Icon = ICONS[theme];

  // Friendly label fallback so the button still works without translation
  // entries (the keys are added in the locale files but the chain ends in
  // English defaults if a key is missing).
  const labels: Record<ThemePref, string> = {
    light: t('theme.light') ?? 'Light',
    dark: t('theme.dark') ?? 'Dark',
    system: t('theme.system') ?? 'System',
  };

  return (
    <button
      onClick={() => setTheme(next)}
      className="touch-target inline-flex items-center gap-1.5 px-3 py-2 bg-surface hover:bg-surface-light border border-slate-700 rounded-lg text-xs text-slate-200 transition-colors"
      aria-label={`${t('theme.toggle') ?? 'Theme'}: ${labels[theme]}. ${t('theme.switch_to') ?? 'Switch to'} ${labels[next]}.`}
      title={`${labels[theme]} → ${labels[next]}`}
    >
      <Icon size={14} />
      <span className="hidden sm:inline">{labels[theme]}</span>
    </button>
  );
}
