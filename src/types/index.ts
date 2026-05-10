// AidFlow Pro — shared domain types
// Mirrors the schema in PDF section 11 (Database Schema) but persisted in IndexedDB
// rather than PostgreSQL since the user opted to skip the backend.

export type DisplacementStatus = 'resident' | 'recently_displaced' | 'refugee';
export type IncomeLevel = 'none' | 'minimal' | 'moderate';
export type PriorityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NORMAL';

/**
 * A single need on a family's "Current need items" card.
 * Stored as objects (not strings) so quantity is first-class everywhere —
 * the family card, the distribute wizard's "Suggested needs", the delivery
 * confirm modal's pre-population, and the AI assistant's action protocol.
 */
export interface NeededItem {
  name: string;
  quantity: number;
}
export type UserRole =
  | 'admin'
  | 'supervisor'
  | 'field_worker'
  | 'data_manager'
  | 'viewer';

export interface Family {
  family_id: string;
  head_name: string;
  member_count: number;
  children_under_5: number;
  elderly_count: number;
  has_pregnant_member: boolean;
  medical_conditions: string[];
  displacement_status: DisplacementStatus;
  income_level: IncomeLevel;
  location_sector: string;
  coordinates?: { lat: number; lng: number };
  last_updated: string;
  notes: string;
  /** Street address — house number, street name. Optional. */
  street?: string;
  /** City / town / village name. Optional. */
  city?: string;
  priority_score?: number;
  priority_level?: PriorityLevel;
  ai_reason?: string;
  recommended_items?: NeededItem[];
  last_aid_at?: string;
  new_need_flagged?: boolean;
  /** Free-text medical notes captured by the field worker on the last delivery. */
  last_medical_notes?: string;
  /** Free-text general notes captured by the field worker on the last delivery. */
  last_delivery_notes?: string;
  /**
   * Soft-delete timestamp. Set when the admin deletes the family.
   * Filtering on this preserves historic AidDistribution.family_id
   * references so audit trail and history grids stay coherent. Same
   * pattern as Worker.deleted_at — never hard-delete.
   */
  deleted_at?: string;
}

export type DistributionStatus =
  | 'pending'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface AidDistribution {
  distribution_id: string;
  /** Short, human-friendly sequential number. Display as ORD-001 etc. */
  order_number?: number;
  family_id: string;
  session_id: string;
  status: DistributionStatus;
  items_distributed: { item_name: string; quantity: number; category: string }[];

  created_at: string;
  created_by: string;
  scheduled_for?: string;
  dispatched_at?: string;
  delivered_at?: string;
  closed_at?: string;

  assigned_to?: string;
  delivered_by?: string;

  ai_priority_score: number;
  ai_reasoning: string;

  notes?: string;
  post_update_notes?: string;
  failure_reason?: string;
  new_needs_flagged?: boolean;

  /** @deprecated Use `delivered_by` (post-delivery) or `assigned_to` (pre-delivery) */
  distributed_by?: string;
  /** @deprecated Use `delivered_at` (post-delivery) or `created_at` (pre-delivery) */
  distributed_at?: string;
}

export interface KnowledgeDocument {
  doc_id: string;
  title: string;
  category: 'medical' | 'food' | 'shelter' | 'water' | 'protection' | 'general';
  uploaded_at: string;
  uploaded_by: string;
  page_count: number;
  pages: { page: number; text: string }[];
  chunks: KnowledgeChunk[];
  source_filename: string;
  file_size: number;
  /**
   * Original PDF binary stored on upload so the admin can re-download the
   * source file later. Optional — not present for documents ingested before
   * the blob-storage feature shipped, or for files larger than the per-PDF
   * cap (see MAX_ORIGINAL_BLOB_BYTES in rag.ts).
   */
  original_blob?: Blob;
  original_mime?: string;
}

export interface KnowledgeChunk {
  chunk_id: string;
  doc_id: string;
  page_start: number;
  page_end: number;
  text: string;
  embedding?: number[];
}

