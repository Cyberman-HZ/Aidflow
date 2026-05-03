// AidFlow Pro — Local IndexedDB schema (Dexie.js)
// Replaces the PostgreSQL backend per the user's instruction to skip the DB layer.
// All tables match the conceptual schema in the PDF (Section 11) so a future
// REST-API sync layer could plug in without changing the UI.

import Dexie, { Table } from 'dexie';
import type {
  Family,
  AidDistribution,
  KnowledgeDocument,
  KidsContent,
  AidGuide,
  StarlinkProvider,
  User,
  BitchatMessage,
} from '@/types';

export class AidFlowDB extends Dexie {
  families!: Table<Family, string>;
  distributions!: Table<AidDistribution, string>;
  documents!: Table<KnowledgeDocument, string>;
  kids!: Table<KidsContent, string>;
  guides!: Table<AidGuide, string>;
  providers!: Table<StarlinkProvider, string>;
  users!: Table<User, string>;
  messages!: Table<BitchatMessage, string>;
  syncQueue!: Table<{ id?: number; kind: string; payload: unknown; created_at: string }, number>;

  constructor() {
    super('aidflow-pro');
    this.version(1).stores({
      families:
        'family_id, head_name, location_sector, displacement_status, priority_score, last_updated',
      distributions: 'distribution_id, family_id, session_id, distributed_at',
      documents: 'doc_id, title, category, uploaded_at',
      kids: 'content_id, age_group, language, uploaded_at',
      guides: 'guide_id, item_name, category, language',
      providers: 'id, country, region, type, signal',
      users: 'user_id, role, name',
      messages: 'msg_id, channel, sent_at',
      syncQueue: '++id, kind, created_at',
    });
  }
}

export const db = new AidFlowDB();

// Convenience helpers ------------------------------------------------------

export async function clearAll() {
  await db.transaction(
    'rw',
    db.families,
    db.distributions,
    db.documents,
    db.kids,
    db.guides,
    db.providers,
    db.users,
    db.messages,
    db.syncQueue,
    async () => {
      await Promise.all([
        db.families.clear(),
        db.distributions.clear(),
        db.documents.clear(),
        db.kids.clear(),
        db.guides.clear(),
        db.providers.clear(),
        db.users.clear(),
        db.messages.clear(),
        db.syncQueue.clear(),
      ]);
    }
  );
}

export async function isSeeded(): Promise<boolean> {
  const familyCount = await db.families.count();
  return familyCount > 0;
}
