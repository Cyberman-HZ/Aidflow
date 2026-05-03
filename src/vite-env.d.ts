/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_OLLAMA_BASE_URL: string;
  readonly VITE_OLLAMA_MODEL: string;
  readonly VITE_OLLAMA_EMBED_MODEL: string;
  readonly VITE_DEFAULT_LANG: 'en' | 'ar' | 'fr' | 'es';
  readonly VITE_APP_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Allow `import workerUrl from '...?url'` for the pdfjs worker
declare module '*?url' {
  const url: string;
  export default url;
}

// Allow `import x from '*.json'` (Dexie types pull this implicitly)
declare module '*.json' {
  const value: any;
  export default value;
}
