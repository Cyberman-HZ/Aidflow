// AidFlow Pro — i18n bootstrap
// Languages: EN, AR (RTL), FR, ES per PDF Section 10.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import ar from './locales/ar.json';
import fr from './locales/fr.json';
import es from './locales/es.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
      fr: { translation: fr },
      es: { translation: es },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'ar', 'fr', 'es'],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'aidflow-lang',
      caches: ['localStorage'],
    },
  });

export const RTL_LANGS: ReadonlyArray<string> = ['ar'];
export const isRtl = (lang: string) => RTL_LANGS.includes(lang);

export function applyDirection(lang: string) {
  if (typeof document === 'undefined') return;
  const dir = isRtl(lang) ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', lang);
}

export default i18n;
