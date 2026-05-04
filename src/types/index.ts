// AidFlow Pro — shared domain types
// Mirrors the schema in PDF section 11 (Database Schema) but persisted in IndexedDB
// rather than PostgreSQL since the user opted to skip the backend.

export type DisplacementStatus = 'resident' | 'recently_displaced' | 'refugee';
export type IncomeLevel = 'none' | 'minimal' | 'moderate';
export type PriorityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NORMAL';
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
  medical_conditions: string[]; // e.g. ['diabetes (chronic)', 'malnutrition (critical)']
  displacement_status: DisplacementStatus;
  income_level: IncomeLevel;
  location_sector: string;
  coordinates?: { lat: number; lng: number };
  last_updated: string; // ISO timestamp
  notes: string;
  // Cached AI output
  priority_score?: number;
  priority_level?: PriorityLevel;
  ai_reason?: string;
  recommended_items?: string[];
  last_aid_at?: string;
  new_need_flagged?: boolean;
}

export interface AidDistribution {
  distribution_id: string;
  family_id: string;
  session_id: string;
  items_distributed: { item_name: string; quantity: number; category: string }[];
  distributed_by: string;
  distributed_at: string;
  ai_priority_score: number;
  ai_reasoning: string;
  post_update_notes: string;
  new_needs_flagged: boolean;
}

export interface KnowledgeDocument {
  doc_id: string;
  title: string;
  category: 'medical' | 'food' | 'shelter' | 'water' | 'protection' | 'general';
  uploaded_at: string;
  uploaded_by: string;
  page_count: number;
  // Raw extracted text per page
  pages: { page: number; text: string }[];
  // Optional pre-computed embeddings (one per chunk)
  chunks: KnowledgeChunk[];
  source_filename: string;
  file_size: number;
}

export interface KnowledgeChunk {
  chunk_id: string;
  doc_id: string;
  page_start: number;
  page_end: number;
  text: string;
  embedding?: number[]; // 768-dim from nomic-embed-text
}

export interface KidsContent {
  content_id: string;
  title: string;
  age_group: '0-5' | '6-10' | '11-15';
  language: 'en' | 'ar' | 'fr' | 'es';
  type: 'image' | 'video' | 'pdf' | 'story';
  data_url: string; // base64 for offline use
  mime: string;
  uploaded_at: string;
}

export interface AidGuide {
  guide_id: string;
  item_name: string;
  category: string;
  language: 'en' | 'ar' | 'fr' | 'es';
  content_type: 'pdf' | 'video' | 'text';
  body: string; // text content OR data url for pdfs / video URL
  uploaded_at: string;
}

export interface StarlinkProvider {
  id: string;
  name: string;
  country: string;
  region: string; // city / town / state — first non-empty admin level
  type: 'reseller' | 'installer' | 'service_point' | 'official';
  lat: number;
  lng: number;
  phone?: string;
  hours?: string;
  notes?: string;
  /** "strong" | "moderate" | "weak" — descriptive only; OSM doesn't supply this */
  signal: 'strong' | 'moderate' | 'weak';
  /** Set on user-added pins (preserved across syncs). */
  custom?: boolean;
  /** Where this entry came from. 'osm' rows are wiped/refreshed on each sync. */
  source: 'osm' | 'custom';
  /** OSM-only metadata, used to deduplicate and link back to the source */
  osm_id?: number;
  osm_type?: 'node' | 'way' | 'relation';
  source_url?: string;
  /** ISO timestamp when this entry was last refreshed from OSM */
  last_synced_at?: string;
  /** True when the OSM tags clearly identify this as a Starlink-related place */
  is_starlink_match?: boolean;
  // -------- Address breakdown (fed by OSM tags + Nominatim reverse geocode) --------
  street?: string;
  housenumber?: string;
  postcode?: string;
  suburb?: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "US", "DE") */
  country_code?: string;
  /** Pre-formatted full address string for one-line display */
  formatted_address?: string;
  /** True when address came from Nominatim reverse-geocoding (vs raw OSM tags) */
  address_resolved?: boolean;
}

export interface User {
  user_id: string;
  name: string;
  role: UserRole;
  pin: string; // demo only — real impl uses bcrypt + JWT per the PDF
  language: 'en' | 'ar' | 'fr' | 'es';
}

export interface BitchatMessage {
  msg_id: string;
  channel: string;
  author: string;
  body: string;
  sent_at: string;
  delivered_via: 'bluetooth' | 'nostr' | 'queued';
}

export type ConnectivityState = 'online' | 'local' | 'disconnected';

// Continents used to group authorized resellers in the UI.
// Matches the categorization on the official Starlink retailers article:
// https://starlink.com/support/article/8a90222d-7c32-edd7-51f6-f696ece07105
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
  /** "carrier" = mobile network operator (Direct-to-Cell partner), "integrator" = enterprise systems integrator, "reseller" = consumer authorized retailer */
  type: 'carrier' | 'integrator' | 'reseller' | 'distributor';
  continent: Continent;
  country: string;
  /** Country / region / state-level location of the office or retail presence */
  region?: string;
  address?: string;
  website?: string;
  phone?: string;
  notes?: string;
  /** URL the editor used to verify this entry — public sources only */
  verified_source?: string;
}

export interface ResellersDataset {
  /** Schema version of the JSON file format */
  version: number;
  /** ISO date the JSON was last edited */
  updated_at: string;
  /** Description / how-to-edit text shown in the UI */
  source_note?: string;
  resellers: StarlinkReseller[];
}

// Gemma 4 prioritization output (PDF Appendix D)
export interface PrioritizationResult {
  family_id: string;
  priority_score: number;
  priority_level: PriorityLevel;
  reason: string;
  recommended_items: string[];
  sector?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  citations?: { doc_id: string; title: string; page: number; url?: string }[];
  timestamp?: string;
}
