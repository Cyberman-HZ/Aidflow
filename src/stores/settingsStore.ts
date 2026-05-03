// AidFlow Pro — Settings store (persisted in localStorage)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'en' | 'ar' | 'fr' | 'es';

interface SettingsState {
  ollamaBaseUrl: string;
  ollamaModel: string;
  embedModel: string;
  language: Lang;
  darkMode: boolean;
  setOllamaBaseUrl: (url: string) => void;
  setOllamaModel: (m: string) => void;
  setEmbedModel: (m: string) => void;
  setLanguage: (l: Lang) => void;
  setDarkMode: (d: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ollamaBaseUrl: import.meta.env.VITE_OLLAMA_BASE_URL || 'http://localhost:11434',
      ollamaModel: import.meta.env.VITE_OLLAMA_MODEL || 'gemma4:e4b',
      embedModel: import.meta.env.VITE_OLLAMA_EMBED_MODEL || 'nomic-embed-text',
      language: (import.meta.env.VITE_DEFAULT_LANG as Lang) || 'en',
      darkMode: true,
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
      setOllamaModel: (m) => set({ ollamaModel: m }),
      setEmbedModel: (m) => set({ embedModel: m }),
      setLanguage: (l) => set({ language: l }),
      setDarkMode: (d) => set({ darkMode: d }),
    }),
    { name: 'aidflow-settings' }
  )
);
