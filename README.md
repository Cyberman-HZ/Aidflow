# AidFlow Pro

> An offline-first humanitarian aid coordination console that runs on a single field laptop. Gemma 4 — multimodal and tool-calling — does the heavy reasoning locally; no cloud, no per-seat license, no monthly bill.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Hackathon: Gemma 4 Good](https://img.shields.io/badge/Hackathon-Gemma%204%20Good-00ADB5)](https://kaggle.com/competitions/gemma-4-good-hackathon)
[![Track: Global Resilience](https://img.shields.io/badge/Track-Global%20Resilience-orange)](https://kaggle.com/competitions/gemma-4-good-hackathon)
[![Stack: React + TS + Vite](https://img.shields.io/badge/Stack-React%20%7C%20TypeScript%20%7C%20Vite-393E46)](https://vitejs.dev)
[![Inference: Gemma 4 E4B via Ollama](https://img.shields.io/badge/AI-Gemma%204%20E4B%20%2B%20Ollama-EEEEEE)](https://ai.google.dev/gemma)

---

## 🌍 1. The problem & the solution

When a disaster hits — a flood, an earthquake, a cholera outbreak, a wave of displacement — **aid is rarely lost because the food, water, and medicine are not there.** It is lost because the coordination is not there: paper-first registrations get re-keyed days later with typos, daily priorities are set by whoever shouts loudest at the morning standup, worker notes vanish on the back of food-parcel receipts, and the laptop dies before the satellite uplink comes back. Field workers speak Arabic, French, or Spanish; the software speaks English; translation hops are where errors compound.

**AidFlow Pro** is an offline-first humanitarian aid coordination console that closes that gap on a single field laptop. Gemma 4 — running locally via Ollama — reads paper registration forms with its vision, calls typed tools to triage and dispatch, scores every family with an explainable priority, narrates a daily executive brief, and answers questions in the coordinator's own language. **No cloud, no internet bill, no per-seat license.** The cell tower can be gone, the satellite uplink can be down, the laptop can be running on solar — the whole register → triage → dispatch → report-back → re-prioritize loop keeps working.

### 🏗️ Architecture in one diagram

```
   ┌─────────────────────────────────────────────────────────┐
   │  AidFlow Pro PWA  (React 18 + TypeScript + Tailwind)    │
   │                                                         │
   │  ┌──────────────────────────────────────────────────┐   │
   │  │ Coordinator UI                                   │   │
   │  │   Dashboard  /  Families  /  Family Detail  /    │   │
   │  │   Distribute /  Assistant /  Knowledge Base /    │   │
   │  │   Kids       /  Bitchat   /  Starlink     /      │   │
   │  │   Workers    /  Settings                         │   │
   │  └────────────┬───────────────────┬─────────────────┘   │
   │               │                   │                     │
   │  ┌────────────▼─────────┐  ┌──────▼────────────┐        │
   │  │  Local DB            │  │  AI services      │        │
   │  │  (Dexie / IndexedDB  │  │  - chatWithTools  │        │
   │  │   in demo;           │  │    (function call)│        │
   │  │   pluggable to       │  │  - chatWithImage  │        │
   │  │   server in prod)    │  │    (multimodal)   │        │
   │  └──────────────────────┘  │  - RAG pipeline   │        │
   │                            │  - priority rules │        │
   │                            └──────┬────────────┘        │
   │                                   │                     │
   │      ┌────────────────────────────▼────────────┐        │
   │      │  fetch  →  http://localhost:11434       │        │
   │      │             Ollama  →  gemma4:e4b       │        │
   │      └─────────────────────────────────────────┘        │
   │                                                         │
   │  Service Worker (Workbox)  — caches app shell, fonts,   │
   │  reseller data, and Gemma 4 responses for offline use.  │
   └─────────────────────────────────────────────────────────┘
```

## ✨ 2. AI-powered features

Every feature below uses Gemma 4 directly. Read each row as *"what the AI does in the app"* → *"what it changes for the coordinator on the ground"*.

| Feature | Impact |
|---|---|
| **📸 Paper-form ingestion** — admin photographs a paper registration sheet; Gemma 4 vision reads each row into a structured JSON candidate (name, members, sector, displacement, income, medical conditions, notes) with high / medium / low confidence and a verbatim transcription. Each row appears as an Apply / Discard card. ([`formIngest.ts`](src/services/formIngest.ts), [`PaperFormImport.tsx`](src/components/PaperFormImport.tsx)) | A 6-family handwritten sheet goes from ~6 minutes of typing to ~90 seconds of photograph → review → Apply. Solves the *paper-first reality* — no more multi-day transcription lag, no more lost rows, verbatim text kept for audit. |
| **🛠️ Native function calling** — an 11-tool catalog exposed to Gemma 4 via Ollama's `tools` parameter. Read tools (`get_family`, `find_families`, `get_distribution_history`, `list_active_orders`, `find_workers`) auto-execute against IndexedDB; write tools (`update_family_field`, `add/remove_family_need`, `add/remove_medical_condition`, `draft_dispatch_order`) surface as Apply / Discard cards. The model can never mutate state directly. ([`aiTools.ts`](src/services/aiTools.ts)) | The Assistant becomes an orchestrator, not a chatbot. *"Find critical families in Sector-B-North with no delivery in 7 days and draft dispatches"* fires a chain of tool calls and lands as actionable cards. Cuts a multi-screen workflow to one prompt. |
| **🛡️ Explainable AI — every output is auditable** — every Gemma 4 invocation in AidFlow Pro writes a trace row capturing the exact data the model saw, every tool call's args + result, every PDF citation, whether the deterministic rule-engine fallback took over, and the final response. A **"How did I decide?"** button next to each AI output opens a side panel with the full trace; a dedicated **AI Audit Log** page (`/audit`) browses every trace recorded on the device, filterable by source, full-text searchable, exportable as JSON per-trace or as a bulk donor audit pack. ([`aiTrace.ts`](src/services/aiTrace.ts), [`TraceButton.tsx`](src/components/TraceButton.tsx), [`AiAudit.tsx`](src/pages/AiAudit.tsx)) | Safety & Trust by construction. Donors get audit-grade JSON they can replay offline; coordinators can spot-check any AI recommendation down to the byte that produced it; reviewers see the rule-engine fallback explicitly flagged when Ollama was unreachable — no silent degradation. 66 static assertions enforce the contract so the feature can't regress. |
| **✈️ Drone Camp Planner** — upload an aerial / drone image of the site; Gemma 4 vision identifies tents, water points, latrines, paths, open areas, buildings, and vehicles into a structured layout. An interactive canvas overlays the detections; a right-rail panel turns them into nine operational planning tasks: population estimate (tent count × household size), suggested distribution-point centroid, suggested medical-tent centroid (weighted by family vulnerability), Sphere ratios with gap callouts, route hints, underserved-zones heatmap, unregistered-arrivals delta, evacuation readiness, and a flood / hazard polygon painter that flags at-risk tents. Family pins bind individual families to specific tent positions. ([`campMap.ts`](src/services/campMap.ts), [`CampMap.tsx`](src/pages/CampMap.tsx)) | Planning that previously took a paid GIS contractor weeks now happens in 30 seconds on the field laptop. The coordinator decides where to put the next distribution point, where to drill the next latrine, and which tents to evacuate first — all from one drone snapshot, all offline, all explainable via the same Trace button as the rest of the AI. |
| **🎯 Explainable priority triage** — Gemma 4 receives a JSON snapshot of every family (composition, medical conditions, displacement, income, days since last aid) and returns a `priority_score` (0–100), `priority_level`, one-sentence `reason`, and `recommended_items` per family. Deterministic rule-engine fallback runs the same rubric offline. ([`prioritizeFamilies`](src/services/ollama.ts), [`priorityRules.ts`](src/services/priorityRules.ts)) | Triage stops being "loudest voice wins." Every family gets a defensible score with a sentence next to it. A quiet family of 11 with chronic malnutrition unseen for 15 days stops being invisible; donors and auditors can read *why* anyone is at the top of the queue. |
| **📚 Retrieval-Augmented Knowledge Base** — admin uploads PDF protocols; the app chunks them, embeds each chunk with `nomic-embed-text` (keyword fallback when no embedder), and serves Gemma 4 only the top-N matched chunks per question. Every answer cites the exact PDF + page. Out-of-corpus refusal built into the system prompt. ([`rag.ts`](src/services/rag.ts)) | *"What's the oral rehydration ratio for a 2-year-old?"* returns the answer **with a citation** instead of a guess. New volunteers find protocols on Day 1 instead of digging through email. No hallucinated guidance. |
| **🧠 Cross-document synthesis** — the same RAG retrieval scores chunks across the **entire library**, not scoped to one document. When a question's answer spans multiple PDFs, the chat pulls the top-k most relevant chunks regardless of source and Gemma 4 weaves them into a single response, citing every PDF it drew from. ([`retrieve()` in `rag.ts`](src/services/rag.ts)) | *"What are the top health risks during pregnancy in a crisis?"* returns one coherent answer pulling from the pregnancy-health PDF, the common-issues-during-crisis PDF, and the healthy-habits guide — with all three cited inline. The admin doesn't need to know which PDF holds the answer; Gemma 4 reads across them. |
| **🌐 Multilingual AI responses** — every Gemma 4 prompt instructs the model to respond in the user's current UI language (EN / AR with RTL / FR / ES). Field workers ask questions in their language; the model answers in the same language. | Zero translation hops in the critical path. An Arabic field note flows into the registry → admin queries it in their UI language → no clipboard round-trip, no compounding translation errors. |
| **💬 AI-explained family chat** — on every family detail page, a scoped Assistant chat. The family's full record + delivery history is embedded inline in every user turn so the model can't drift. Edit proposals come back as Apply / Discard cards routed through function calling. ([`AIChat.tsx`](src/components/AIChat.tsx), [`FamilyDetail.tsx`](src/pages/FamilyDetail.tsx)) | *"Has anyone delivered to F-0042 in the past week?"* returns the actual row from the distribution ledger, not a hallucinated summary. The AI sees the ground truth and proposes edits the admin can apply with one click. |
| **📊 Spreadsheet column mapping** — partner CSVs / XLSX come in with arbitrary headers (`HoH`, `Household Head`, `IDP`, …). Gemma 4 maps source columns onto AidFlow's schema; a heuristic synonym table is the offline fallback. ([`spreadsheetImport.ts`](src/services/spreadsheetImport.ts)) | Zero column-mapping cliffs. Partner data lands without manual remapping. Each row still walks through human review before commit. |
| **📈 AI executive summary + deletion audit** — the Dashboard streams a Gemma 4 markdown brief with five sections: Impact, Gaps & risks, Top critical cases, Recommended actions, Registry deletions (each soft-deleted family by name + ID + reason + date). Rule-based fallback emits the same shape offline. PDF export carries it. ([`Dashboard.tsx`](src/pages/Dashboard.tsx)) | The 7 AM briefing writes itself and is never empty, even with no internet. Donors get a printable audit-grade report: who's been served, who's been missed, who's been removed and why. |
| **🧸 AI-generated emotional-support content** — Gemma 4 produces age-appropriate stories, calming breathing scripts, journaling prompts, and supportive games / activities in the family's language for displaced children (5–7, 8–11, 12–15). ([`emotionalSupportGen.ts`](src/services/emotionalSupportGen.ts), [`EmotionalSupportGenModal.tsx`](src/components/EmotionalSupportGenModal.tsx)) | The platform serves the people, not just the operation. Caregivers in a tent get personalized psychosocial material on demand instead of generic printouts. |

### 🔒 Privacy by construction

- All inference on `localhost:11434` via Ollama. **No data leaves the laptop.**
- Photo bytes for paper-form ingest are kept in-memory only and dropped after extraction.
- The data layer is isolated in [`src/db/`](src/db/) and [`src/services/`](src/services/) so an organisation can swap IndexedDB for a hosted Postgres / Kobo Toolbox / CommCare / RedRose backend without changing the UI.
- Wikipedia search is **opt-in per question** and sends only the user's question, never family data.

## 🚀 3. Install and run

You need **Node.js 18+**, **npm**, and **[Ollama](https://ollama.com)** (Windows / macOS / Linux).

### ⬇️ Step 1 — pull the inference model

```bash
# ~5 GB. This is the model AidFlow Pro uses for triage, RAG, chat,
# function calls, AND multimodal paper-form ingest.
ollama pull gemma4:e4b

# Optional but recommended — used by the Knowledge Base for embeddings.
# Without it, RAG falls back to keyword search.
ollama pull nomic-embed-text
```

### ▶️ Step 2 — start Ollama with browser-CORS allowed

The browser needs cross-origin permission to talk to Ollama. Set `OLLAMA_ORIGINS=*` before starting `ollama serve`.

**Windows PowerShell:**
```powershell
$env:OLLAMA_ORIGINS="*"; ollama serve
```

**macOS / Linux:**
```bash
OLLAMA_ORIGINS="*" ollama serve
```

Leave that terminal open. Open a new terminal for the next step.

### 💻 Step 3 — clone, install, and run the app

```bash
git clone https://github.com/Cyberman-HZ/Aidflow.git
cd Aidflow
npm install
cp .env.example .env.local   # optional — only needed to override defaults
npm run dev
```

Open **http://localhost:5173** in a modern browser (Chrome / Edge / Firefox / Safari — Chromium recommended for camera + PWA install).

On first load the app seeds IndexedDB with mock workers, families, distributions, aid items, and Starlink data so you have something to play with immediately. **Settings → Reset demo data** wipes and re-seeds.

Sign in with any of the demo PINs shown on the Login screen (admin, supervisor, field worker).

### ✅ Step 4 (optional) — verify the AI integration

Two QA scripts are included to confirm Gemma 4 is reachable and that both the multimodal and tool-calling paths work end-to-end:

```bash
# Native function calling (tool_calls round-trip):
node scripts/qa/test-tool-calls.mjs

# Multimodal paper-form ingest (image → JSON):
node scripts/qa/test-paper-form-ingest.mjs
```

Both expect Ollama on `http://localhost:11434` and `gemma4:e4b` installed.

### 📦 Step 5 (optional) — production build

```bash
npm run build
npm run preview   # serves the production build locally on http://localhost:4173
```

The output in `dist/` is a static PWA — no server required to host it.

## 🗂️ 4. Project file structure

```
.
├── README.md                 ← this file
├── LICENSE                   ← MIT (app code)
├── index.html                ← Vite entry document
├── package.json              ← npm metadata + scripts
├── postcss.config.js         ← Tailwind / Autoprefixer wiring
├── tailwind.config.js        ← design tokens (brand, ai violet, priority palette)
├── tsconfig.json             ← TypeScript strict-mode config for the app
├── tsconfig.node.json        ← TypeScript config for Vite tooling
├── vite.config.ts            ← Vite + PWA plugin config
├── .env.example              ← env vars (Ollama base URL, model overrides)
├── .gitignore                ← excludes node_modules, dist, .tsbuildinfo, etc.
│
├── docs/
│   └── AidFlow_Pro_Plan.pdf  ← original product plan (background reading)
│
├── public/
│   ├── logo.png              ← app logo (also the PWA icon)
│   ├── manifest.webmanifest  ← PWA manifest (installable to home screen)
│   └── data/
│       └── starlink-resellers.json   ← authorized Starlink retailer dataset
│
├── scripts/
│   ├── clean-source.mjs                       ← strips dead comments from src/
│   └── qa/
│       ├── test-tool-calls.mjs                ← live test: Gemma 4 native function calling
│       ├── test-paper-form-ingest.mjs         ← live test: Gemma 4 vision (multimodal)
│       ├── test-family-delete.mjs             ← soft-delete + audit log invariants
│       ├── test-import-no-autoseed.mjs        ← imports never auto-invent need items
│       ├── test-duplicate-prevention.mjs      ← no-duplicate-family invariant across all 3 paths
│       ├── test-trace-shape.mjs               ← AI trace contract: type shape, v10 migration, service surface, callsite source values, /audit route wiring
│       └── test-camp-map-shape.mjs            ← Drone Camp Planner contract: types, v11 migration, service exports, Sphere constants, live pointInPolygon sanity tests, /camp-map route + nav + locale
│
└── src/
    ├── main.tsx              ← React entry; mounts <App />
    ├── App.tsx               ← route table, Layout shell
    ├── i18n.ts               ← react-i18next setup (loads ar / en / es / fr)
    ├── index.css             ← Tailwind base + component classes
    ├── vite-env.d.ts         ← Vite client type augments
    │
    ├── components/
    │   ├── AIChat.tsx                  ← reusable Gemma 4 chat panel (used by /assistant, /family/:id, /docs); renders tool-call chips, Apply/Discard cards, citations, and the inline Trace button
    │   ├── Card.tsx                    ← presentational card wrapper
    │   ├── ConnectivityBanner.tsx      ← top-of-page Online / Local / Disconnected indicator
    │   ├── EditableDemographicsCard.tsx ← in-place edit for family demographics
    │   ├── EditableMedicalCard.tsx     ← in-place edit for medical conditions
    │   ├── EmotionalSupportGenModal.tsx ← AI-generated kids content modal
    │   ├── EmptyState.tsx              ← reusable empty-state stub
    │   ├── FamilyEditModal.tsx         ← Add-family form; hosts the two import banners (spreadsheet + photo) at the top
    │   ├── LanguageSwitcher.tsx        ← EN / AR / FR / ES picker
    │   ├── Layout.tsx                  ← shell: side nav, top bar, connectivity banner
    │   ├── Loading.tsx                 ← spinner with optional label
    │   ├── PaperFormImport.tsx         ← multimodal paper-form ingest modal (camera + file → Gemma 4 vision → Apply/Discard cards)
    │   ├── PriorityBadge.tsx           ← coloured CRITICAL / HIGH / MEDIUM / NORMAL pill
    │   ├── RequireAuth.tsx             ← route guard around the authed shell
    │   ├── StatusBadge.tsx             ← order-status pill (pending / out_for_delivery / …)
    │   ├── ThemeToggle.tsx             ← light / dark / system theme picker
    │   ├── TraceButton.tsx             ← "How did I decide?" button + sliding TracePanel; first-time discovery bubble + pulsing dot to drive attention
    │   ├── CampMapCanvas.tsx           ← Drone Camp Planner canvas: image + SVG overlay of detected features, family-pin mode, hazard-polygon painter
    │   └── CampMapInsights.tsx         ← Drone Camp Planner right-rail panel: 9 operational tasks (population, distribution point, Sphere ratios, evacuation, hazard impact, …)
    │
    ├── db/
    │   ├── database.ts                 ← Dexie schema + migrations (v1 through v11)
    │   └── seedData.ts                 ← mock families, distributions, workers, kids content
    │
    ├── locales/
    │   ├── en.json                     ← English (canonical)
    │   ├── ar.json                     ← Arabic (RTL)
    │   ├── fr.json                     ← French
    │   └── es.json                     ← Spanish
    │
    ├── pages/
    │   ├── AidflowAndroid.tsx          ← AidFlow Android — Beta companion-app distribution page (about, requirements, download / admin upload, install steps, screenshots)
    │   ├── AiAudit.tsx                 ← AI Audit Log browser: every trace ever recorded, filterable by source, full-text searchable, JSON export
    │   ├── CampMap.tsx                 ← Drone Camp Planner page: image upload, canvas + insights split, family-pin picker modal
    │   ├── Assistant.tsx               ← global AI assistant with full registry context + tool calling
    │   ├── Bitchat.tsx                 ← mesh-chat install guide + APK download
    │   ├── Dashboard.tsx               ← KPIs, charts, AI executive summary, CSV / PDF export
    │   ├── Distribute.tsx              ← 3-step dispatch wizard (family → worker → items)
    │   ├── Families.tsx                ← family list with priority sort, filters, pencil-to-detail navigation
    │   ├── FamilyDetail.tsx            ← per-family view: Demographics, Medical, Current needs, History, scoped Assistant chat
    │   ├── KidsContent.tsx             ← emotional-support library (age-bracketed)
    │   ├── KnowledgeBase.tsx           ← PDF upload + RAG chat + per-doc summarize
    │   ├── Login.tsx                   ← demo PIN login screen
    │   ├── Settings.tsx                ← theme, language, Ollama overrides, reset demo data
    │   ├── StarlinkMap.tsx             ← authorized retailers + country availability
    │   └── Workers.tsx                 ← worker roster CRUD
    │
    ├── services/
    │   ├── ollama.ts                   ← Ollama client: chat(), chatStream(), chatWithTools(), chatWithImage(), embed(), prioritizeFamilies()
    │   ├── aiTools.ts                  ← function-calling tool catalog (11 tools, read + write, JSON schema + executors)
    │   ├── aiTrace.ts                  ← explainable-AI audit trail: recordTrace, getTrace, listTraces, patchTrace, purgeOlderThan, exportTraceAsJson; recordTrace wraps the DB put in try/catch so an audit failure can never break the AI feature
    │   ├── campMap.ts                  ← Drone Camp Planner: Gemma 4 vision call + JSON sanitizer + Sphere-ratio + geometry helpers (pointInPolygon, weighted centroids) + persistence
    │   ├── formIngest.ts               ← paper-form vision pipeline: prompt + schema validation + commit
    │   ├── imageUtils.ts               ← file → resized JPEG → base64 (Ollama-compatible)
    │   ├── familyActions.ts            ← legacy fenced-action protocol (kept as fallback for non-tool-calling models)
    │   ├── familyDuplicates.ts         ← duplicate-family detection (head_name + member_count) shared across all 3 creation paths
    │   ├── familyIntent.ts             ← regex intent detection (deterministic short-circuit for common phrases)
    │   ├── aiContext.ts                ← builds the global system prompt for the Assistant page
    │   ├── priorityRules.ts            ← deterministic rubric (Ollama-offline fallback)
    │   ├── rag.ts                      ← PDF chunking, embedding, retrieval, citation
    │   ├── orderNumber.ts              ← atomic sequential ORD-NNNN minter
    │   ├── spreadsheetImport.ts        ← CSV / XLSX parsing + Gemma-mapped column coercion
    │   ├── emotionalSupportGen.ts      ← AI generation for the kids content tab
    │   ├── starlinkCountries.ts        ← static country-availability snapshot
    │   ├── resellers.ts                ← Starlink retailer sync from public/data/
    │   ├── bitchat.ts                  ← Bitchat APK metadata + delivery
    │   ├── aidflowAndroid.ts           ← AidFlow Android APK distribution (upload, download, getApkInfo, delete) — singleton in IndexedDB so field teams can install offline
    │   └── webSearch.ts                ← Wikipedia search (opt-in, online-only)
    │
    ├── stores/
    │   ├── authStore.ts                ← Zustand: current user (PIN login state)
    │   ├── settingsStore.ts            ← Zustand: theme, language, Ollama overrides
    │   └── connectivityStore.ts        ← Zustand: online / local / disconnected probe
    │
    └── types/
        └── index.ts                    ← shared TypeScript types (Family, AidDistribution, Worker, KnowledgeDocument, etc.)
```

## 🔮 5. Where we're going next — an Android companion

The hackathon entry is the coordinator-side console. The clear next step is taking the same architecture to the place where humanitarian data actually originates: **the field worker's phone, mid-tent-visit**.

> **🚧 Already in beta.** The Android companion — **AidFlow Pro Mobile** — runs **Gemma 4 E2B (~2.6 GB) on-device via LiteRT-LM with XNNPack acceleration** on Android 12+ (voice translation optimized for Android 13+). Beta builds and full architecture notes live in its own repository:
> **[github.com/Cyberman-HZ/Aidflow-android-app-powered-by-gemma-4](https://github.com/Cyberman-HZ/Aidflow-android-app-powered-by-gemma-4)**

The companion is built for realistic field constraints — zero network calls after the one-time model download, no data ever leaving the device:

- **📸 Voice + photo family intake.** A worker speaks or photographs a registration; Gemma 4 vision and on-device speech extract a structured family record matching the web-app's canonical schema (`head_name`, `member_count`, `children_under_5`, …).
- **📦 Relief-item identification from photos.** Snap a stack of supplies; the model identifies items with category and estimated quantity for fast inventory entry.
- **📄 Document scanning with OCR.** Multi-page scans get auto-cropped, perspective-corrected, OCR'd, cleaned, and translated end-to-end. Built-in camera handles lens and flash control.
- **🌐 Real-time translation across 20 languages.** English, Spanish, French, Arabic, Ukrainian, Russian, Polish, Turkish, Persian, Pashto, Urdu, Hindi, Bengali, Swahili, Amharic, Somali, Chinese (Simplified), Vietnamese, Tagalog. Voice and text both.
- **📤 Excel / CSV / DOCX / TXT export** with column headers that match the web-app's canonical schema. A worker hands off a `.xlsx` over USB, Bluetooth, or local Wi-Fi, and the coordinator console imports it row-by-row through the existing spreadsheet wizard — no cloud sync, no telemetry, same privacy contract.
- **🛡️ Offline-first.** Zero network calls after the one-time ~2.6 GB model download. Requires 3 GB free storage and 2 GB free RAM.

The combined system — coordinator console on the field laptop, capture app on every worker's phone, both running Gemma 4 locally — closes the last meter of the data path that paper currently fills.

*Known beta limitations:* multi-second inference latency on mid-range phones, occasional language gaps in the on-device speech recognizer, 60–90 second first-launch model load (subsequent launches ~15 s). Not yet hardened for unsupervised deployment in critical operations — see the Android repo's README for the full caveat list.

## 🏆 Hackathon submission

- **Hackathon:** [Gemma 4 Good Hackathon](https://kaggle.com/competitions/gemma-4-good-hackathon)
- **Track:** Global Resilience (with secondary alignment to Safety & Trust — citation-grounded RAG, Apply/Discard before any write, raw-text verification on every extraction, **and a byte-level AI Audit Log: every Gemma 4 invocation writes a trace row capturing inputs / tool calls / citations / fallback usage / response, surfaced in a "How did I decide?" button next to each AI output and a browsable `/audit` page with JSON export**)
- **Model:** Gemma 4 E4B served locally via Ollama at `http://localhost:11434`
- **Gemma 4 features exercised:** native multimodal (paper-form vision ingest) and native function calling (11-tool catalog with read + write tools)
- **Deliverables:** this repository (open source, MIT-licensed app code), a 3-minute demo video, a Kaggle Notebook write-up, this README

## 📜 License

The application code is released under the **MIT License** — see [`LICENSE`](LICENSE). The Gemma 4 model weights are governed separately by Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms).

## ™️ Attribution

Gemma is a trademark of Google LLC. AidFlow Pro is independently developed for the Gemma 4 Good Hackathon and is **not affiliated with, endorsed by, or sponsored by Google**. Following the Gemma model variant naming and attribution guidelines, this project:

- does not use "gemma" inside the project name itself;
- references "Gemma 4 E4B" in the description and documentation strictly to identify the underlying inference model used;
- does not reuse Gemma's brand marks, logos, or color palette in its own UI;
- displays the trademark notice on the Login screen footer and in **Settings → About** inside the app.

Starlink is a registered trademark of Space Exploration Technologies Corp. (SpaceX). Bitchat is an independent open-source project. Both are referenced in this app for the operational benefit of humanitarian field teams; AidFlow Pro is not affiliated with either.
