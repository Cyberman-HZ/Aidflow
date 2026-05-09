# AidFlow Pro

> From a flooded village to a delivered food parcel — minutes, not days. An offline-first humanitarian aid coordinator that runs Gemma 4 on a laptop in the back of a pickup truck.

[![License: MIT](https://img.shields.io/badge/License-MIT-brand.svg)](https://opensource.org/licenses/MIT)
[![Hackathon: Gemma 4 Good](https://img.shields.io/badge/Hackathon-Gemma%204%20Good-00ADB5)](https://kaggle.com/competitions/gemma4good)
[![Built with React + TypeScript + Vite](https://img.shields.io/badge/Stack-React%20%7C%20TypeScript%20%7C%20Vite-393E46)](https://vitejs.dev)
[![Powered by Gemma 4 E4B](https://img.shields.io/badge/AI-Gemma%204%20E4B-EEEEEE)](https://ai.google.dev/gemma)

---

## Why this exists

Humanitarian aid is rarely lost because the food, water, and medicine are not there. It is lost because the *coordination* is not there. A team lands in a disaster zone with paper rosters, a half-charged satellite phone, and three different spreadsheets that do not agree on which families have already received what. By the time the right tent reaches the right grandmother, two days have passed and a different family three streets away — the one with the diabetic teenager — has been missed entirely.

I wanted to build the smallest possible piece of software that could fix that single gap, end-to-end, on a single ruggedized laptop, with no SIM card, no Wi-Fi, no monthly cloud bill, and no PhD required to operate it. Open-weight models like Gemma 4 finally make that physically possible: a humanitarian-grade reasoning engine you can carry in your pocket and run on solar.

AidFlow Pro is that experiment.

## What is humanitarian aid distribution, in one minute

When a disaster hits — a flood, an earthquake, a displacement wave — relief organizations send field teams to register affected households, assess what they need (food, water, medical supplies, shelter, hygiene kits), and hand out the right items in the right order. The work has three rhythms: **register** the people you can reach, **triage** them by urgency (a pregnant woman with no shelter outranks a single adult with a damaged roof), and **deliver** the right combination of items while keeping a clean ledger so nothing is double-counted or stolen.

The hard part is not the giving. It is keeping all three rhythms in sync across dozens of field workers, four languages, intermittent power, and a population whose situation changes every hour.

## The wall this project tries to break

| Today, on Day 3 of a flood response | Why it fails | What AidFlow Pro does instead |
|---|---|---|
| Paper rosters in three different notebooks | One worker writes "Family Hassan", another writes "Hassan H., 4 kids" — same family, two records. | A single shared IndexedDB on every device, with stable IDs and a soft-delete pattern that preserves the audit trail. |
| Priority decided by gut feel at the morning briefing | Bias creeps in. Loud families get served, quiet families starve. | An explainable 0–100 score from Gemma 4 that re-ranks after every distribution and shows its reasoning in plain language. |
| "We'll upload to HQ when we get signal" | Signal never comes; the laptop dies; the spreadsheet is gone. | Everything writes to disk locally first. Cloud sync is an afterthought, not a prerequisite. |
| Aid manuals are PDFs sitting on someone's email | A new volunteer cannot find the cholera response protocol on Day 1. | Drop the PDFs into the Knowledge Base. Gemma 4 reads them and cites the exact page when asked. |
| Field comms over a single satellite link | One satellite outage = silent crew. | Bitchat fallback over Bluetooth mesh — peer-to-peer, no infrastructure. |

## What AidFlow Pro actually does

Picture Amani, a field coordinator on Day 3 of a regional flood. She opens her laptop in the back of a pickup truck. There is no cellular signal. Ollama is running on the same machine.

She taps **Workers** and sees her four registered volunteers, each with the languages they speak and the sectors they're certified for. She taps **Families** and the ranked list rebuilds itself: a household with a pregnant mother and two infants jumps to the top, with a one-line explanation — *"newborn under 6 months and no shelter; sector triage flag: WASH critical"*. She picks them, hits **Distribute**, walks the three-step wizard (select items → confirm worker → log delivery), and the score for that family drops to 27. The next family on the list is now the diabetic teenager's household. She has not opened a spreadsheet once.

Later that night, she drops a 40-page UNICEF cholera-response PDF into the Knowledge Base. She types *"what's the oral rehydration ratio for a 2-year-old?"* into the assistant. Gemma 4 reads the PDF locally, answers in Arabic (her first language), and cites the page. She closes the laptop. The whole day's work — registrations, distributions, AI conversations, attached documents — lives in IndexedDB on her hard drive. Nothing left the machine.

That is the core dossier:

- **Workers** with sector permissions and languages.
- **Families** with displacement status, income, medical flags, household composition.
- **Distributions** linking who gave what to whom on which date.
- **Knowledge Base** of uploaded PDF protocols, searchable and summarizable by Gemma 4.
- **Bitchat** mesh client for offline crew coordination.
- **Starlink** coverage map for choosing where to set up satellite uplinks.
- **Reports** for KPI snapshots and end-of-day exports.

## How it works under the hood

There is no backend. The whole system fits in a browser tab.

```
   ┌─────────────────────────────────────────────────────────┐
   │  AidFlow Pro PWA  (React 18 + TypeScript + Tailwind)    │
   │                                                         │
   │  ┌──────────────────────────────────────────────────┐   │
   │  │ UI Layer  — Workers / Families / Distribute /    │   │
   │  │            Knowledge Base / Reports / Settings   │   │
   │  └────────────┬───────────────────┬─────────────────┘   │
   │               │                   │                     │
   │      ┌────────▼─────────┐  ┌──────▼────────────┐        │
   │      │  Dexie.js (IDB)  │  │  RAG pipeline     │        │
   │      │  families        │  │  - chunking       │        │
   │      │  workers         │  │  - cosine search  │        │
   │      │  distributions   │  │  - keyword fall.  │        │
   │      │  pdf_chunks      │  │  - inventory inj. │        │
   │      └──────────────────┘  └──────┬────────────┘        │
   │                                   │                     │
   │      ┌────────────────────────────▼────────────┐        │
   │      │  fetch  →  http://localhost:11434       │        │
   │      │             Ollama  →  gemma4:e4b       │        │
   │      └─────────────────────────────────────────┘        │
   │                                                         │
   │  Service Worker (Workbox)  — caches app shell, map      │
   │  tiles, fonts, and Gemma 4 responses for offline use.   │
   └─────────────────────────────────────────────────────────┘
```

Every screen reads through `useLiveQuery` from Dexie, so any write (a new distribution, a deleted family) repaints every relevant view in the same tick. The AI calls are streamed back through async generators so the user sees tokens as they arrive — important when the model is on a 4-year-old laptop with no GPU.

## Why this is built on Gemma 4 specifically

| Property | What it gets us |
|---|---|
| **Open weights, runnable locally** | The whole reason this project is possible. No data leaves the laptop. No monthly bill. No "cloud unavailable" outage in a disaster zone. |
| **E4B variant footprint** | Small enough to run on a field laptop with 16 GB of RAM. Big enough to follow a 4-step humanitarian triage prompt without falling apart. |
| **Native multilingual fluency** | Field reports in Arabic, French, and Spanish answered in the same language they were asked. RTL support without a translation hop. |
| **Good instruction following on tight system prompts** | Lets us pin behavior with a strict RAG system prompt that refuses to invent fake "WASH platform sections" and stays inside the user's uploaded PDFs. |
| **Streaming via Ollama's chat completions endpoint** | The async generator UX above. Tokens arrive in tens of milliseconds, not after a 30-second wait. |

## Quickstart — try it locally in 3 minutes

You need Node.js 18+, npm, and Ollama (https://ollama.com).

```bash
# 1. Pull the AI model
ollama pull gemma4:e4b
# optional, for embeddings (the app falls back to keyword search if you skip):
ollama pull nomic-embed-text

# 2. Start Ollama with browser CORS allowed
#    Windows PowerShell:
$env:OLLAMA_ORIGINS="*"; ollama serve
#    macOS / Linux:
OLLAMA_ORIGINS="*" ollama serve

# 3. Install and run the app
git clone https://github.com/Cyberman-HZ/Aidflow.git
cd Aidflow
npm install
cp .env.example .env.local
npm run dev
# → http://localhost:5173
```

On first load the app seeds IndexedDB with mock families, workers, and distributions so you can play with the priority ranking, distribution wizard, and Knowledge Base without registering anything yourself. **Settings → Reset demo data** wipes and re-seeds.

## Push to your own GitHub

```bash
gh repo create aidflow-pro --public --source=. --remote=origin --push
```

Or, if you prefer the manual route:

```bash
git remote add origin https://github.com/<you>/aidflow-pro.git
git branch -M main
git push -u origin main
```

## How the project is organised — a beginner's tour

Think of the codebase as a small humanitarian field office. The `src/pages` folder holds the rooms (Families, Workers, Distribute, Knowledge Base). `src/components` is the furniture that gets reused across rooms (modals, cards, the AI chat panel). `src/services` is the back office — the people who actually move boxes, talk to the radio operator (Ollama), and keep the ledger (IndexedDB). `src/stores` is the shared whiteboard everyone in the office reads from. Walk through a few of the rooms.

### The front door — `src/main.tsx`, `src/App.tsx`, `src/components/Layout.tsx`

| File | Role |
|---|---|
| `main.tsx` | Boots React, applies the saved theme (light / dark / system) before the first paint, and starts the system-theme watcher. |
| `App.tsx` | Wires up the router and the i18n provider for English, Arabic, French, and Spanish. |
| `components/Layout.tsx` | The sidebar shell every page lives inside. Connection banner, language switcher, theme toggle. |

### The family room — `src/pages/Families.tsx`, `src/pages/FamilyDetail.tsx`

This is where the priority list lives. `Families.tsx` is a searchable, sector-filterable view that pulls every household from IndexedDB through `useLiveQuery`, sorts by Gemma 4's score when available and the deterministic rule-engine score as fallback, and offers a one-click jump into the **FamilyDetail** page. `FamilyDetail.tsx` shows the full dossier (composition, medical flags, displacement status), the distribution history, and a chat panel that hands the family's full record + history to Gemma 4 so the assistant can answer "when did this family last receive food?" without making it up.

### The distribution wizard — `src/pages/Distribute.tsx`, `src/components/DistributionWizard.tsx`

A linear three-step flow: pick the family, pick the worker doing the handover, pick the items and quantities. On confirmation it writes a single `distribution` row, which causes every Families view to re-render with the updated priority for that family. No round trip, no spinner.

### The radio room — `src/services/aiClient.ts`, `src/services/rag.ts`

`aiClient.ts` is the thin wrapper around Ollama's `/v1/chat/completions` endpoint. It handles streaming, abort, and graceful fallback when Ollama is offline. `rag.ts` is the larger of the two — it owns PDF ingestion (text extraction with `pdfjs-dist`, chunking, embedding via `nomic-embed-text` if available, otherwise keyword-only), a cosine-similarity retriever with a dimension-mismatch guard, a strict RAG system prompt that refuses to hallucinate platform sections, and a `summarizeDocumentStream` helper that streams a full-document summary inline.

### The library — `src/pages/KnowledgeBase.tsx`

A single-tab document store. Drop a PDF, give it a title and category, watch the four-phase progress bar (extract → embed → save → done), then either ask questions in the locked-on-RAG chat or hit the per-row **Summarize** button to stream a structured summary. All in-app modals — the delete confirmation and the "scanned PDF, no extractable text" notice — are accessible (Escape key, focus trap, body-scroll lock, ARIA roles).

### The whiteboards — `src/stores/`

Three Zustand stores: `settingsStore` (theme, default language, Ollama URL, demo-data reset), `connectivityStore` (the green/yellow/red banner at the top of the app), and `aiStatusStore` (model presence, last latency). They never persist family data — that lives in IndexedDB exclusively.

### The translator — `src/locales/{en,ar,fr,es}.json`

Every visible string. Arabic is bidirectional with `dir="rtl"` applied at the layout root. Adding a fifth language is one new JSON file and one entry in the language switcher.

### The cache layer — `vite.config.ts`, `public/manifest.webmanifest`, generated `sw.js`

Workbox precaches the app shell, runtime-caches Leaflet map tiles for the Starlink coverage view, and uses a network-first strategy for API responses so a freshly-online laptop refreshes against Ollama before falling back to the disk cache.

### File tree

```
.
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── components/
│   │   ├── Layout.tsx
│   │   ├── ThemeToggle.tsx
│   │   ├── AIChat.tsx
│   │   ├── DistributionWizard.tsx
│   │   ├── FamilyEditModal.tsx
│   │   ├── NoticeModal.tsx
│   │   └── DeleteDocumentModal.tsx
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Workers.tsx
│   │   ├── Families.tsx
│   │   ├── FamilyDetail.tsx
│   │   ├── Distribute.tsx
│   │   ├── KnowledgeBase.tsx
│   │   ├── Reports.tsx
│   │   ├── Bitchat.tsx
│   │   ├── Starlink.tsx
│   │   └── Settings.tsx
│   ├── services/
│   │   ├── aiClient.ts
│   │   ├── rag.ts
│   │   ├── db.ts
│   │   └── seed.ts
│   ├── stores/
│   │   ├── settingsStore.ts
│   │   ├── connectivityStore.ts
│   │   └── aiStatusStore.ts
│   └── locales/
│       ├── en.json
│       ├── ar.json
│       ├── fr.json
│       └── es.json
├── scripts/qa/
│   └── test-knowledge-base.mjs
├── public/
│   └── manifest.webmanifest
├── tailwind.config.js
├── vite.config.ts
├── package.json
└── README.md
```

## Glossary — a tiny field guide

- **Sector** — a category of humanitarian work (Food Security, WASH, Shelter, Health, Protection, Nutrition). Workers are certified per sector; families are flagged per sector.
- **Triage** — the act of ranking households by urgency so finite aid reaches the most acute needs first. AidFlow Pro's triage is a Gemma-4-explained 0–100 score.
- **Distribution** — a single recorded handover of items from a worker to a family at a timestamp. The atomic unit of the ledger.
- **RAG** — Retrieval-Augmented Generation. The pattern of fetching the most relevant chunks from a corpus (here, uploaded PDFs) and stuffing them into the model's context window so the answer is grounded.
- **Bitchat** — a Bluetooth-mesh peer-to-peer chat protocol used by AidFlow Pro for crew comms when no infrastructure is available.
- **Starlink** — SpaceX's low-Earth-orbit satellite internet service; the coverage map highlights regions where a Starlink kit can re-establish connectivity.
- **PWA** — Progressive Web App. A web app that installs to the home screen, ships its own service worker, and works offline.
- **IndexedDB** — the browser-native database where all AidFlow Pro data lives. Fast, transactional, and stays on the laptop.

## What this project is **not**

- **Not a certified humanitarian information system.** Real deployments require IATI / 3W reporting, donor compliance, and audited PII handling. AidFlow Pro is a hackathon prototype to demonstrate that offline AI-assisted coordination is feasible.
- **Not medical software.** The medical flags on a family record are operational hints for triage, not clinical diagnoses. A nutritionist or doctor must validate every field decision.
- **Not affiliated with, endorsed by, or sponsored by Google.** Gemma 4 is the inference engine; the project is independently developed for the Gemma 4 Good Hackathon.
- **Not a replacement for trained humanitarian professionals.** It is a tool to make their work faster and less error-prone.

## Hackathon submission

- **Hackathon:** Gemma 4 Good Hackathon
- **Track:** Global Resilience
- **Model:** Gemma 4 E4B, hosted locally via Ollama
- **Deliverables:**
  - This repository (open source, MIT-licensed app code)
  - A 3-minute demo video walking through registration → triage → distribution → Knowledge Base RAG
  - A short technical write-up describing the offline-first architecture and the explainable-priority prompt design
  - This README

## License

The application code is released under the **MIT License** — see `LICENSE`. The Gemma 4 model weights are governed separately by Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms).

## Attribution

Gemma is a trademark of Google LLC. AidFlow Pro is independently developed for the Gemma 4 Good Hackathon and is **not affiliated with, endorsed by, or sponsored by Google**. Following the Gemma model variant naming and attribution guidelines, this project:

- does not use "gemma" inside the project name itself;
- references "Gemma 4 E4B" in the description and documentation strictly to identify the underlying inference model used;
- does not reuse Gemma's brand marks, logos, or color palette in its own UI;
- displays the trademark notice on the Login screen footer and in **Settings → About** inside the app.

## Acknowledgements

Built with the open-source giants of the modern web: React, TypeScript, Vite, TailwindCSS, Dexie.js, Workbox, Leaflet, react-i18next, pdfjs-dist, and Ollama. Thanks to the humanitarian responders whose published field protocols and after-action reports shaped the requirements behind every screen — the work is theirs; this is just a tool that hopes to help carry it.