export interface KidsContent {
  content_id: string;
  title: string;
  /**
   * Age brackets are developmentally distinct: early childhood (5-7),
   * middle childhood (8-11), early adolescence (12-15). Lower than 5 is
   * intentionally not supported — material for under-5s needs caregiver
   * mediation that the platform doesn't model.
   */
  age_group: '5-7' | '8-11' | '12-15';
  language: 'en' | 'ar' | 'fr' | 'es';
  type: 'image' | 'video' | 'pdf' | 'story';
  data_url: string;
  mime: string;
  uploaded_at: string;
}

export interface AidGuide {
  guide_id: string;
  item_name: string;
  category: string;
  language: 'en' | 'ar' | 'fr' | 'es';
  content_type: 'pdf' | 'video' | 'text';
  body: string;
  uploaded_at: string;
}

export interface StarlinkProvider {
  id: string;
  name: string;
  country: string;
  region: string;
  type: 'reseller' | 'installer' | 'service_point' | 'official';
  lat: number;
  lng: number;
  phone?: string;
  hours?: string;
  notes?: string;
  signal: 'strong' | 'moderate' | 'weak';
  custom?: boolean;
  source: 'osm' | 'custom';
  osm_id?: number;
  osm_type?: 'node' | 'way' | 'relation';
  source_url?: string;
  last_synced_at?: string;
  is_starlink_match?: boolean;
  street?: string;
  housenumber?: string;
  postcode?: string;
  suburb?: string;
  country_code?: string;
  formatted_address?: string;
  address_resolved?: boolean;
}

export interface User {
  user_id: string;
  name: string;
  role: UserRole;
  pin: string;
  language: 'en' | 'ar' | 'fr' | 'es';
}

export type WorkerPosition =
  | 'Field Worker'
  | 'Supervisor'
  | 'Driver'
  | 'Medical Officer'
  | 'Coordinator'
  | 'Logistics'
  | 'Translator'
  | 'Volunteer'
  | 'Other';

export interface Worker {
  id: string;
  first_name: string;
  last_name: string;
  position: WorkerPosition | string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  created_at: string;
  user_id?: string;
  /**
   * Soft-delete marker. When set, the row is hidden from the Workers list and
   * from worker pickers, but is kept in IndexedDB so historic order references
   * (`assigned_to` / `delivered_by`) can still resolve names. Hard-delete is
   * blocked on workers with active orders to preserve referential integrity.
   */
  deleted_at?: string;
}

export type BitchatMessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'expired';

export interface BitchatMessage {
  msg_id: string;
  channel: string;
  author: string;
  author_id?: string;
  body: string;
  sent_at: string;
  status: BitchatMessageStatus;
  ttl?: number;
  delivered_via: 'bluetooth' | 'nostr' | 'queued' | 'local';
  failure_reason?: string;
  last_attempt_at?: string;
  attempts?: number;
  signature?: string;
  recipient_id?: string;
}

export type ConnectivityState = 'online' | 'local' | 'disconnected';

export interface BitchatApk {
  id: string;
  app: 'bitchat-android' | 'bitchat-ios';
  filename: string;
  version: string;
  size_bytes: number;
  mime: string;
  uploaded_at: string;
  uploaded_by: string;
  notes?: string;
  data: Blob;
  release_url?: string;
  release_notes?: string;
}

export type Continent =
  | 'Africa'
  | 'Asia-Pacific'
  | 'Europe'
  | 'Latin America'
  | 'Middle East'
  | 'North America'
  | 'Oceania';

export interface StarlinkReseller {
  id: string;
  name: string;
  type: 'carrier' | 'integrator' | 'reseller' | 'distributor';
  continent: Continent;
  country: string;
  region?: string;
  address?: string;
  website?: string;
  phone?: string;
  notes?: string;
  verified_source?: string;
}

export interface ResellersDataset {
  version: number;
  updated_at: string;
  source_note?: string;
  official_directory_url?: string;
  resellers: StarlinkReseller[];
}

export interface PrioritizationResult {
  family_id: string;
  priority_score: number;
  priority_level: PriorityLevel;
  reason: string;
  recommended_items: NeededItem[];
}


export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp?: string;
  citations?: Citation[];
}

export interface Citation {
  doc_id: string;
  title: string;
  page: number;
  url?: string;
  snippet?: string;
}
