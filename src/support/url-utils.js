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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Derives the bare hostname from a URL or host string, tolerating a missing
 * scheme (bare hostnames). Returns null for empty/unparseable input.
 *
 * Single source of truth for brand → Semrush project domain derivation. Both
 * the direct brand-create path (`brandDomainFromPayload` in the brands
 * controller) and the deferred-activation path (the serenity activate flow)
 * call it, so a draft brand resolves to the same domain at activation as it
 * would at create — keeping the two paths from diverging (e.g. one gaining
 * `www.` stripping or punycode normalization without the other).
 *
 * @param {string} value - a URL or bare hostname
 * @returns {string|null} the hostname, or null when absent/unparseable
 */
export function hostnameFromUrlString(value) {
  if (!hasText(value)) {
    return null;
  }
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}
