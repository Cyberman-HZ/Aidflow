import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './i18n';
import { seedIfEmpty, cleanupLegacyDemoProviders } from './db/seedData';
import { useConnectivityStore } from './stores/connectivityStore';
import {
  useSettingsStore,
  applyTheme,
  watchSystemTheme,
} from './stores/settingsStore';

// Apply the persisted theme BEFORE first paint so users don't see a flash
// of the wrong colour scheme. (The inline script in index.html does the
// same trick for browsers that load CSS before this module evaluates.)
applyTheme(useSettingsStore.getState().theme);
// When the user has chosen "system", react to OS-level toggles in real time.
watchSystemTheme();

// Seed demo data on first launch, clean up any legacy fake providers
// from earlier versions, then mount the app.
//
// IMPORTANT: use allSettled, not Promise.all. If either step rejects
// (Dexie quota error, schema migration crash, bulkAdd primary-key
// collision after a previous failed seed), the app shell must still
// mount so the user can at least see *some* error rather than a blank
// page with nothing logged. The connectivity store + DB-backed pages
// will degrade gracefully on their own when reads fail.
void Promise.allSettled([seedIfEmpty(), cleanupLegacyDemoProviders()]).then(
  (results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[main] seed/cleanup failed', r.reason);
      }
    }
    void useConnectivityStore.getState().refresh();

    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>
    );
  }
);
