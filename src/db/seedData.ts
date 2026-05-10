// Realistic demo data so the hackathon judges see a working product on first load.
// Names and locations are illustrative — they don't reference real individuals.

import { db, isSeeded } from './database';
import type {
  Family,
  AidDistribution,
  StarlinkProvider,
  User,
  Worker,
  KidsContent,
  AidGuide,
} from '@/types';

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const families: Family[] = [
  {
    family_id: 'F-0042',
    head_name: 'Ahmed Al-Rashid',
    member_count: 7,
    children_under_5: 3,
    elderly_count: 1,
    has_pregnant_member: true,
    medical_conditions: ['malnutrition (critical)', 'asthma (chronic)'],
    displacement_status: 'recently_displaced',
    income_level: 'none',
    location_sector: 'Sector-B-North',
    coordinates: { lat: 33.513, lng: 36.292 },
    last_updated: daysAgo(1),
    notes: 'Lost home in flooding. Living in temporary shelter near school.',
    last_aid_at: daysAgo(18),
    new_need_flagged: true,
  },
  {
    family_id: 'F-0089',
    head_name: 'Maria Gonzalez',
    member_count: 5,
    children_under_5: 1,
    elderly_count: 2,
    has_pregnant_member: false,
    medical_conditions: ['diabetes (critical)', 'hypertension (chronic)'],
    displacement_status: 'resident',
    income_level: 'minimal',
    location_sector: 'Sector-A-South',
    coordinates: { lat: 33.499, lng: 36.301 },
    last_updated: daysAgo(2),
    notes: 'Diabetic family member needs insulin. Regular distribution recipient.',
    last_aid_at: daysAgo(9),
  },
  {
    family_id: 'F-0123',
    head_name: 'Fatima Hassan',
    member_count: 9,
    children_under_5: 4,
    elderly_count: 1,
    has_pregnant_member: true,
    medical_conditions: ['anemia (chronic)'],
    displacement_status: 'refugee',
    income_level: 'none',
    location_sector: 'Sector-C-East',
    coordinates: { lat: 33.521, lng: 36.275 },
    last_updated: daysAgo(3),
    notes: 'Refugee family of 9. Husband missing. Eldest child caring for siblings.',
    last_aid_at: daysAgo(14),
  },
  {
    family_id: 'F-0167',
    head_name: 'Jean-Pierre Dubois',
    member_count: 4,
    children_under_5: 0,
    elderly_count: 2,
    has_pregnant_member: false,
    medical_conditions: [],
    displacement_status: 'resident',
    income_level: 'moderate',
    location_sector: 'Sector-A-South',
    coordinates: { lat: 33.495, lng: 36.310 },
    last_updated: daysAgo(7),
    notes: 'Stable household. Acts as community liaison.',
    last_aid_at: daysAgo(5),
  },
  {
    family_id: 'F-0201',
    head_name: 'Aisha Ibrahim',
    member_count: 6,
    children_under_5: 2,
    elderly_count: 0,
    has_pregnant_member: false,
    medical_conditions: ['cholera exposure (critical)'],
    displacement_status: 'recently_displaced',
    income_level: 'none',
    location_sector: 'Sector-B-North',
    coordinates: { lat: 33.510, lng: 36.288 },
    last_updated: daysAgo(1),
    notes: 'Suspected cholera in household. Needs medical priority.',
    last_aid_at: daysAgo(11),
    new_need_flagged: true,
  },
  {
    family_id: 'F-0245',
    head_name: 'Mohammed Khalil',
    member_count: 3,
    children_under_5: 0,
    elderly_count: 1,
    has_pregnant_member: false,
    medical_conditions: [],
    displacement_status: 'resident',
    income_level: 'minimal',
    location_sector: 'Sector-C-East',
    coordinates: { lat: 33.518, lng: 36.279 },
    last_updated: daysAgo(4),
    notes: 'Small household. Elderly mother lives with adult son and his wife.',
    last_aid_at: daysAgo(7),
  },
  {
    family_id: 'F-0278',
    head_name: 'Carlos Mendoza',
    member_count: 8,
    children_under_5: 2,
    elderly_count: 1,
    has_pregnant_member: false,
    medical_conditions: ['tuberculosis (critical)'],
    displacement_status: 'refugee',
    income_level: 'none',
    location_sector: 'Sector-D-West',
    coordinates: { lat: 33.488, lng: 36.265 },
    last_updated: daysAgo(2),
    notes: 'TB case in family — needs isolation supplies and medical referral.',
    last_aid_at: daysAgo(13),
  },
  {
    family_id: 'F-0301',
    head_name: 'Layla Karim',
    member_count: 4,
    children_under_5: 1,
    elderly_count: 0,
    has_pregnant_member: true,
    medical_conditions: [],
    displacement_status: 'recently_displaced',
    income_level: 'none',
    location_sector: 'Sector-B-North',
    coordinates: { lat: 33.515, lng: 36.290 },
    last_updated: daysAgo(1),
    notes: 'Single mother, 8 months pregnant. Needs prenatal vitamins.',
    last_aid_at: daysAgo(16),
  },
  {
    family_id: 'F-0344',
    head_name: 'Pierre Tshibanda',
    member_count: 5,
    children_under_5: 1,
    elderly_count: 0,
    has_pregnant_member: false,
    medical_conditions: ['malaria (chronic)'],
    displacement_status: 'resident',
    income_level: 'minimal',
    location_sector: 'Sector-D-West',
    coordinates: { lat: 33.485, lng: 36.270 },
    last_updated: daysAgo(5),
    notes: 'Recurring malaria episodes. Mosquito nets needed.',
    last_aid_at: daysAgo(8),
  },
  {
    family_id: 'F-0388',
    head_name: 'Yusuf Abdullah',
    member_count: 11,
    children_under_5: 4,
    elderly_count: 2,
    has_pregnant_member: false,
    medical_conditions: ['malnutrition (chronic)'],
    displacement_status: 'refugee',
    income_level: 'none',
    location_sector: 'Sector-C-East',
    coordinates: { lat: 33.522, lng: 36.278 },
    last_updated: daysAgo(2),
    notes: 'Extended family of 11. Three generations under one tarp.',
    last_aid_at: daysAgo(15),
  },
];

