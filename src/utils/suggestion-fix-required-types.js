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

/**
 * Opportunity types whose suggestions must never be transitioned to FIXED via the
 * plain suggestion-status PATCH endpoints (`PATCH .../suggestions/:suggestionId` or
 * `PATCH .../suggestions/status`). For these types a FixEntity is expected to exist
 * before a suggestion is FIXED, so the transition must go through
 * `POST .../opportunities/:opportunityId/fixes` (with `markSuggestionsFixed: true`)
 * instead, which creates the FixEntity and flips the suggestion status atomically.
 *
 * `generic-opportunity` is deliberately excluded: it's a shared fallback type used by
 * several unrelated flows (cwv-trends, accessibility reports, hreflang/canonical paid
 * fallback), not a single semantic opportunity type, so blocking it would over-restrict
 * unrelated suggestions.
 */
export const SUGGESTION_TYPES_REQUIRING_FIX_ENTITY = [
  'cwv',
  'alt-text',
  'broken-backlinks',
  'broken-internal-links',
  'security-vulnerabilities',
  'security-permissions',
  'security-permissions-redundant',
  'security-csp',
  'structured-data',
  'meta-tags',
  'hreflang',
  'redirect-chains',
  'sitemap',
  'canonical',
  'accessibility',
  'a11y-color-contrast',
  'form-accessibility',
  'high-organic-low-ctr',
  'high-form-views-low-conversions',
  'high-page-views-low-form-nav',
  'high-page-views-low-form-views',
];
