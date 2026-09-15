/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// @ts-check

/**
 * ISO 3166-1 alpha-2 -> the country/region name Google Ads uses for its geo-targets.
 *
 * WHY THIS FILE EXISTS (LLMO / Semrush AIO incident, 2026-09-09)
 * ─────────────────────────────────────────────────────────────────────────
 * `location_name` on a Semrush AIO project is not decorative: Google AI Mode and
 * Google AI Overview resolve it against Google Ads geo-targets at collection time.
 * A name Google cannot resolve means those two providers silently collect NOTHING
 * — no error, just missing answers.
 *
 * This used to be derived from `Intl.DisplayNames(['en'], { type: 'region' })`,
 * i.e. CLDR — the dataset browsers and runtimes use to DISPLAY country names to
 * humans. CLDR and Google agree on 215 of 246 countries, which is why it looked
 * correct for months. They differ on 31, and for those Google rejects the value:
 *
 *   CLDR                      Google Ads
 *   'Trinidad & Tobago'    -> 'Trinidad and Tobago'
 *   'Hong Kong SAR China'  -> 'Hong Kong'
 *   'Turkiye'/'Türkiye'    -> 'Turkiye'
 *   'Palestinian Territories' -> 'Palestine'
 *   'St. Kitts & Nevis'    -> 'Saint Kitts and Nevis'
 *   'Bahamas'              -> 'The Bahamas'
 *
 * CLDR is a display dataset; Google's geo-targets is a matching registry. Only the
 * latter is authoritative for this field, so the names below come DIRECTLY from
 * Google's own published data and CLDR is no longer consulted.
 *
 * SOURCE / REGENERATION
 * ─────────────────────────────────────────────────────────────────────────
 * https://developers.google.com/google-ads/api/data/geotargets
 * Snapshot: geotargets-2026-08-12.csv.zip (top-level Active rows, Target Type
 * Country or Region, keyed by Country Code). Mirrors the same snapshot
 * mysticat-data-service ships at
 * scripts/customer_inventory/data/google_ads_geo_target_names.json.
 *
 * NOTHING AUTO-REFRESHES THIS FILE. Google does revise it — `Turkey` became
 * `Turkiye` — and a stale copy reintroduces exactly the bug above. Semrush is
 * adding create-time validation on `location_name`, which is the practical
 * backstop: once that ships, a stale name fails loudly at market creation
 * instead of silently at collection. Re-snapshot from the URL above if that
 * ever stops being true, or if a market create starts 4xx-ing on a valid country.
 *
 * COVERAGE
 * ─────────────────────────────────────────────────────────────────────────
 * Keyed over the same 249-code ISO 3166-1 set `resolveLocation` resolves through
 * (`iso-3166`'s `iso31661Alpha2ToNumeric`), so every code that previously got a
 * CLDR name still gets a name — no market loses one. 245 come from Google; the
 * 4 in {@link MARKETS_WITHOUT_GOOGLE_GEO_TARGET} keep their historical CLDR name
 * because Google publishes no entry for them at all (see that export).
 *
 * Google also publishes `XK` (Kosovo), which has no ISO 3166-1 numeric code and
 * so cannot be resolved by the `2000 + numeric` country formula. It is omitted
 * here deliberately: `resolveLocation('XK')` returned null before this change
 * and still does.
 */
