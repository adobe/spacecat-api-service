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

// CDN families that produce a single daily aggregate (hour 23 only).
// All others produce 24 hourly aggregates (hours 00–23).
export const DAILY_ONLY_CDN_FAMILIES = new Set(['cloudflare', 'imperva', 'other']);

export const SERVICE_PROVIDER_TO_CDN_FAMILY = {
  'aem-cs-fastly': 'fastly',
  'commerce-fastly': 'fastly',
  'byocdn-fastly': 'fastly',
  'byocdn-akamai': 'akamai',
  'byocdn-cloudflare': 'cloudflare',
  'byocdn-cloudfront': 'cloudfront',
  'byocdn-frontdoor': 'frontdoor',
  'byocdn-imperva': 'imperva',
  'byocdn-other': 'other',
  'ams-cloudfront': 'cloudfront',
  'ams-frontdoor': 'frontdoor',
};

export function normalizeProvider(raw) {
  return raw ? String(raw).trim().toLowerCase() : 'unknown';
}

export function getCdnFamily(cdnProvider) {
  const normalized = normalizeProvider(cdnProvider);
  if (SERVICE_PROVIDER_TO_CDN_FAMILY[normalized]) {
    return SERVICE_PROVIDER_TO_CDN_FAMILY[normalized];
  }
  if (normalized.includes('cloudflare')) {
    return 'cloudflare';
  }
  if (normalized.includes('imperva') || normalized.includes('incapsula')) {
    return 'imperva';
  }
  if (normalized.includes('fastly')) {
    return 'fastly';
  }
  if (normalized.includes('akamai')) {
    return 'akamai';
  }
  if (normalized.includes('cloudfront')) {
    return 'cloudfront';
  }
  if (normalized.includes('frontdoor')) {
    return 'frontdoor';
  }
  return normalized;
}
