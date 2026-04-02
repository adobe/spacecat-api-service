/*
 * Copyright 2025 Adobe. All rights reserved.
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
 * Routes that exist in code but are not yet documented in the OpenAPI spec.
 * Each entry must have a comment explaining why it is undocumented.
 *
 * This list is enforced by test/routes/openapi-coverage.test.js with a ratchet:
 * the count cannot grow without updating the ceiling in the test.
 * As routes are documented in OpenAPI, remove them from this list.
 *
 * Format: 'METHOD /path/:param' (same as routeDefinitions in routes/index.js)
 *
 * @type {string[]}
 */
export const UNDOCUMENTED_ROUTES = [
  // --- Categories (v2) ---
  'GET /v2/orgs/:spaceCatId/categories',
  'POST /v2/orgs/:spaceCatId/categories',
  'PATCH /v2/orgs/:spaceCatId/categories/:categoryId',
  'DELETE /v2/orgs/:spaceCatId/categories/:categoryId',

  // --- Config sync ---
  'POST /v2/orgs/:spaceCatId/sites/:siteId/sync-config',

  // --- Sites: export formats ---
  'GET /sites.csv',
  'GET /sites.xlsx',

  // --- Sites: metadata ---
  'GET /sites/:siteId/metadata',

  // --- Sites: URL store (bulk operations without URL in path) ---
  'POST /sites/:siteId/url-store',
  'PATCH /sites/:siteId/url-store',

  // --- Sites: opportunities ---
  'GET /sites/:siteId/opportunities/top-paid',

  // --- Sites: page citability ---
  'GET /sites/:siteId/page-citability/counts',

  // --- Sites: LLMO ---
  'PATCH /sites/:siteId/llmo/config',
  'GET /sites/:siteId/llmo/rationale',

  // --- Sites: site enrollments ---
  'POST /sites/:siteId/site-enrollments',

  // --- Sites: IMS org access delegation ---
  'POST /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access/:accessId',
  'DELETE /sites/:siteId/ims-org-access/:accessId',

  // --- Slack ---
  'GET /slack/events',
  'POST /slack/events',

  // --- Tools: import ---
  'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs',

  // --- Tools: scrape ---
  'GET /tools/scrape/jobs/by-url/:url',

  // --- Organizations: user details ---
  'GET /organizations/:organizationId/userDetails/:externalUserId',
  'POST /organizations/:organizationId/userDetails',

  // --- Organizations: entitlements ---
  'POST /organizations/:organizationId/entitlements',

  // --- Trial users ---
  'GET /trial-users/email-preferences',
  'PATCH /trial-users/email-preferences',

  // --- Consumers ---
  'GET /consumers',
  'GET /consumers/by-client-id/:clientId',
  'GET /consumers/:consumerId',
  'POST /consumers/register',
  'PATCH /consumers/:consumerId',
  'POST /consumers/:consumerId/revoke',

  // --- Brand presence analytics (org-level) ---
  'GET /org/:spaceCatId/brands/all/brand-presence/filter-dimensions',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions',
  'GET /org/:spaceCatId/brands/all/brand-presence/weeks',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/weeks',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-overview',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview',
  'GET /org/:spaceCatId/brands/all/brand-presence/market-tracking-trends',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts',
  'GET /org/:spaceCatId/brands/all/brand-presence/search',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/search',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-movers',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers',
  'GET /org/:spaceCatId/brands/all/brand-presence/share-of-voice',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice',
  'GET /org/:spaceCatId/brands/all/brand-presence/stats',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/stats',
  'GET /org/:spaceCatId/opportunities/count',
  'GET /org/:spaceCatId/brands/all/opportunities',
  'GET /org/:spaceCatId/brands/:brandId/opportunities',
];

/**
 * OpenAPI paths documented in the spec but with no corresponding code route.
 * These are tracked here so the coverage test can account for them.
 * Each entry should be investigated: remove from OpenAPI if dead, or add code route if planned.
 *
 * Format: 'METHOD /openapi/path/{param}' (OpenAPI format)
 *
 * @type {string[]}
 */
export const PHANTOM_OPENAPI_ROUTES = [
  // Auth routes — documented but not implemented in routes/index.js
  'GET /auth/google/{siteId}',
  'GET /auth/google/{siteId}/status',
  'POST /auth/login',

  // Hook — documented but not in routes
  'POST /hooks/site-integration/analytics/{hookSecret}',

  // LLMO customer config (v2) — documented but not in routes
  'GET /v2/orgs/{spaceCatId}/llmo-customer-config',
  'POST /v2/orgs/{spaceCatId}/llmo-customer-config',
  'PATCH /v2/orgs/{spaceCatId}/llmo-customer-config',
  'GET /v2/orgs/{spaceCatId}/llmo-customer-config-lean',
  'GET /v2/orgs/{spaceCatId}/llmo-topics',
  'GET /v2/orgs/{spaceCatId}/llmo-prompts',

  // URL store — OpenAPI uses {base64Url} in path, code uses bulk endpoint without URL param
  'POST /sites/{siteId}/url-store/{base64Url}',
  'PATCH /sites/{siteId}/url-store/{base64Url}',
];
