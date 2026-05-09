// AidFlow Pro — Settings store (persisted in localStorage)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'en' | 'ar' | 'fr' | 'es';

/**
 * Tri-state theme preference.
 *  - 'light' / 'dark' — explicit user choice, stays put
 *  - 'system'         — follow the OS via prefers-color-scheme (default)
 *
 * The applied theme (light vs dark) is computed by `applyTheme` below;
 * 'system' is resolved at runtime against `matchMedia('(prefers-color-scheme: dark)')`.
 */
export type ThemePref = 'light' | 'dark' | 'system';

interface SettingsState {
  ollamaBaseUrl: string;
  ollamaModel: string;
  embedModel: string;
  language: Lang;
  /** User's preferred theme. Defaults to 'system' on first load. */
  theme: ThemePref;
  /**
   * @deprecated kept for backwards compatibility with persisted state from
   * before the tri-state theme landed. New code should use `theme`.
   */
  darkMode: boolean;
  setOllamaBaseUrl: (url: string) => void;
  setOllamaModel: (m: string) => void;
  setEmbedModel: (m: string) => void;
  setLanguage: (l: Lang) => void;
  setTheme: (t: ThemePref) => void;
  /** @deprecated use `setTheme` */
  setDarkMode: (d: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ollamaBaseUrl: import.meta.env.VITE_OLLAMA_BASE_URL || 'http://localhost:11434',
      ollamaModel: import.meta.env.VITE_OLLAMA_MODEL || 'gemma4:e4b',
      embedModel: import.meta.env.VITE_OLLAMA_EMBED_MODEL || 'nomic-embed-text',
      language: (import.meta.env.VITE_DEFAULT_LANG as Lang) || 'en',
      theme: 'system',
      darkMode: true,
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
      setOllamaModel: (m) => set({ ollamaModel: m }),
      setEmbedModel: (m) => set({ embedModel: m }),
      setLanguage: (l) => set({ language: l }),
      setTheme: (t) => {
        set({ theme: t, darkMode: resolveTheme(t) === 'dark' });
        applyTheme(t);
      },
      setDarkMode: (d) => {
        const t: ThemePref = d ? 'dark' : 'light';
        set({ theme: t, darkMode: d });
        applyTheme(t);
      },
    }),
    {
      name: 'aidflow-settings',
      // After hydrating from localStorage, apply the persisted theme so the
      // <html class="dark"> matches the user's saved preference.
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    }
  )
);

/**
 * Resolve a tri-state preference into the actual theme that should be active.
 * 'system' is mapped to the OS preference via matchMedia.
 */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Apply the resolved theme to <html> by toggling the `dark` class. Tailwind
 * (configured with `darkMode: 'class'`) and the CSS variables in index.css
 * both react to this single class.
 *
 * Safe to call repeatedly. No-op when running outside the browser.
 */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // Update the browser-chrome theme-color meta so the OS UI bar matches.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = resolved === 'dark' ? '#222831' : '#FFFFFF';
  }
}

/**
 * When the user has selected 'system', re-apply on OS preference changes so
 * the theme follows their dark-mode toggle in real time. Returns a cleanup
 * function. Call this once at app boot.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const pref = useSettingsStore.getState().theme;
    if (pref === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