const distributions: AidDistribution[] = [
  // Two completed distributions
  {
    distribution_id: 'D-0001',
    order_number: 1,
    family_id: 'F-0042',
    session_id: 'S-2026-04-15',
    status: 'delivered',
    items_distributed: [
      { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
      { item_name: 'Drinking water (20L)', quantity: 4, category: 'water' },
    ],
    created_at: daysAgo(19),
    created_by: 'U-supervisor-1',
    assigned_to: 'W-fieldworker-1',
    dispatched_at: daysAgo(18),
    delivered_at: daysAgo(18),
    delivered_by: 'W-fieldworker-1',
    distributed_by: 'W-fieldworker-1',
    distributed_at: daysAgo(18),
    ai_priority_score: 91,
    ai_reasoning: '3 children under 5, pregnant mother, recently displaced.',
    post_update_notes: 'Family received in good order. Mother reported child has fever.',
    new_needs_flagged: true,
  },
  {
    distribution_id: 'D-0002',
    order_number: 2,
    family_id: 'F-0089',
    session_id: 'S-2026-04-22',
    status: 'delivered',
    items_distributed: [
      { item_name: 'Diabetic-safe rations', quantity: 1, category: 'food' },
      { item_name: 'Insulin pen', quantity: 2, category: 'medical' },
    ],
    created_at: daysAgo(10),
    created_by: 'U-supervisor-1',
    assigned_to: 'W-fieldworker-2',
    dispatched_at: daysAgo(9),
    delivered_at: daysAgo(9),
    delivered_by: 'W-fieldworker-2',
    distributed_by: 'W-fieldworker-2',
    distributed_at: daysAgo(9),
    ai_priority_score: 67,
    ai_reasoning: '2 elderly, critical diabetes case, 9 days without aid.',
    post_update_notes: 'Insulin delivered. Glucose meter requested next cycle.',
    new_needs_flagged: false,
  },
  // Active orders demonstrating the lifecycle
  {
    distribution_id: 'D-0003',
    order_number: 3,
    family_id: 'F-0201',
    session_id: 'S-2026-05-04',
    status: 'out_for_delivery',
    items_distributed: [
      { item_name: 'Oral rehydration salts', quantity: 10, category: 'medical' },
      { item_name: 'Water purification tablets', quantity: 30, category: 'water' },
      { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
    ],
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    created_by: 'U-supervisor-1',
    assigned_to: 'W-fieldworker-1',
    dispatched_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    ai_priority_score: 100,
    ai_reasoning: 'Suspected cholera, 2 children under 5, recently displaced — urgent.',
    notes: 'Critical — escort by medical lead. Verify cholera suspicion in person.',
  },
  {
    distribution_id: 'D-0004',
    order_number: 4,
    family_id: 'F-0301',
    session_id: 'S-2026-05-04',
    status: 'pending',
    items_distributed: [
      { item_name: 'Prenatal supplements', quantity: 1, category: 'medical' },
      { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
    ],
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    created_by: 'U-supervisor-1',
    scheduled_for: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ai_priority_score: 97,
    ai_reasoning: 'Pregnant mother, child under 5, no income, 16 days without aid.',
    notes: 'Schedule alongside next Sector-B-North run.',
  },
  {
    distribution_id: 'D-0005',
    order_number: 5,
    family_id: 'F-0123',
    session_id: 'S-2026-05-04',
    status: 'pending',
    items_distributed: [
      { item_name: 'Family food parcel (15 days)', quantity: 2, category: 'food' },
      { item_name: 'Drinking water (20L)', quantity: 6, category: 'water' },
      { item_name: 'Blankets', quantity: 4, category: 'shelter' },
    ],
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    created_by: 'U-admin-1',
    ai_priority_score: 85,
    ai_reasoning: 'Refugee family of 9, eldest child caring for siblings.',
    notes: 'Confirm headcount on arrival; husband still missing.',
  },
];

// No fake provider seed. The Starlink Map page now fetches real telecom /
// ISP / Starlink-related providers from OpenStreetMap on demand via the
// Overpass API. The `providers` table in IndexedDB is reserved for the
// user's own custom pins (added via the "+ Add custom pin" button).
const providers: StarlinkProvider[] = [];

const users: User[] = [
  { user_id: 'U-admin-1', name: 'Sarah Chen', role: 'admin', pin: '1234', language: 'en' },
  { user_id: 'U-supervisor-1', name: 'Karim Al-Maliki', role: 'supervisor', pin: '2345', language: 'ar' },
  { user_id: 'U-fieldworker-1', name: 'Pierre Lefevre', role: 'field_worker', pin: '3456', language: 'fr' },
  { user_id: 'U-fieldworker-2', name: 'Carmen Diaz', role: 'field_worker', pin: '4567', language: 'es' },
  { user_id: 'U-data-1', name: 'Amir Patel', role: 'data_manager', pin: '5678', language: 'en' },
];

// Workers — field deployment roster. Distribution orders point at worker IDs.
// The two field-worker users above also exist as workers (linked via user_id)
// so admins/supervisors who log in are still bookable for deliveries.
const workers: Worker[] = [
  {
    id: 'W-fieldworker-1',
    first_name: 'Pierre',
    last_name: 'Lefevre',
    position: 'Field Worker',
    user_id: 'U-fieldworker-1',
    created_at: now(),
  },
  {
    id: 'W-fieldworker-2',
    first_name: 'Carmen',
    last_name: 'Diaz',
    position: 'Field Worker',
    user_id: 'U-fieldworker-2',
    created_at: now(),
  },
  {
    id: 'W-supervisor-1',
    first_name: 'Karim',
    last_name: 'Al-Maliki',
    position: 'Supervisor',
    user_id: 'U-supervisor-1',
    created_at: now(),
  },
  {
    id: 'W-driver-1',
    first_name: 'Tariq',
    last_name: 'Hassan',
    position: 'Driver',
    phone: '+963-94-555-0011',
    notes: 'Owns 4×4 — preferred for unpaved sectors.',
    created_at: now(),
  },
  {
    id: 'W-medic-1',
    first_name: 'Layla',
    last_name: 'Othman',
    position: 'Medical Officer',
    notes: 'Trained for cholera response.',
    created_at: now(),
  },
];

const kids: KidsContent[] = [
  {
    content_id: 'K-001',
    title: 'Brave Little Lion (story)',
    age_group: '5-7',
    language: 'en',
    type: 'story',
    data_url:
      'data:text/plain;base64,' +
      btoa(
        'Once upon a time, a brave little lion named Leo lived in a sunny meadow. ' +
          "Even when storms came, Leo's heart stayed warm because his family loved him."
      ),
    mime: 'text/plain',
    uploaded_at: now(),
  },
  {
    content_id: 'K-003',
    title: 'Breathing Exercise (calm)',
    age_group: '12-15',
    language: 'en',
    type: 'story',
    data_url:
      'data:text/plain;base64,' +
      btoa(
        'Breathe in slowly for 4 seconds. Hold for 4. Breathe out for 6. Repeat 5 times. ' +
          'When you breathe like this, your body remembers it is safe.'
      ),
    mime: 'text/plain',
    uploaded_at: now(),
  },
];

const guides: AidGuide[] = [
  {
    guide_id: 'G-001',
    item_name: 'Water purification tablets',
    category: 'water',
    language: 'en',
    content_type: 'text',
    body:
      '1. Fill clean container with 1 liter of water.\n' +
      '2. Drop ONE tablet into the water.\n' +
      '3. Stir for 10 seconds, then leave for 30 minutes.\n' +
      '4. Water is now safe to drink. Do not exceed dose for children under 5.',
    uploaded_at: now(),
  },
  {
    guide_id: 'G-002',
    item_name: 'Emergency shelter tarp (4×6m)',
    category: 'shelter',
    language: 'en',
    content_type: 'text',
    body:
      'Required: 4 wooden poles (2.5m), rope, 4 ground stakes.\n' +
      '1. Stake out the rectangle (4m × 6m).\n' +
      '2. Erect 4 poles at corners.\n' +
      '3. Drape tarp over central ridge line.\n' +
      '4. Tie corners taut. Aim for 30° pitch to shed rain.',
    uploaded_at: now(),
  },
  {
    guide_id: 'G-003',
    item_name: 'Oral rehydration salts (ORS)',
    category: 'medical',
    language: 'en',
    content_type: 'text',
    body:
      '1. Dissolve ONE sachet in 1 liter of safe water.\n' +
      '2. Use within 24 hours.\n' +
      '3. Adults: 200–400 ml after each loose stool. Children: 100–200 ml.\n' +
      '4. Continue normal feeding. Seek medical help if vomiting persists.',
    uploaded_at: now(),
  },
];

export async function seedIfEmpty(): Promise<void> {
  if (await isSeeded()) return;
  await db.transaction(
    'rw',
    [
      db.families,
      db.distributions,
      db.providers,
      db.users,
      db.workers,
      db.kids,
      db.guides,
    ],
    async () => {
      await db.families.bulkAdd(families);
      await db.distributions.bulkAdd(distributions);
      await db.providers.bulkAdd(providers);
      await db.users.bulkAdd(users);
      await db.workers.bulkAdd(workers);
      await db.kids.bulkAdd(kids);
      await db.guides.bulkAdd(guides);
    }
  );
}

/**
 * One-time cleanup: removes the fake "SL-001"…"SL-010" provider entries
 * that earlier versions of the seed added to IndexedDB. Real provider
 * lookup now happens via OpenStreetMap on demand.
 *
 * Safe to call on every app launch — it's a no-op if there's nothing to remove.
 */
export async function cleanupLegacyDemoProviders(): Promise<void> {
  try {
    const legacy = await db.providers
      .where('id')
      .startsWith('SL-')
      .toArray();
    if (legacy.length > 0) {
      await db.providers.bulkDelete(legacy.map((p) => p.id));
      console.log(`[seedData] removed ${legacy.length} legacy demo provider(s)`);
    }
  } catch (e) {
    console.warn('[seedData] legacy cleanup failed', e);
  }
}

export async function reseed(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.families,
      db.distributions,
      db.providers,
      db.users,
      db.workers,
      db.kids,
      db.guides,
      db.messages,
    ],
    async () => {
      await Promise.all([
        db.families.clear(),
        db.distributions.clear(),
        db.providers.clear(),
        db.users.clear(),
        db.workers.clear(),
        db.kids.clear(),
        db.guides.clear(),
        // Clear orphaned Bitchat messages from previous seed versions too,
        // so a Reset Demo Data on an old install wipes them.
        db.messages.clear(),
      ]);
    }
  );
  await seedIfEmpty();
}
