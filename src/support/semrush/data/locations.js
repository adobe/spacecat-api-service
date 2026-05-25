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

// Inlined as a JS module rather than a sibling JSON file so the helix-deploy
// bundler picks it up via normal import resolution. A previous incarnation of
// this code read `data/locations.json` with `readFileSync(import.meta.url)`
// at module load, which silently dropped the JSON from the Lambda artifact
// (it wasn't listed in `hlx.static`) and broke every cold start in prod.
// See SITES-45260 for the post-mortem.

// ISO-3166-1 alpha-2 country code -> Semrush location_id (= Google Ads
// Geo Target ID) + human-readable name.
export const LOCATIONS = {
  AE: { locationId: 2784, locationName: 'United Arab Emirates' },
  AR: { locationId: 2032, locationName: 'Argentina' },
  AT: { locationId: 2040, locationName: 'Austria' },
  AU: { locationId: 2036, locationName: 'Australia' },
  BE: { locationId: 2056, locationName: 'Belgium' },
  BG: { locationId: 2100, locationName: 'Bulgaria' },
  BR: { locationId: 2076, locationName: 'Brazil' },
  CA: { locationId: 2124, locationName: 'Canada' },
  CH: { locationId: 2756, locationName: 'Switzerland' },
  CL: { locationId: 2152, locationName: 'Chile' },
  CN: { locationId: 2156, locationName: 'China' },
  CO: { locationId: 2170, locationName: 'Colombia' },
  CY: { locationId: 2196, locationName: 'Cyprus' },
  CZ: { locationId: 2203, locationName: 'Czechia' },
  DE: { locationId: 2276, locationName: 'Germany' },
  DK: { locationId: 2208, locationName: 'Denmark' },
  DZ: { locationId: 2012, locationName: 'Algeria' },
  EC: { locationId: 2218, locationName: 'Ecuador' },
  EE: { locationId: 2233, locationName: 'Estonia' },
  EG: { locationId: 2818, locationName: 'Egypt' },
  ES: { locationId: 2724, locationName: 'Spain' },
  FI: { locationId: 2246, locationName: 'Finland' },
  FR: { locationId: 2250, locationName: 'France' },
  GB: { locationId: 2826, locationName: 'United Kingdom' },
  GH: { locationId: 2288, locationName: 'Ghana' },
  GR: { locationId: 2300, locationName: 'Greece' },
  HK: { locationId: 2344, locationName: 'Hong Kong' },
  HR: { locationId: 2191, locationName: 'Croatia' },
  HU: { locationId: 2348, locationName: 'Hungary' },
  ID: { locationId: 2360, locationName: 'Indonesia' },
  IE: { locationId: 2372, locationName: 'Ireland' },
  IL: { locationId: 2376, locationName: 'Israel' },
  IN: { locationId: 2356, locationName: 'India' },
  IS: { locationId: 2352, locationName: 'Iceland' },
  IT: { locationId: 2380, locationName: 'Italy' },
  JP: { locationId: 2392, locationName: 'Japan' },
  KE: { locationId: 2404, locationName: 'Kenya' },
  KR: { locationId: 2410, locationName: 'South Korea' },
  KZ: { locationId: 2398, locationName: 'Kazakhstan' },
  LT: { locationId: 2440, locationName: 'Lithuania' },
  LU: { locationId: 2442, locationName: 'Luxembourg' },
  LV: { locationId: 2428, locationName: 'Latvia' },
  MA: { locationId: 2504, locationName: 'Morocco' },
  MT: { locationId: 2470, locationName: 'Malta' },
  MX: { locationId: 2484, locationName: 'Mexico' },
  MY: { locationId: 2458, locationName: 'Malaysia' },
  NG: { locationId: 2566, locationName: 'Nigeria' },
  NL: { locationId: 2528, locationName: 'Netherlands' },
  NO: { locationId: 2578, locationName: 'Norway' },
  NZ: { locationId: 2554, locationName: 'New Zealand' },
  PE: { locationId: 2604, locationName: 'Peru' },
  PH: { locationId: 2608, locationName: 'Philippines' },
  PK: { locationId: 2586, locationName: 'Pakistan' },
  PL: { locationId: 2616, locationName: 'Poland' },
  PT: { locationId: 2620, locationName: 'Portugal' },
  RO: { locationId: 2642, locationName: 'Romania' },
  RS: { locationId: 2688, locationName: 'Serbia' },
  RU: { locationId: 2643, locationName: 'Russia' },
  SA: { locationId: 2682, locationName: 'Saudi Arabia' },
  SE: { locationId: 2752, locationName: 'Sweden' },
  SG: { locationId: 2702, locationName: 'Singapore' },
  SI: { locationId: 2705, locationName: 'Slovenia' },
  SK: { locationId: 2703, locationName: 'Slovakia' },
  TH: { locationId: 2764, locationName: 'Thailand' },
  TN: { locationId: 2788, locationName: 'Tunisia' },
  TR: { locationId: 2792, locationName: 'Türkiye' },
  TW: { locationId: 2158, locationName: 'Taiwan' },
  UA: { locationId: 2804, locationName: 'Ukraine' },
  US: { locationId: 2840, locationName: 'United States' },
  VN: { locationId: 2704, locationName: 'Vietnam' },
  ZA: { locationId: 2710, locationName: 'South Africa' },
};