export const GOOGLE_GEO_TARGET_NAMES = Object.freeze({
  AD: 'Andorra',
  AE: 'United Arab Emirates',
  AF: 'Afghanistan',
  AG: 'Antigua and Barbuda',
  AI: 'Anguilla',
  AL: 'Albania',
  AM: 'Armenia',
  AO: 'Angola',
  AQ: 'Antarctica',
  AR: 'Argentina',
  AS: 'American Samoa',
  AT: 'Austria',
  AU: 'Australia',
  AW: 'Aruba',
  AX: 'Åland Islands', // no Google geo-target; CLDR name retained
  AZ: 'Azerbaijan',
  BA: 'Bosnia and Herzegovina',
  BB: 'Barbados',
  BD: 'Bangladesh',
  BE: 'Belgium',
  BF: 'Burkina Faso',
  BG: 'Bulgaria',
  BH: 'Bahrain',
  BI: 'Burundi',
  BJ: 'Benin',
  BL: 'Saint Barthelemy',
  BM: 'Bermuda',
  BN: 'Brunei',
  BO: 'Bolivia',
  BQ: 'Caribbean Netherlands',
  BR: 'Brazil',
  BS: 'The Bahamas',
  BT: 'Bhutan',
  BV: 'Bouvet Island',
  BW: 'Botswana',
  BY: 'Belarus',
  BZ: 'Belize',
  CA: 'Canada',
  CC: 'Cocos (Keeling) Islands',
  CD: 'Democratic Republic of the Congo',
  CF: 'Central African Republic',
  CG: 'Republic of the Congo',
  CH: 'Switzerland',
  CI: 'Cote d\'Ivoire',
  CK: 'Cook Islands',
  CL: 'Chile',
  CM: 'Cameroon',
  CN: 'China',
  CO: 'Colombia',
  CR: 'Costa Rica',
  CU: 'Cuba', // no Google geo-target; CLDR name retained
  CV: 'Cabo Verde',
  CW: 'Curacao',
  CX: 'Christmas Island',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DE: 'Germany',
  DJ: 'Djibouti',
  DK: 'Denmark',
  DM: 'Dominica',
  DO: 'Dominican Republic',
  DZ: 'Algeria',
  EC: 'Ecuador',
  EE: 'Estonia',
  EG: 'Egypt',
  EH: 'Western Sahara',
  ER: 'Eritrea',
  ES: 'Spain',
  ET: 'Ethiopia',
  FI: 'Finland',
  FJ: 'Fiji',
  FK: 'Falkland Islands (Islas Malvinas)',
  FM: 'Micronesia',
  FO: 'Faroe Islands',
  FR: 'France',
  GA: 'Gabon',
  GB: 'United Kingdom',
  GD: 'Grenada',
  GE: 'Georgia',
  GF: 'French Guiana',
  GG: 'Guernsey',
  GH: 'Ghana',
  GI: 'Gibraltar',
  GL: 'Greenland',
  GM: 'The Gambia',
  GN: 'Guinea',
  GP: 'Guadeloupe',
  GQ: 'Equatorial Guinea',
  GR: 'Greece',
  GS: 'South Georgia and the South Sandwich Islands',
  GT: 'Guatemala',
  GU: 'Guam',
  GW: 'Guinea-Bissau',
  GY: 'Guyana',
  HK: 'Hong Kong',
  HM: 'Heard Island and McDonald Islands',
  HN: 'Honduras',
  HR: 'Croatia',
  HT: 'Haiti',
  HU: 'Hungary',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IM: 'Isle of Man',
  IN: 'India',
  IO: 'British Indian Ocean Territory',
  IQ: 'Iraq',
  IR: 'Iran', // no Google geo-target; CLDR name retained
  IS: 'Iceland',
  IT: 'Italy',
  JE: 'Jersey',
  JM: 'Jamaica',
  JO: 'Jordan',
  JP: 'Japan',
  KE: 'Kenya',
  KG: 'Kyrgyzstan',
  KH: 'Cambodia',
  KI: 'Kiribati',
  KM: 'Comoros',
  KN: 'Saint Kitts and Nevis',
  KP: 'North Korea', // no Google geo-target; CLDR name retained
  KR: 'South Korea',
  KW: 'Kuwait',
  KY: 'Cayman Islands',
  KZ: 'Kazakhstan',
  LA: 'Laos',
  LB: 'Lebanon',
  LC: 'Saint Lucia',
  LI: 'Liechtenstein',
  LK: 'Sri Lanka',
  LR: 'Liberia',
  LS: 'Lesotho',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  LV: 'Latvia',
  LY: 'Libya',
  MA: 'Morocco',
  MC: 'Monaco',
  MD: 'Moldova',
  ME: 'Montenegro',
  MF: 'Saint Martin',
  MG: 'Madagascar',
  MH: 'Marshall Islands',
  MK: 'North Macedonia',
  ML: 'Mali',
  MM: 'Myanmar (Burma)',
  MN: 'Mongolia',
  MO: 'Macao',
  MP: 'Northern Mariana Islands',
  MQ: 'Martinique',
  MR: 'Mauritania',
  MS: 'Montserrat',
  MT: 'Malta',
  MU: 'Mauritius',
  MV: 'Maldives',
  MW: 'Malawi',
  MX: 'Mexico',
  MY: 'Malaysia',
  MZ: 'Mozambique',
  NA: 'Namibia',
  NC: 'New Caledonia',
  NE: 'Niger',
  NF: 'Norfolk Island',
  NG: 'Nigeria',
  NI: 'Nicaragua',
  NL: 'Netherlands',
  NO: 'Norway',
  NP: 'Nepal',
  NR: 'Nauru',
  NU: 'Niue',
  NZ: 'New Zealand',
  OM: 'Oman',
  PA: 'Panama',
  PE: 'Peru',
  PF: 'French Polynesia',
  PG: 'Papua New Guinea',
  PH: 'Philippines',
  PK: 'Pakistan',
  PL: 'Poland',
  PM: 'Saint Pierre and Miquelon',
  PN: 'Pitcairn Islands',
  PR: 'Puerto Rico',
  PS: 'Palestine',
  PT: 'Portugal',
  PW: 'Palau',
  PY: 'Paraguay',
  QA: 'Qatar',
  RE: 'Reunion',
  RO: 'Romania',
  RS: 'Serbia',
  RU: 'Russia',
  RW: 'Rwanda',
  SA: 'Saudi Arabia',
  SB: 'Solomon Islands',
  SC: 'Seychelles',
  SD: 'Sudan',
  SE: 'Sweden',
  SG: 'Singapore',
  SH: 'Saint Helena, Ascension and Tristan da Cunha',
  SI: 'Slovenia',
  SJ: 'Svalbard and Jan Mayen',
  SK: 'Slovakia',
  SL: 'Sierra Leone',
  SM: 'San Marino',
  SN: 'Senegal',
  SO: 'Somalia',
  SR: 'Suriname',
  SS: 'South Sudan',
  ST: 'Sao Tome and Principe',
  SV: 'El Salvador',
  SX: 'Sint Maarten',
  SY: 'Syria',
  SZ: 'Eswatini',
  TC: 'Turks and Caicos Islands',
  TD: 'Chad',
  TF: 'French Southern and Antarctic Lands',
  TG: 'Togo',
  TH: 'Thailand',
  TJ: 'Tajikistan',
  TK: 'Tokelau',
  TL: 'Timor-Leste',
  TM: 'Turkmenistan',
  TN: 'Tunisia',
  TO: 'Tonga',
  TR: 'Turkiye',
  TT: 'Trinidad and Tobago',
  TV: 'Tuvalu',
  TW: 'Taiwan',
  TZ: 'Tanzania',
  UA: 'Ukraine',
  UG: 'Uganda',
  UM: 'United States Minor Outlying Islands',
  US: 'United States',
  UY: 'Uruguay',
  UZ: 'Uzbekistan',
  VA: 'Vatican City',
  VC: 'Saint Vincent and the Grenadines',
  VE: 'Venezuela',
  VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands',
  VN: 'Vietnam',
  VU: 'Vanuatu',
  WF: 'Wallis and Futuna',
  WS: 'Samoa',
  YE: 'Yemen',
  YT: 'Mayotte',
  ZA: 'South Africa',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
});

/**
 * The ISO codes with NO Google Ads geo-target under any name — not a spelling
 * difference, no Criteria ID exists at all. Cuba / Iran / North Korea are
 * consistent with Google Ads sanctions restrictions; Åland Islands simply is not
 * broken out as its own target.
 *
 * A market in one of these can never pass Google Ads geo-target validation, so
 * Google AI Mode and Google AI Overview can never collect for it — no rename
 * fixes that. It is NOT a reason to reject the market: every other provider
 * (Perplexity, Gemini, ChatGPT, Copilot, …) collects there normally, and
 * re-pointing the market at a different country would mean labelling another
 * country's answers as this one's.
 *
 * Informational for now — nothing enforces it. Surfacing it at market-creation
 * time (or not auto-attaching the two Google providers for these markets) is a
 * product decision, not an engineering one.
 */
export const MARKETS_WITHOUT_GOOGLE_GEO_TARGET = Object.freeze(['AX', 'CU', 'IR', 'KP']);
