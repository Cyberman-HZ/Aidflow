// Tracks the three-state connectivity per PDF Section 7:
//   online       — REAL internet (active probe succeeded) + Ollama reachable
//   local        — no internet, but Ollama reachable
//   disconnected — Ollama unreachable (rule fallback only)
//
// `navigator.onLine` alone is unreliable on Windows — it returns true whenever
// any network interface is up, even with no actual internet. So we additionally
// probe a small external endpoint to verify real connectivity.

import { create } from 'zustand';
import { pingOllama } from '@/services/ollama';
import type { ConnectivityState } from '@/types';

interface ConnState {
  state: ConnectivityState;
  internetUp: boolean;
  ollamaUp: boolean;
  refresh: () => Promise<void>;
}

// Probes for real internet by hitting two captive-portal-style endpoints.
// Uses `mode: 'no-cors'` so we don't need CORS — we only care whether the
// request completed (any opaque response) or failed (network error).
async function probeInternet(): Promise<boolean> {
  // Fast path: navigator.onLine === false is a strong signal we're offline
  // (it can be wrong in the other direction, but rarely says false when up).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  const probes = [
    'https://www.google.com/generate_204',
    'https://1.1.1.1/cdn-cgi/trace',
  ];
  for (const url of probes) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3_000);
      await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return true; // request reached the network and got *some* response
    } catch {
      // Try next probe
    }
  }
  return false;
}

export const useConnectivityStore = create<ConnState>((set) => ({
  state: 'disconnected',
  internetUp: false,
  ollamaUp: false,
  refresh: async () => {
    // Run both probes in parallel
    const [internetUp, ollamaUp] = await Promise.all([
      probeInternet(),
      pingOllama(),
    ]);
    let state: ConnectivityState = 'disconnected';
    if (ollamaUp && internetUp) state = 'online';
    else if (ollamaUp) state = 'local';
    set({ internetUp, ollamaUp, state });
  },
}));

// Bind browser online/offline events for instant updates on adapter changes.
// HMR-safe: every time Vite re-evaluates this module in dev we'd otherwise
// register another setInterval + two more listeners. The handles get
// stashed on `window` so the next evaluation (and the dispose callback)
// can tear them down. In production this short-circuits to a single setup.
if (typeof window !== 'undefined') {
  type WithHandles = Window & {
    __aidflowConnHandles?: { trigger: () => void; intervalId: number };
  };
  const w = window as WithHandles;
  if (w.__aidflowConnHandles) {
    window.removeEventListener('online', w.__aidflowConnHandles.trigger);
    window.removeEventListener('offline', w.__aidflowConnHandles.trigger);
    clearInterval(w.__aidflowConnHandles.intervalId);
  }
  const trigger = () => useConnectivityStore.getState().refresh();
  window.addEventListener('online', trigger);
  window.addEventListener('offline', trigger);
  // Periodic re-probe — every 20s
  const intervalId = window.setInterval(trigger, 20_000);
  w.__aidflowConnHandles = { trigger, intervalId };
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('online', trigger);
      window.removeEventListener('offline', trigger);
      clearInterval(intervalId);
      delete w.__aidflowConnHandles;
    });
  }
}
