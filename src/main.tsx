import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './i18n';
import { seedIfEmpty } from './db/seedData';
import { useConnectivityStore } from './stores/connectivityStore';

// Seed demo data on first launch then mount the app.
void seedIfEmpty().then(() => {
  void useConnectivityStore.getState().refresh();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
});
