# AidFlow Pro

**AI-Powered Humanitarian Aid Distribution Platform**
Built for the [Gemma 4 Good Hackathon](https://kaggle.com/competitions/gemma4good) — Global Resilience Track.
Powered by **Gemma 4 E4B** running locally via Ollama.

> Bringing AI-powered triage and offline-first intelligence to humanitarian crisis zones — so every family gets the right aid, at the right time, even without internet.

---

## What this is

AidFlow Pro is an offline-first Progressive Web App (PWA) that helps humanitarian organizations distribute aid intelligently and equitably to impacted families — even in disaster zones with no internet. The app:

- Runs **fully on the user's own hardware**. No cloud, no external AI APIs. Family data never leaves the device.
- Uses **Gemma 4 E4B** (locally hosted via Ollama) to compute real-time priority scores, answer natural-language queries, and reference uploaded PDF protocols via RAG.
- Caches the entire app shell + map tiles + AI responses in a Service Worker so it works in airplane mode.
- Supports **English, Arabic (RTL), French, and Spanish**.

## Features

| # | Module | Description |
|---|--------|-------------|
| 1 | AI Prioritization | Gemma 4 ranks families 0–100 with explainable reasoning |
| 2 | Distribution Wizard | 3-step field workflow with priority recalculation after each delivery |
| 3 | Knowledge Base + RAG | Upload PDF protocols; Gemma 4 cites them in answers |
| 4 | Emotional Support Library | Age-tagged content for children in crisis zones |
| 5 | Aid Usage Guides | How-to library for distributed items |
| 6 | Starlink Coverage Map | Leaflet map with provider pins, offline tile caching |
| 7 | Bitchat Communication | Bluetooth mesh client for offline field comms |
| 8 | Multilingual + RTL | EN / AR / FR / ES with full RTL Arabic layout |
| 9 | Reports & Dashboard | KPI cards, charts, export-ready summaries |

## Architecture

This is a **frontend-only PWA** — there is no backend service to run. All data stays in **IndexedDB** on the user's device. The browser talks directly to a local Ollama instance for AI features.

```
Browser (React PWA)
   │
   ├── IndexedDB (Dexie.js)  ── families, distributions, documents, kids content
   ├── Cache Storage         ── app shell, map tiles, fonts (Workbox)
   └── fetch → http://localhost:11434/v1/chat/completions  (Ollama → Gemma 4 E4B)
```

## Prerequisites

1. **Node.js 18+** and npm
2. **Ollama** installed and running (https://ollama.com)
3. **Gemma 4 E4B** model pulled into Ollama (the PDF says "E5B IT" — that tag does not exist; `e4b` is the correct edge variant Google released on April 2, 2026):
   ```bash
   ollama pull gemma4:e4b
   # optional, for RAG embeddings:
   ollama pull nomic-embed-text
   ```
4. **CORS enabled in Ollama** so the browser can call it. Set this environment variable BEFORE starting Ollama:
   - **Windows (PowerShell):**
     ```powershell
     $env:OLLAMA_ORIGINS="*"
     ollama serve
     ```
   - **macOS / Linux:**
     ```bash
     OLLAMA_ORIGINS="*" ollama serve
     ```

## Running locally

```bash
# Install deps
npm install

# Copy env template
cp .env.example .env.local

# Start dev server
npm run dev
# → http://localhost:5173

# Production build
npm run build
npm run preview
```

The PWA can be installed from the browser's "Install app" prompt once you've visited the production build.

## Configuration

Edit `.env.local`:

| Variable | Default | Notes |
|---|---|---|
| `VITE_OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama is listening |
| `VITE_OLLAMA_MODEL` | `gemma4:e4b` | Tag of the Gemma 4 model in Ollama |
| `VITE_OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Used by the RAG pipeline |
| `VITE_DEFAULT_LANG` | `en` | One of `en`, `ar`, `fr`, `es` |

These can also be overridden at runtime in **Settings → AI Configuration**.

## Demo data

On first load, the app seeds IndexedDB with realistic mock families, distributions, aid items, and Starlink provider pins. Use **Settings → Reset demo data** to wipe and re-seed.

## Offline mode

1. Run the production build (`npm run build && npm run preview`).
2. Visit the app, click around to populate caches.
3. Open DevTools → Network tab → toggle **Offline**.
4. Reload — the app, map tiles, and family list still work. Gemma 4 features keep working as long as Ollama is running locally.

The connectivity banner at the top of the app shows three states:
- 🟢 **Online — Full AI** (internet + Gemma 4 reachable)
- 🟡 **Local Mode** (no internet, Gemma 4 offline-only)
- 🔴 **Disconnected** (Ollama unreachable — falls back to deterministic rule-based scoring)

## Bitchat note

The Bitchat module uses the **Web Bluetooth API**, available on Chrome / Edge on Windows, macOS, Android, and Linux. Firefox and Safari do not currently expose Web Bluetooth. For iOS field workers, a Capacitor wrapper is suggested (Phase 4 in the plan).

## Hackathon submission

- **Track:** Global Resilience
- **Model:** Gemma 4 E4B, hosted locally via Ollama
- **Submission deadline:** May 18, 2026
- **License:** MIT (this app) / Apache 2.0 (Gemma 4 model weights)

## License

MIT — see `LICENSE`. The Gemma 4 model is governed by Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
