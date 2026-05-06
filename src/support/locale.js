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

import { detectLocale, hasText } from '@adobe/spacecat-shared-utils';

/**
 * Best-effort locale population for a freshly-created Site.
 *
 * Calls `detectLocale` (live HTTP fetch + indicator analysis) and sets
 * language and/or region on the site only when both:
 *   1. the field is currently empty, AND
 *   2. detection returned a non-empty value.
 *
 * If anything is set, the change is persisted via `site.save()`. On any
 * failure (network error, invalid baseURL, unreachable site, save failure)
 * the error is logged and swallowed — locale enrichment is best-effort and
 * must not fail the surrounding site-creation flow.
 *
 * Why no `'US' / 'en'` fallback like some legacy onboarding paths use:
 * defaulting to a hard-coded country/language makes the data appear
 * classified when in reality detection failed, masking the gap and
 * producing misleading regional metrics. Empty is honest; a downstream
 * backfill or manual PATCH can fill genuinely-unknown values later.
 *
 * Idempotent: returns immediately if both language and region are already
 * set, or if the site object does not expose locale getters/setters.
 *
 * @param {object} site - Site model instance with getters/setters for language/region
 * @param {string} baseUrl - Site base URL to probe for locale indicators
 * @param {{ debug?: Function, warn?: Function }} [log] - Logger; only `debug` is read
 * @returns {Promise<boolean>} `true` if the site was modified and saved, otherwise `false`
 */
export async function ensureSiteLocale(site, baseUrl, log) {
  if (!site
    || typeof site.getLanguage !== 'function'
    || typeof site.getRegion !== 'function'
    || typeof site.setLanguage !== 'function'
    || typeof site.setRegion !== 'function') {
    return false;
  }

  if (hasText(site.getLanguage()) && hasText(site.getRegion())) {
    return false;
  }

  if (!hasText(baseUrl)) {
    return false;
  }

  let locale;
  try {
    locale = await detectLocale({ baseUrl });
  } catch (error) {
    log?.debug?.(`Locale detection skipped for ${baseUrl}: ${error.message}`);
    return false;
  }

  let changed = false;
  if (!hasText(site.getLanguage()) && hasText(locale?.language)) {
    site.setLanguage(locale.language);
    changed = true;
  }
  if (!hasText(site.getRegion()) && hasText(locale?.region)) {
    site.setRegion(locale.region);
    changed = true;
  }

  if (!changed) {
    return false;
  }

  try {
    await site.save();
    return true;
  } catch (error) {
    log?.warn?.(`Failed to persist detected locale for ${baseUrl}: ${error.message}`);
    return false;
  }
}
