// Static country availability snapshot for Starlink residential service.
// Curated from publicly available country pages on starlink.com as of May 2026.
// This snapshot date is recorded in `LAST_UPDATED` so the UI can warn users
// the data may be stale and link them to the official map for live status.
//
// NOTE: This is informational only. The single source of truth is the
// official Starlink Availability Map at https://starlink.com/map — every
// country card in the UI links there.

export type CoverageStatus = 'available' | 'soon' | 'waitlist' | 'unavailable';

export const LAST_UPDATED = '2026-05';
export const OFFICIAL_MAP_URL = 'https://starlink.com/map';

export interface CountryEntry {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  status: CoverageStatus;
  region: 'Africa' | 'Americas' | 'Asia' | 'Europe' | 'Oceania' | 'MENA';
  notes?: string;
}

/**
 * Returns a deep-link to the official Starlink map. Starlink.com/map opens
 * a global view; from there the user can search the address. We keep this
 * function so we have one place to update if a query-param convention
 * appears later.
 */
export function officialMapUrl(_country?: string): string {
  return OFFICIAL_MAP_URL;
}

// Conservatively curated. When in doubt, marked as 'unavailable' so the UI
// nudges the user to the official map rather than implying coverage that
// doesn't exist.
export const COUNTRIES: CountryEntry[] = [
  // Americas — Starlink's broadest footprint
  { code: 'US', name: 'United States', status: 'available', region: 'Americas' },
  { code: 'CA', name: 'Canada', status: 'available', region: 'Americas' },
  { code: 'MX', name: 'Mexico', status: 'available', region: 'Americas' },
  { code: 'BR', name: 'Brazil', status: 'available', region: 'Americas' },
  { code: 'CL', name: 'Chile', status: 'available', region: 'Americas' },
  { code: 'AR', name: 'Argentina', status: 'available', region: 'Americas' },
  { code: 'PE', name: 'Peru', status: 'available', region: 'Americas' },
  { code: 'CO', name: 'Colombia', status: 'available', region: 'Americas' },
  { code: 'EC', name: 'Ecuador', status: 'available', region: 'Americas' },
  { code: 'PY', name: 'Paraguay', status: 'available', region: 'Americas' },
  { code: 'UY', name: 'Uruguay', status: 'available', region: 'Americas' },
  { code: 'BO', name: 'Bolivia', status: 'available', region: 'Americas' },
  { code: 'GT', name: 'Guatemala', status: 'available', region: 'Americas' },
  { code: 'HN', name: 'Honduras', status: 'available', region: 'Americas' },
  { code: 'SV', name: 'El Salvador', status: 'available', region: 'Americas' },
  { code: 'NI', name: 'Nicaragua', status: 'available', region: 'Americas' },
  { code: 'CR', name: 'Costa Rica', status: 'available', region: 'Americas' },
  { code: 'PA', name: 'Panama', status: 'available', region: 'Americas' },
  { code: 'DO', name: 'Dominican Republic', status: 'available', region: 'Americas' },
  { code: 'JM', name: 'Jamaica', status: 'available', region: 'Americas' },
  { code: 'HT', name: 'Haiti', status: 'available', region: 'Americas', notes: 'Critical humanitarian use' },
  { code: 'TT', name: 'Trinidad and Tobago', status: 'available', region: 'Americas' },

  // Europe
  { code: 'GB', name: 'United Kingdom', status: 'available', region: 'Europe' },
  { code: 'IE', name: 'Ireland', status: 'available', region: 'Europe' },
  { code: 'FR', name: 'France', status: 'available', region: 'Europe' },
  { code: 'DE', name: 'Germany', status: 'available', region: 'Europe' },
  { code: 'IT', name: 'Italy', status: 'available', region: 'Europe' },
  { code: 'ES', name: 'Spain', status: 'available', region: 'Europe' },
  { code: 'PT', name: 'Portugal', status: 'available', region: 'Europe' },
  { code: 'NL', name: 'Netherlands', status: 'available', region: 'Europe' },
  { code: 'BE', name: 'Belgium', status: 'available', region: 'Europe' },
  { code: 'CH', name: 'Switzerland', status: 'available', region: 'Europe' },
  { code: 'AT', name: 'Austria', status: 'available', region: 'Europe' },
  { code: 'PL', name: 'Poland', status: 'available', region: 'Europe' },
  { code: 'CZ', name: 'Czech Republic', status: 'available', region: 'Europe' },
  { code: 'SK', name: 'Slovakia', status: 'available', region: 'Europe' },
  { code: 'HU', name: 'Hungary', status: 'available', region: 'Europe' },
  { code: 'RO', name: 'Romania', status: 'available', region: 'Europe' },
  { code: 'BG', name: 'Bulgaria', status: 'available', region: 'Europe' },
  { code: 'GR', name: 'Greece', status: 'available', region: 'Europe' },
  { code: 'HR', name: 'Croatia', status: 'available', region: 'Europe' },
  { code: 'SI', name: 'Slovenia', status: 'available', region: 'Europe' },
  { code: 'SE', name: 'Sweden', status: 'available', region: 'Europe' },
  { code: 'NO', name: 'Norway', status: 'available', region: 'Europe' },
  { code: 'DK', name: 'Denmark', status: 'available', region: 'Europe' },
  { code: 'FI', name: 'Finland', status: 'available', region: 'Europe' },
  { code: 'IS', name: 'Iceland', status: 'available', region: 'Europe' },
  { code: 'EE', name: 'Estonia', status: 'available', region: 'Europe' },
  { code: 'LV', name: 'Latvia', status: 'available', region: 'Europe' },
  { code: 'LT', name: 'Lithuania', status: 'available', region: 'Europe' },
  { code: 'UA', name: 'Ukraine', status: 'available', region: 'Europe', notes: 'Active war zone — humanitarian priority' },
  { code: 'AL', name: 'Albania', status: 'available', region: 'Europe' },
  { code: 'MD', name: 'Moldova', status: 'available', region: 'Europe' },
  { code: 'CY', name: 'Cyprus', status: 'available', region: 'Europe' },
  { code: 'MT', name: 'Malta', status: 'available', region: 'Europe' },

  // MENA
  { code: 'JO', name: 'Jordan', status: 'available', region: 'MENA' },
  { code: 'SA', name: 'Saudi Arabia', status: 'available', region: 'MENA' },
  { code: 'YE', name: 'Yemen', status: 'available', region: 'MENA', notes: 'Active humanitarian crisis' },
  { code: 'QA', name: 'Qatar', status: 'available', region: 'MENA' },
  { code: 'OM', name: 'Oman', status: 'available', region: 'MENA' },
  { code: 'AE', name: 'United Arab Emirates', status: 'soon', region: 'MENA' },
  { code: 'BH', name: 'Bahrain', status: 'soon', region: 'MENA' },
  { code: 'KW', name: 'Kuwait', status: 'soon', region: 'MENA' },
  { code: 'IQ', name: 'Iraq', status: 'soon', region: 'MENA' },
  { code: 'LB', name: 'Lebanon', status: 'waitlist', region: 'MENA' },
  { code: 'TN', name: 'Tunisia', status: 'soon', region: 'MENA' },
  { code: 'MA', name: 'Morocco', status: 'soon', region: 'MENA' },
  { code: 'EG', name: 'Egypt', status: 'soon', region: 'MENA' },
  { code: 'IL', name: 'Israel', status: 'available', region: 'MENA' },
  { code: 'PS', name: 'Palestinian Territories', status: 'unavailable', region: 'MENA' },
  { code: 'SY', name: 'Syria', status: 'unavailable', region: 'MENA', notes: 'Sanctioned' },
  { code: 'IR', name: 'Iran', status: 'unavailable', region: 'MENA', notes: 'Sanctioned' },
  { code: 'LY', name: 'Libya', status: 'unavailable', region: 'MENA' },

  // Africa
  { code: 'NG', name: 'Nigeria', status: 'available', region: 'Africa' },
  { code: 'KE', name: 'Kenya', status: 'available', region: 'Africa' },
  { code: 'RW', name: 'Rwanda', status: 'available', region: 'Africa' },
  { code: 'MZ', name: 'Mozambique', status: 'available', region: 'Africa' },
  { code: 'ZM', name: 'Zambia', status: 'available', region: 'Africa' },
  { code: 'ZW', name: 'Zimbabwe', status: 'available', region: 'Africa' },
  { code: 'MG', name: 'Madagascar', status: 'available', region: 'Africa' },
  { code: 'MW', name: 'Malawi', status: 'available', region: 'Africa' },
  { code: 'BW', name: 'Botswana', status: 'available', region: 'Africa' },
  { code: 'SL', name: 'Sierra Leone', status: 'available', region: 'Africa' },
  { code: 'SZ', name: 'Eswatini', status: 'available', region: 'Africa' },
  { code: 'LR', name: 'Liberia', status: 'available', region: 'Africa' },
  { code: 'GH', name: 'Ghana', status: 'available', region: 'Africa' },
  { code: 'BJ', name: 'Benin', status: 'available', region: 'Africa' },
  { code: 'BI', name: 'Burundi', status: 'available', region: 'Africa' },
  { code: 'CV', name: 'Cape Verde', status: 'available', region: 'Africa' },
  { code: 'GW', name: 'Guinea-Bissau', status: 'available', region: 'Africa' },
  { code: 'NE', name: 'Niger', status: 'available', region: 'Africa' },
  { code: 'ZA', name: 'South Africa', status: 'soon', region: 'Africa', notes: 'Regulatory pending' },
  { code: 'TZ', name: 'Tanzania', status: 'soon', region: 'Africa' },
  { code: 'UG', name: 'Uganda', status: 'soon', region: 'Africa' },
  { code: 'CD', name: 'DR Congo', status: 'soon', region: 'Africa', notes: 'Humanitarian use ongoing' },
  { code: 'ET', name: 'Ethiopia', status: 'waitlist', region: 'Africa' },
  { code: 'AO', name: 'Angola', status: 'waitlist', region: 'Africa' },
  { code: 'CM', name: 'Cameroon', status: 'waitlist', region: 'Africa' },
  { code: 'CI', name: "Côte d'Ivoire", status: 'waitlist', region: 'Africa' },
  { code: 'SN', name: 'Senegal', status: 'waitlist', region: 'Africa' },
  { code: 'TD', name: 'Chad', status: 'waitlist', region: 'Africa' },
  { code: 'SO', name: 'Somalia', status: 'waitlist', region: 'Africa' },
  { code: 'SS', name: 'South Sudan', status: 'waitlist', region: 'Africa' },
  { code: 'SD', name: 'Sudan', status: 'unavailable', region: 'Africa', notes: 'Active conflict' },
  { code: 'ER', name: 'Eritrea', status: 'unavailable', region: 'Africa' },

  // Asia / Oceania
  { code: 'JP', name: 'Japan', status: 'available', region: 'Asia' },
  { code: 'PH', name: 'Philippines', status: 'available', region: 'Asia' },
  { code: 'MY', name: 'Malaysia', status: 'available', region: 'Asia' },
  { code: 'ID', name: 'Indonesia', status: 'available', region: 'Asia' },
  { code: 'MN', name: 'Mongolia', status: 'available', region: 'Asia' },
  { code: 'TW', name: 'Taiwan', status: 'available', region: 'Asia' },
  { code: 'LK', name: 'Sri Lanka', status: 'available', region: 'Asia' },
  { code: 'MV', name: 'Maldives', status: 'available', region: 'Asia' },
  { code: 'BT', name: 'Bhutan', status: 'available', region: 'Asia' },
  { code: 'KH', name: 'Cambodia', status: 'available', region: 'Asia' },
  { code: 'TH', name: 'Thailand', status: 'soon', region: 'Asia' },
  { code: 'VN', name: 'Vietnam', status: 'soon', region: 'Asia' },
  { code: 'IN', name: 'India', status: 'soon', region: 'Asia', notes: 'Pilots ongoing' },
  { code: 'BD', name: 'Bangladesh', status: 'soon', region: 'Asia' },
  { code: 'NP', name: 'Nepal', status: 'soon', region: 'Asia' },
  { code: 'PK', name: 'Pakistan', status: 'waitlist', region: 'Asia' },
  { code: 'KZ', name: 'Kazakhstan', status: 'waitlist', region: 'Asia' },
  { code: 'KR', name: 'South Korea', status: 'soon', region: 'Asia' },
  { code: 'SG', name: 'Singapore', status: 'soon', region: 'Asia' },
  { code: 'AF', name: 'Afghanistan', status: 'unavailable', region: 'Asia' },
  { code: 'MM', name: 'Myanmar', status: 'unavailable', region: 'Asia', notes: 'Sanctioned' },
  { code: 'KP', name: 'North Korea', status: 'unavailable', region: 'Asia', notes: 'Sanctioned' },
  { code: 'CN', name: 'China', status: 'unavailable', region: 'Asia', notes: 'Regulatory ban' },
  { code: 'RU', name: 'Russia', status: 'unavailable', region: 'Asia', notes: 'Sanctioned' },
  { code: 'BY', name: 'Belarus', status: 'unavailable', region: 'Europe', notes: 'Sanctioned' },

  // Oceania
  { code: 'AU', name: 'Australia', status: 'available', region: 'Oceania' },
  { code: 'NZ', name: 'New Zealand', status: 'available', region: 'Oceania' },
  { code: 'FJ', name: 'Fiji', status: 'available', region: 'Oceania' },
  { code: 'WS', name: 'Samoa', status: 'available', region: 'Oceania' },
  { code: 'TO', name: 'Tonga', status: 'available', region: 'Oceania' },
  { code: 'VU', name: 'Vanuatu', status: 'available', region: 'Oceania' },
  { code: 'PG', name: 'Papua New Guinea', status: 'available', region: 'Oceania' },
  { code: 'SB', name: 'Solomon Islands', status: 'available', region: 'Oceania' },
];

export const STATUS_LABEL: Record<CoverageStatus, string> = {
  available: 'Available',
  soon: 'Coming soon',
  waitlist: 'Waitlist',
  unavailable: 'Not available',
};

export const STATUS_COLOR: Record<CoverageStatus, string> = {
  available: '#22c55e', // green
  soon: '#00ADB5',      // brand teal — visible in both light and dark modes
  waitlist: '#eab308',  // yellow
  unavailable: '#64748b', // slate
};
