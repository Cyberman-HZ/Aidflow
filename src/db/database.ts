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
  StarlinkReseller,
  User,
  Worker,
  BitchatMessage,
  BitchatApk,
  AidflowAndroidApk,
} from '@/types';

export class AidFlowDB extends Dexie {
  families!: Table<Family, string>;
  distributions!: Table<AidDistribution, string>;
  documents!: Table<KnowledgeDocument, string>;
  kids!: Table<KidsContent, string>;
  guides!: Table<AidGuide, string>;
  providers!: Table<StarlinkProvider, string>;
  resellers!: Table<StarlinkReseller, string>;
  users!: Table<User, string>;
  workers!: Table<Worker, string>;
  messages!: Table<BitchatMessage, string>;
  bitchatApks!: Table<BitchatApk, string>;
  aidflowAndroidApks!: Table<AidflowAndroidApk, string>;
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

    // v2 — add `source` index on providers so we can efficiently wipe stale
    //      OSM rows on each sync without touching user-added custom pins.
    this.version(2).stores({
      providers: 'id, country, region, type, signal, source, osm_id',
    });

    // v3 — add resellers table (synced hourly from a curated JSON file).
    this.version(3).stores({
      resellers: 'id, continent, country, type',
    });

    // v4 — distribution status lifecycle. Add `status`, `assigned_to`,
    //      `created_at` indexes for filtering. Migrate v1 rows: any
    //      existing distribution without a status is treated as 'delivered'
    //      (since the legacy schema only recorded actual deliveries).
    this.version(4)
      .stores({
        distributions:
          'distribution_id, family_id, session_id, status, assigned_to, created_at, delivered_at, distributed_at',
      })
      .upgrade(async (tx) => {
        const table = tx.table('distributions');
        await table.toCollection().modify((d: any) => {
          if (!d.status) {
            // Legacy rows recorded immediate deliveries
            d.status = 'delivered';
            d.delivered_at = d.delivered_at ?? d.distributed_at ?? new Date().toISOString();
            d.delivered_by = d.delivered_by ?? d.distributed_by;
            d.created_at = d.created_at ?? d.delivered_at;
            d.created_by = d.created_by ?? d.distributed_by ?? 'system';
          }
        });
      });

    // v5 — Bitchat message status lifecycle. Add `status` index, migrate
    //      legacy `delivered_via` to a proper status field.
    this.version(5)
      .stores({
        messages: 'msg_id, channel, sent_at, status, delivered_via',
      })
      .upgrade(async (tx) => {
        const table = tx.table('messages');
        await table.toCollection().modify((m: any) => {
          if (!m.status) {
            switch (m.delivered_via) {
              case 'bluetooth':
              case 'nostr':
                m.status = 'sent';
                break;
              case 'queued':
                m.status = 'queued';
                break;
              default:
                m.status = 'sent';
            }
          }
          if (m.attempts === undefined) m.attempts = m.delivered_via === 'queued' ? 0 : 1;
        });
      });

    // v6 — Bitchat APK / IPA cache. Field teams can download the installer
    //      from the AidFlow server even when there's no internet, as long as
    //      an admin uploaded it once on a previous connection.
    this.version(6).stores({
      bitchatApks: 'id, app, version, uploaded_at',
    });

    // v7 — Workers table + sequential order_number on distributions.
    this.version(7)
      .stores({
        workers: 'id, position, last_name, first_name, user_id',
        distributions:
          'distribution_id, order_number, family_id, session_id, status, assigned_to, created_at, delivered_at, distributed_at',
      })
      .upgrade(async (tx) => {
        const usersTable = tx.table('users');
        const workersTable = tx.table('workers');
        const distributionsTable = tx.table('distributions');

        // 1) Migrate users with field_worker/supervisor role into workers.
        const allUsers = (await usersTable.toArray()) as User[];
        const userToWorker = new Map<string, string>();
        for (const u of allUsers) {
          if (u.role !== 'field_worker' && u.role !== 'supervisor') continue;
          const parts = u.name.trim().split(/\s+/);
          const first_name = parts[0] ?? '';
          const last_name = parts.slice(1).join(' ');
          const workerId = `W-${u.user_id.replace(/^U-/, '')}`;
          await workersTable.put({
            id: workerId,
            first_name,
            last_name,
            position: u.role === 'supervisor' ? 'Supervisor' : 'Field Worker',
            created_at: new Date().toISOString(),
            user_id: u.user_id,
          });
          userToWorker.set(u.user_id, workerId);
        }

        // 2) Rewrite distributions to point at worker IDs and assign order numbers.
        const allDistributions = await distributionsTable
          .orderBy('created_at')
          .toArray();
        for (let i = 0; i < allDistributions.length; i++) {
          const d = allDistributions[i] as any;
          const updates: any = {};
          if (d.assigned_to && userToWorker.has(d.assigned_to)) {
            updates.assigned_to = userToWorker.get(d.assigned_to);
          }
          if (d.delivered_by && userToWorker.has(d.delivered_by)) {
            updates.delivered_by = userToWorker.get(d.delivered_by);
          }
          if (d.distributed_by && userToWorker.has(d.distributed_by)) {
            updates.distributed_by = userToWorker.get(d.distributed_by);
          }
          if (typeof d.order_number !== 'number') {
            updates.order_number = i + 1;
          }
          if (Object.keys(updates).length) {
            await distributionsTable.update(d.distribution_id, updates);
          }
        }
      });

    // v8 — Needed items become objects with a quantity. Earlier rows stored
    //      family.recommended_items as string[]; we convert each entry to
    //      { name, quantity: 1 } so the UI's new quantity field has a sane
    //      default and downstream code can rely on the structured shape.
    this.version(8).upgrade(async (tx) => {
      const families = tx.table('families');
      await families.toCollection().modify((f: any) => {
        if (!Array.isArray(f.recommended_items)) return;
        f.recommended_items = f.recommended_items.map((it: any) => {
          if (it && typeof it === 'object' && typeof it.name === 'string') {
            const q = Number(it.quantity);
            return {
              name: it.name,
              quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
            };
          }
          // Legacy string entry — wrap with a default quantity of 1.
          return { name: String(it), quantity: 1 };
        });
      });
    });

    // v9 — AidFlow Android companion-app APK cache. Singleton row keyed by
    //      a fixed id ('aidflow-android'). Admin uploads the .apk once
    //      while online; field teams pull it offline from the same AidFlow
    //      instance. Mirrors the bitchatApks pattern (separate table so a
    //      future iOS row can join without coupling the two products).
    this.version(9).stores({
      aidflowAndroidApks: 'id, version, uploaded_at',
    });
  }

  /**
   * Wipe all user data. Used by the "Reset demo data" admin action so a
   * field-test session can start from a clean slate without re-creating
   * the IndexedDB.
   */
  async clearAll() {
    await Promise.all([
      this.families.clear(),
      this.distributions.clear(),
      this.documents.clear(),
      this.kids.clear(),
      this.guides.clear(),
      this.providers.clear(),
      this.resellers.clear(),
      this.users.clear(),
      this.workers.clear(),
      this.messages.clear(),
      this.bitchatApks.clear(),
      this.aidflowAndroidApks.clear(),
      this.syncQueue.clear(),
    ]);
  }
}

export const db = new AidFlowDB();

/**
 * Returns true if seed data has already been loaded (the families table is
 * non-empty). Used by seedData.ts to avoid duplicating demo rows.
 */
export async function isSeeded(): Promise<boolean> {
  return (await db.families.count()) > 0;
}
