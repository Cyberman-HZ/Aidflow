# AidFlow Pro

> An offline-first administrator console for humanitarian aid distribution. The coordinator plans and assigns; the workers deliver and report back; Gemma 4 keeps the priorities honest — all on one laptop, no internet required.

[![License: MIT](https://img.shields.io/badge/License-MIT-brand.svg)](https://opensource.org/licenses/MIT)
[![Hackathon: Gemma 4 Good](https://img.shields.io/badge/Hackathon-Gemma%204%20Good-00ADB5)](https://kaggle.com/competitions/gemma4good)
[![Built with React + TypeScript + Vite](https://img.shields.io/badge/Stack-React%20%7C%20TypeScript%20%7C%20Vite-393E46)](https://vitejs.dev)
[![Powered by Gemma 4 E4B](https://img.shields.io/badge/AI-Gemma%204%20E4B-EEEEEE)](https://ai.google.dev/gemma)

---

## Why this exists

When a flood, an earthquake, or a displacement wave hits, aid is rarely lost because the food, water, and medicine are not there. It is lost because the *coordination* is not there. A coordinator in a field office is juggling three notebooks, a half-charged satellite phone, and a list of volunteers who keep coming back from deliveries with notes scribbled on the back of food-parcel receipts. By the time the right hygiene kit reaches the right grandmother, two days have passed and a different family three streets away — the one with the diabetic teenager — has been missed entirely.

I wanted to build the smallest piece of software that could close that single gap, end-to-end, on a single laptop, without an internet bill, without a cloud account, without a PhD to operate it. Open-weight models like Gemma 4 finally make that physically possible: a humanitarian-grade reasoning engine that fits on a field laptop and runs on solar.

AidFlow Pro is that experiment.

## Who it is for

There are two roles in the building:

**The administrator (the coordinator).** Sits in front of AidFlow Pro most of the day. Registers families, manages the worker roster, plans deliveries, dispatches orders, uploads protocol PDFs, watches the dashboard, asks Gemma 4 questions, exports reports.

**The field workers.** Spend most of the day outside. They receive an order from the admin, drive to a family, deliver the items, take notes about what they saw — *"mother is recovering from surgery, needs softer food"*, *"two new infants since last visit"*, *"shelter tarp is torn"* — and report those notes back through the delivery-confirmation step. The admin sees those notes the moment the worker submits them; Gemma 4 sees them the next time it scores that family's priority.

Everything in the app is built around that loop: **plan → dispatch → deliver-and-report → re-prioritize**.

## What humanitarian aid distribution looks like in one minute

Relief organizations send field teams to register affected households, assess what they need (food, water, medical supplies, shelter, hygiene kits), and hand out the right items in the right order. The work has three rhythms: **register** the people you can reach, **triage** them by urgency, and **deliver** the right items while keeping a clean ledger so nothing is double-counted, lost, or stolen. The hard part is keeping all three rhythms in sync across dozens of workers, four languages, intermittent power, and a population whose situation changes every hour.

## The wall this project tries to break

| What a coordinator deals with today | Why it fails | What AidFlow Pro does instead |
|---|---|---|
| A roster of impacted families that lives in three notebooks and a WhatsApp group | "Family Hassan" and "Hassan H., 4 kids" are the same household but get registered twice; no audit trail. | A structured family registry the admin owns: stable IDs, sector + displacement + medical fields, soft-delete, inline edit, full search, demo storage in IndexedDB and a pluggable data layer for production backends. |
| Daily priorities decided by whoever shouts loudest at the morning briefing | Bias creeps in; quiet families get missed; nobody can defend the order to a donor afterwards. | Gemma 4 produces a 0–100 priority score with a written explanation per family, re-ranking the queue after every delivery so newly-served households drop down and unmet ones rise. |
| Workers come back with notes scribbled on receipts | Notes get lost, unreadable, or never make it back to the registry. | The delivery-confirmation step captures items delivered + medical notes + general notes, and writes them straight onto the family's record where the admin and the AI can both read them. |
| "We'll do it once we get internet" | The signal never comes; the laptop dies; the day is wasted. | Every screen — registration, prioritization, dispatch, document Q&A, reports — works fully offline. The network is never on the critical path. |
| Two staff dispatch the same order at the same instant | Duplicate order numbers, ledger corrupted by midday. | Sequential `ORD-NNNN` numbers minted inside an atomic transaction; the dispatch button is debounced; workers already out for delivery are filtered out of the assignment picker. |
| Aid manuals are PDFs sitting in someone's email | A new volunteer cannot find the cholera-response protocol on Day 1. | Drop PDFs into the Knowledge Base. Gemma 4 reads them locally with retrieval-augmented generation, cites the source document, and refuses to invent answers outside the corpus. |
| Field workers cannot reach each other when the uplink drops | One satellite outage and the team goes silent — missed handoffs, double-deliveries. | An in-app step-by-step installation guide plus an offline APK for the official **Bitchat** Android app, so workers chat over a Bluetooth mesh between phones with zero infrastructure. AidFlow Pro hosts the installer; the mesh itself runs inside Bitchat. |
| "Where do we buy a Starlink kit, and is service even live in this country?" | Procurement teams end up on counterfeit reseller sites or buy from couriers who never deliver. | An auto-synced, continent-grouped list of SpaceX-published **authorized Starlink retailers**, plus a country-availability snapshot, mirrored hourly from starlink.com while online. |
| Field workers speak Arabic, French, or Spanish; the software speaks English | Slow translations, missed nuance, mistakes pile up in the ledger. | Full UI in English, Arabic (RTL), French, and Spanish. Gemma 4 answers in the language of the question. |

## What the administrator can actually do

**Manage the team.** Add, edit, or remove workers (first name, last name, position, email, address). Soft-delete preserves the link from historic orders to the worker who delivered them.

**Run the registry.** Register impacted families with displacement status, income level, sector, household composition, current needs (with quantities), medical flags, and free-text notes. Search by name, sector, or urgency. Filter and sort the priority queue.

**Read the AI's reasoning, edit it back.** Open any family's detail page and ask the on-page assistant about that household. The AI has the family's full record + all past distributions, so questions like *"when was the last time we delivered to this family?"* return real answers grounded in the ledger. The assistant can also propose changes to the family record — *"set displacement to 'displaced'; add 2× hygiene kits to current needs"* — which surface as **Apply / Discard** buttons before any write hits the database.

**Plan and dispatch deliveries.** A three-step wizard: pick the family, pick the worker, pick the items and quantities. The wizard mints a sequential order number atomically, debounces the dispatch button, blocks assignment to workers already out for delivery, and warns when a critical-priority family is being delivered to with no medical notes attached. AI hints in step 3 cross-check the items against the family's recorded needs.

**Capture worker reports.** When a worker marks an order delivered, the in-app delivery-confirmation modal collects items delivered + medical notes + general notes. Those notes attach to the family record immediately. Status lifecycle: `pending → out_for_delivery → delivered / failed / cancelled`. Failed and cancelled orders capture a reason via an in-app modal.

**Build a knowledge base.** Drop PDF protocols into the Knowledge Base tab. The app extracts text, chunks it, embeds it (or falls back to keyword search if no embedding model is available), and indexes it for RAG. Search by title, category, filename, or full content. Per-document **Summarize** button streams a structured summary inline. The on-page chat is locked to RAG-on so answers always cite uploaded sources.

**Watch the dashboard.** Live KPI cards (families, deliveries today, items handed out, critical-priority count). Charts (priority distribution, sector mix, deliveries over time). Distribution history with filters. Markdown-rendered AI executive summary, with a deterministic rule-based fallback when Ollama is offline. CSV export.

**Reach the team.** A guided installation flow for Bitchat (Play Store path or offline APK sideload) gives workers a peer-to-peer Bluetooth mesh chat that does not depend on the cell network or the satellite uplink.

**Procure infrastructure.** The Starlink tab lists every official authorized reseller (continent → country) and a country-availability snapshot, both synced hourly from a JSON file in the repo (which mirrors starlink.com).

**Configure the system.** Light / dark / system theme. Language switcher (EN / AR / FR / ES). Ollama URL and model overrides. Demo-data reset. About + attribution.

## Why this is built on Gemma 4 specifically

| Property | What it gets us |
|---|---|
| **Open weights, runnable locally** | The whole reason this project is possible. No data leaves the laptop. No monthly bill. No "cloud unavailable" outage in a disaster zone. |
| **E4B variant footprint** | Small enough to run on a field laptop with 16 GB of RAM. Big enough to follow a four-step humanitarian triage prompt without falling apart. |
| **Native multilingual fluency** | Field reports in Arabic, French, and Spanish answered in the same language they were asked. Right-to-left support without a translation hop. |
| **Good instruction following on tight system prompts** | Lets us pin behavior with a strict RAG system prompt that refuses to invent fake "WASH platform sections" and stays inside the user's uploaded PDFs. |
| **Streaming via Ollama's chat-completions endpoint** | Tokens arrive in tens of milliseconds, not after a 30-second wait — important on slow field hardware. |
| **Apache-2.0 weights with permissive redistribution** | A humanitarian NGO can ship an internal build to its own field laptops without a per-seat license negotiation. |

## How it works under the hood

There is no backend. The whole system fits in a browser tab.

```
   ┌─────────────────────────────────────────────────────────┐
   │  AidFlow Pro PWA  (React 18 + TypeScript + Tailwind)    │
   │                                                         │
   │  ┌──────────────────────────────────────────────────┐   │
   │  │ Admin UI  — Dashboard / Workers / Families /     │   │
   │  │            Distribute / Knowledge Base /         │   │
   │  │            Aid Guides / Kids / Bitchat /         │   │
   │  │            Starlink / Assistant / Settings       │   │
   │  └────────────┬───────────────────┬─────────────────┘   │
   │               │                   │                     │
   │      ┌────────▼─────────┐  ┌──────▼────────────┐        │
   │      │  Local DB        │  │  RAG pipeline     │        │
   │      │  (Dexie / IDB    │  │  - chunking       │        │
   │      │   in demo;       │  │  - cosine search  │        │
   │      │   pluggable in   │  │  - keyword fall.  │        │
   │      │   production)    │  │  - inventory inj. │        │
   │      └──────────────────┘  └──────┬────────────┘        │
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

### Demo storage versus production storage

Out of the box, AidFlow Pro stores everything in **IndexedDB (via Dexie.js)** so the demo is fully self-contained: clone the repo, run `npm install`, and you have a working aid coordinator with seeded mock data — no auth, no servers, no hosting bill. **In a real deployment**, an organization would replace the local data layer with their own infrastructure: a hosted Postgres / MySQL / SQLite-backed API, an existing humanitarian information system (Kobo Toolbox, CommCare, RedRose), or any internal database that can speak HTTP. The data-access layer is isolated in `src/db/` and the service files that wrap it (`src/services/`), so swapping IndexedDB for a REST or GraphQL client is a localized change — every page above it keeps working unchanged.

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

On first load the app seeds the local database with mock workers, families, distributions, aid items, and Starlink data so you can play with the priority ranking, distribution wizard, and Knowledge Base without registering anything yourself. **Settings → Reset demo data** wipes and re-seeds.

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

## Project layout

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
│   │   ├── Card.tsx
│   │   ├── DistributionWizard.tsx
│   │   ├── FamilyEditModal.tsx
│   │   ├── NoticeModal.tsx
│   │   ├── DeleteDocumentModal.tsx
│   │   ├── DeleteWorkerModal.tsx
│   │   ├── PriorityBadge.tsx
│   │   ├── EmptyState.tsx
│   │   └── Loading.tsx
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Workers.tsx
│   │   ├── Families.tsx
│   │   ├── FamilyDetail.tsx
│   │   ├── Distribute.tsx
│   │   ├── KnowledgeBase.tsx
│   │   ├── AidGuides.tsx
│   │   ├── KidsContent.tsx
│   │   ├── Bitchat.tsx
│   │   ├── StarlinkMap.tsx
│   │   ├── Assistant.tsx
│   │   ├── Reports.tsx
│   │   └── Settings.tsx
│   ├── services/
│   │   ├── ollama.ts
│   │   ├── rag.ts
│   │   ├── priorityRules.ts
│   │   ├── bitchat.ts
│   │   ├── resellers.ts
│   │   └── starlinkCountries.ts
│   ├── db/
│   │   ├── database.ts
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
│   ├── data/
│   │   └── starlink-resellers.json
│   └── manifest.webmanifest
├── tailwind.config.js
├── vite.config.ts
├── package.json
└── README.md
```

## Glossary

- **Administrator / Coordinator** — the person running AidFlow Pro from a desk or laptop. Plans, dispatches, watches the dashboard, asks the AI questions.
- **Field worker** — the person who actually delivers aid. Receives orders, marks them delivered, attaches medical and general notes from the visit.
- **Sector** — a category of humanitarian work (Food Security, WASH, Shelter, Health, Protection, Nutrition).
- **Triage** — ranking households by urgency. AidFlow Pro's triage is a Gemma-4-explained 0–100 score plus a deterministic rule-engine fallback.
- **Distribution / Order** — a single recorded handover of items from a worker to a family at a timestamp, with a sequential `ORD-NNNN` number and a status (`pending`, `out_for_delivery`, `delivered`, `failed`, `cancelled`). The atomic unit of the ledger.
- **Soft delete** — flagging a row as removed without physically erasing it, so historic references (e.g. the worker who delivered an order last week) keep working.
- **RAG** — Retrieval-Augmented Generation. Pulling the most relevant chunks of an uploaded PDF into the model's context window so the answer is grounded in real source material.
- **Bitchat** — a Bluetooth-mesh peer-to-peer chat protocol with its own native Android app. AidFlow Pro does **not** implement Bitchat itself; it provides the install guide and offline APK so workers can adopt it.
- **Starlink authorized retailer** — a reseller listed by SpaceX as authorized to sell genuine Starlink hardware, as published on starlink.com.
- **PWA** — Progressive Web App. Installs to the home screen, ships its own service worker, runs offline.

## What this project is **not**

- **Not a certified humanitarian information system.** Real deployments require IATI / 3W reporting, donor compliance, and audited PII handling. This is a hackathon prototype.
- **Not medical software.** Medical flags on a family record are operational hints for triage, not clinical diagnoses.
- **Not a production database.** The bundled IndexedDB layer is for demo and offline single-laptop use. Multi-device organizations are expected to plug in their own server, API, or existing humanitarian information system.
- **Not affiliated with, endorsed by, or sponsored by Google.** Gemma 4 is the inference engine; this project is independently developed for the Gemma 4 Good Hackathon.
- **Not affiliated with SpaceX, Starlink, or Bitchat.** The Starlink and Bitchat pages reference publicly published information for the convenience of field teams; trademarks belong to their respective owners.
- **Not a replacement for trained humanitarian professionals.** It is a tool to make their work faster and less error-prone.

## Hackathon submission

- **Hackathon:** Gemma 4 Good Hackathon
- **Track:** Global Resilience
- **Model:** Gemma 4 E4B, hosted locally via Ollama
- **Deliverables:**
  - This repository (open source, MIT-licensed app code)
  - A 3-minute demo video walking through registration → triage → dispatch → worker report-back → Knowledge Base RAG
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

Starlink is a registered trademark of Space Exploration Technologies Corp. (SpaceX). Bitchat is an independent open-source project. Both are referenced in this app for the operational benefit of humanitarian field teams; AidFlow Pro is not affiliated with either.

## Acknowledgements

Built with the open-source giants of the modern web: React, TypeScript, Vite, TailwindCSS, Dexie.js, Workbox, Recharts, react-i18next, react-markdown, pdfjs-dist, lucide-react, Zustand, and Ollama. Thanks to the humanitarian responders whose published field protocols and after-action reports shaped the requirements behind every screen — the work is theirs; this is just a tool that hopes to help carry it.
