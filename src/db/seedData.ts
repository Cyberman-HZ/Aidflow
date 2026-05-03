// Realistic demo data so the hackathon judges see a working product on first load.
// Names and locations are illustrative — they don't reference real individuals.

import { db, isSeeded } from './database';
import type {
  Family,
  AidDistribution,
  StarlinkProvider,
  User,
  KidsContent,
  AidGuide,
  BitchatMessage,
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
  {
    distribution_id: 'D-0001',
    family_id: 'F-0042',
    session_id: 'S-2026-04-15',
    items_distributed: [
      { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
      { item_name: 'Drinking water (20L)', quantity: 4, category: 'water' },
    ],
    distributed_by: 'U-fieldworker-1',
    distributed_at: daysAgo(18),
    ai_priority_score: 91,
    ai_reasoning: '3 children under 5, pregnant mother, recently displaced.',
    post_update_notes: 'Family received in good order. Mother reported child has fever.',
    new_needs_flagged: true,
  },
  {
    distribution_id: 'D-0002',
    family_id: 'F-0089',
    session_id: 'S-2026-04-22',
    items_distributed: [
      { item_name: 'Diabetic-safe rations', quantity: 1, category: 'food' },
      { item_name: 'Insulin pen', quantity: 2, category: 'medical' },
    ],
    distributed_by: 'U-fieldworker-2',
    distributed_at: daysAgo(9),
    ai_priority_score: 67,
    ai_reasoning: '2 elderly, critical diabetes case, 9 days without aid.',
    post_update_notes: 'Insulin delivered. Glucose meter requested next cycle.',
    new_needs_flagged: false,
  },
];

const providers: StarlinkProvider[] = [
  { id: 'SL-001', name: 'Starlink Damascus Hub', country: 'Syria', region: 'Damascus', type: 'official', lat: 33.513, lng: 36.292, phone: '+963-11-555-0100', hours: '08:00–18:00', signal: 'strong' },
  { id: 'SL-002', name: 'TechReach Reseller', country: 'Syria', region: 'Aleppo', type: 'reseller', lat: 36.202, lng: 37.134, phone: '+963-21-555-0202', hours: '09:00–17:00', signal: 'moderate' },
  { id: 'SL-003', name: 'Beirut Connectivity Center', country: 'Lebanon', region: 'Beirut', type: 'installer', lat: 33.888, lng: 35.495, phone: '+961-1-555-0303', hours: '08:30–17:30', signal: 'strong' },
  { id: 'SL-004', name: 'Amman Satellite Solutions', country: 'Jordan', region: 'Amman', type: 'reseller', lat: 31.945, lng: 35.928, phone: '+962-6-555-0404', hours: '09:00–18:00', signal: 'strong' },
  { id: 'SL-005', name: 'Erbil Field Provider', country: 'Iraq', region: 'Erbil', type: 'service_point', lat: 36.191, lng: 44.009, phone: '+964-66-555-0505', hours: '07:00–19:00', signal: 'moderate' },
  { id: 'SL-006', name: 'Khartoum Mobile Service', country: 'Sudan', region: 'Khartoum', type: 'installer', lat: 15.501, lng: 32.560, phone: '+249-1-555-0606', hours: '08:00–16:00', signal: 'weak' },
  { id: 'SL-007', name: 'Goma Aid Hub', country: 'DRC', region: 'North Kivu', type: 'service_point', lat: -1.679, lng: 29.222, phone: '+243-99-555-0707', hours: '08:00–17:00', signal: 'moderate' },
  { id: 'SL-008', name: 'Port-au-Prince Connect', country: 'Haiti', region: 'Ouest', type: 'reseller', lat: 18.594, lng: -72.307, phone: '+509-555-0808', hours: '09:00–17:00', signal: 'strong' },
  { id: 'SL-009', name: 'Kabul Tech Outpost', country: 'Afghanistan', region: 'Kabul', type: 'installer', lat: 34.555, lng: 69.207, phone: '+93-20-555-0909', hours: '08:00–16:00', signal: 'weak' },
  { id: 'SL-010', name: "Sana'a Resilience Co-op", country: 'Yemen', region: "Sana'a", type: 'service_point', lat: 15.369, lng: 44.191, phone: '+967-1-555-1010', hours: '08:00–14:00', signal: 'weak' },
];

const users: User[] = [
  { user_id: 'U-admin-1', name: 'Sarah Chen', role: 'admin', pin: '1234', language: 'en' },
  { user_id: 'U-supervisor-1', name: 'Karim Al-Maliki', role: 'supervisor', pin: '2345', language: 'ar' },
  { user_id: 'U-fieldworker-1', name: 'Pierre Lefevre', role: 'field_worker', pin: '3456', language: 'fr' },
  { user_id: 'U-fieldworker-2', name: 'Carmen Diaz', role: 'field_worker', pin: '4567', language: 'es' },
  { user_id: 'U-data-1', name: 'Amir Patel', role: 'data_manager', pin: '5678', language: 'en' },
];

const kids: KidsContent[] = [
  {
    content_id: 'K-001',
    title: 'Brave Little Lion (story)',
    age_group: '0-5',
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
    content_id: 'K-002',
    title: 'Coloring Page — Rainbow',
    age_group: '6-10',
    language: 'en',
    type: 'image',
    data_url:
      'data:image/svg+xml;base64,' +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><path d="M10 110 A90 90 0 0 1 190 110" stroke="red" stroke-width="8" fill="none"/><path d="M20 110 A80 80 0 0 1 180 110" stroke="orange" stroke-width="8" fill="none"/><path d="M30 110 A70 70 0 0 1 170 110" stroke="yellow" stroke-width="8" fill="none"/><path d="M40 110 A60 60 0 0 1 160 110" stroke="green" stroke-width="8" fill="none"/><path d="M50 110 A50 50 0 0 1 150 110" stroke="blue" stroke-width="8" fill="none"/></svg>'
      ),
    mime: 'image/svg+xml',
    uploaded_at: now(),
  },
  {
    content_id: 'K-003',
    title: 'Breathing Exercise (calm)',
    age_group: '11-15',
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

const messages: BitchatMessage[] = [
  { msg_id: 'M-001', channel: '#sector-b-north', author: 'Pierre Lefevre', body: 'Distribution complete at site 4. 12 families served.', sent_at: daysAgo(0), delivered_via: 'bluetooth' },
  { msg_id: 'M-002', channel: '#sector-b-north', author: 'Sarah Chen', body: 'Acknowledged. Move to site 5 next.', sent_at: daysAgo(0), delivered_via: 'bluetooth' },
  { msg_id: 'M-003', channel: '#medical-team', author: 'Carmen Diaz', body: 'Suspected cholera at F-0201. Need rehydration kits.', sent_at: daysAgo(0), delivered_via: 'queued' },
];

export async function seedIfEmpty(): Promise<void> {
  if (await isSeeded()) return;
  await db.transaction(
    'rw',
    db.families,
    db.distributions,
    db.providers,
    db.users,
    db.kids,
    db.guides,
    db.messages,
    async () => {
      await db.families.bulkAdd(families);
      await db.distributions.bulkAdd(distributions);
      await db.providers.bulkAdd(providers);
      await db.users.bulkAdd(users);
      await db.kids.bulkAdd(kids);
      await db.guides.bulkAdd(guides);
      await db.messages.bulkAdd(messages);
    }
  );
}

export async function reseed(): Promise<void> {
  await db.transaction(
    'rw',
    db.families,
    db.distributions,
    db.providers,
    db.users,
    db.kids,
    db.guides,
    db.messages,
    async () => {
      await Promise.all([
        db.families.clear(),
        db.distributions.clear(),
        db.providers.clear(),
        db.users.clear(),
        db.kids.clear(),
        db.guides.clear(),
        db.messages.clear(),
      ]);
    }
  );
  await seedIfEmpty();
}
