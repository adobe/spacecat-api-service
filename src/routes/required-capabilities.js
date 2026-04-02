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
 * Routes that are intentionally excluded from S2S consumer access.
 * Deny-by-default blocks these for S2S consumers. Every omission is a conscious decision
 * documented below. These must never be added to routeRequiredCapabilities.
 *
 * @type {string[]}
 */
export const INTERNAL_ROUTES = [
  // Webhooks - called by external Adobe systems with shared secrets, not S2S JWT
  'POST /event/fulfillment',
  'POST /event/fulfillment/:eventType',

  // Hooks - use hookSecret in path for auth, not JWT
  'POST /hooks/site-detection/cdn/:hookSecret',
  'POST /hooks/site-detection/rum/:hookSecret',

  // Preflight - CS/preflight flow not exposed to S2S consumers; end-user UI only
  'POST /preflight/jobs',
  'GET /preflight/jobs/:jobId',

  // Suggestion edge ops (auto-fix, edge-deploy, etc.): not yet required by S2S
  // TODO: Add these back in when we have a S2S consumer that needs them
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview',

  // Slack - event subscriptions and commands use Slack's signature verification
  'GET /slack/events',
  'POST /slack/events',
  'POST /slack/channels/invite-by-user-id',

  // Consent banner - screenshot tooling, end-user/internal use only
  'POST /consent-banner',
  'GET /consent-banner/:jobId',

  // Brand Presence stats - org-scoped, LLMO product; not yet required by S2S consumers
  'GET /org/:spaceCatId/brands/all/brand-presence/stats',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/stats',

  // LLMO Opportunities - org-scoped, LLMO product; not yet required by S2S consumers
  'GET /org/:spaceCatId/opportunities/count',
  'GET /org/:spaceCatId/brands/all/opportunities',
  'GET /org/:spaceCatId/brands/:brandId/opportunities',

  // LLMO operations not exposed to S2S - onboard, offboard, edge config, brand claims, etc.
  'GET /sites/:siteId/llmo/brand-claims',
  'GET /sites/:siteId/llmo/strategy/demo/brand-presence',
  'GET /sites/:siteId/llmo/strategy/demo/recommendations',
  'POST /llmo/onboard',
  'POST /sites/:siteId/llmo/offboard',
  'POST /sites/:siteId/llmo/edge-optimize-config',
  'POST /sites/:siteId/llmo/edge-optimize-config/stage',
  'POST /sites/:siteId/llmo/edge-optimize-routing',
  'PUT /sites/:siteId/llmo/opportunities-reviewed',

  // PLG onboarding - IMS token auth, self-service flow, not S2S
  'POST /plg/onboard',
  'GET /aso-plg-sites',
  'GET /plg/onboard/status/:imsOrgId',

  // Tier-specific - user activities, trial users, user details: end-user/admin flows only
  'GET /sites/:siteId/user-activities',
  'POST /sites/:siteId/user-activities',
  'GET /organizations/:organizationId/trial-users',
  'GET /organizations/:organizationId/userDetails/:externalUserId',
  'POST /organizations/:organizationId/userDetails',
  'POST /organizations/:organizationId/trial-user-invite',
  'GET /trial-users/email-preferences',
  'PATCH /trial-users/email-preferences',

  // Entitlement upsert + PLG site enrollment - admin/manual provisioning only, not S2S
  'POST /organizations/:organizationId/entitlements',
  'POST /sites/:siteId/site-enrollments',
  // Feature flags write - admin only, mysticat-backed org config
  'PUT /organizations/:organizationId/feature-flags/:product/:flagName',
  'DELETE /organizations/:organizationId/feature-flags/:product/:flagName',

  // IMS org access (delegation grants) - admin-only, cross-org grant management
  'POST /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access/:accessId',
  'DELETE /sites/:siteId/ims-org-access/:accessId',

  // Consumer management - admin-only, requires is_s2s_admin; not for general S2S consumers
  'GET /consumers',
  'GET /consumers/by-client-id/:clientId',
  'GET /consumers/:consumerId',
  'POST /consumers/register',
  'PATCH /consumers/:consumerId',
  'POST /consumers/:consumerId/revoke',
];

/**
 * Maps each route key to the required capability for S2S consumer validation.
 * Format: 'entity:action' where action is 'read' for GET, 'write' for all other methods.
 * Entity names use camelCase consistently (e.g. apiKey, botBlocker, importJob) to avoid
 * silent auth failures when granting capabilities — consumers must use exact entity names.
 *
 * Routes not listed here (and not in INTERNAL_ROUTES) are denied for S2S consumers.
 * Only routes explicitly defined with a capability in this mapping can be called by S2S consumers.
 *
 * site:read scope: Granting site:read implicitly covers traffic data, URL store, LLMO data,
 * experiments, metrics, scraped content, and more. Fine for v1 with few trusted S2S consumers.
 * If fine-grained access control is ever needed, this bundling will need unwinding.
 */
const routeRequiredCapabilities = {
  // Audits
  'GET /audits/latest/:auditType': 'audit:read',

  // Configuration
  'GET /configurations/latest': 'configuration:read',
  'PATCH /configurations/latest': 'configuration:write',
  'POST /configurations/:version/restore': 'configuration:write',
  'GET /configurations/:version': 'configuration:read',
  'POST /configurations/audits': 'configuration:write',
  'DELETE /configurations/audits/:auditType': 'configuration:write',
  'PUT /configurations/latest/queues': 'configuration:write',
  'PATCH /configurations/latest/jobs/:jobType': 'configuration:write',
  'PATCH /configurations/latest/handlers/:handlerType': 'configuration:write',
  'PATCH /configurations/sites/audits': 'configuration:write',

  // Organizations
  'GET /organizations': 'organization:read',
  'POST /organizations': 'organization:write',
  'GET /organizations/:organizationId': 'organization:read',
  'GET /organizations/by-ims-org-id/:imsOrgId': 'organization:read',
  'GET /organizations/by-ims-org-id/:imsOrgId/slack-config': 'organization:read',
  'PATCH /organizations/:organizationId': 'organization:write',
  'DELETE /organizations/:organizationId': 'organization:write',
  'GET /organizations/:organizationId/sites': 'site:read',
  'GET /organizations/:organizationId/brands': 'brand:read',
  'GET /v2/orgs/:spaceCatId/brands': 'organization:read',
  'GET /v2/orgs/:spaceCatId/brands/:brandId': 'organization:read',
  'GET /v2/orgs/:spaceCatId/categories': 'organization:read',
  'POST /v2/orgs/:spaceCatId/categories': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/categories/:categoryId': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/categories/:categoryId': 'organization:write',
  'GET /v2/orgs/:spaceCatId/topics': 'organization:read',
  'POST /v2/orgs/:spaceCatId/topics': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/topics/:topicId': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/topics/:topicId': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/brands/:brandId': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'organization:read',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete': 'organization:write',
  'POST /v2/orgs/:spaceCatId/sites/:siteId/sync-config': 'organization:write',
  'GET /org/:spaceCatId/brands/all/brand-presence/filter-dimensions': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/weeks': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/weeks': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-overview': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/market-tracking-trends': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/search': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/search': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-movers': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/share-of-voice': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice': 'brand:read',
  'GET /v2/orgs/:spaceCatId/llmo-customer-config': 'organization:read',
  'GET /v2/orgs/:spaceCatId/llmo-customer-config-lean': 'organization:read',
  'GET /v2/orgs/:spaceCatId/llmo-topics': 'organization:read',
  'GET /v2/orgs/:spaceCatId/llmo-prompts': 'organization:read',
  'POST /v2/orgs/:spaceCatId/llmo-customer-config': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/llmo-customer-config': 'organization:write',
  'GET /organizations/:organizationId/projects': 'project:read',
  'GET /organizations/:organizationId/projects/:projectId/sites': 'site:read',
  'GET /organizations/:organizationId/by-project-name/:projectName/sites': 'site:read',

  // Projects
  'GET /projects': 'project:read',
  'POST /projects': 'project:write',
  'GET /projects/:projectId': 'project:read',
  'PATCH /projects/:projectId': 'project:write',
  'DELETE /projects/:projectId': 'project:write',
  'GET /projects/:projectId/sites/primary-locale': 'site:read',
  'GET /projects/:projectId/sites': 'site:read',
  'GET /projects/by-project-name/:projectName/sites': 'site:read',

  // Sites
  'GET /sites': 'site:read',
  'POST /sites': 'site:write',
  'GET /sites.csv': 'site:read',
  'GET /sites.xlsx': 'site:read',
  'GET /sites/:siteId': 'site:read',
  'PATCH /sites/:siteId': 'site:write',
  'PATCH /sites/:siteId/config/cdn-logs': 'site:write',
  'DELETE /sites/:siteId': 'site:write',
  'GET /sites/:siteId/bot-blocker': 'site:read',
  'GET /sites/:siteId/audits': 'audit:read',
  'GET /sites/:siteId/audits/latest': 'audit:read',
  'GET /sites/:siteId/audits/:auditType': 'audit:read',
  'GET /sites/:siteId/audits/:auditType/:auditedAt': 'audit:read',

  // URL Store
  'GET /sites/:siteId/url-store': 'site:read',
  'GET /sites/:siteId/url-store/by-audit/:auditType': 'site:read',
  'GET /sites/:siteId/url-store/:base64Url': 'site:read',
  'POST /sites/:siteId/url-store': 'site:write',
  'PATCH /sites/:siteId/url-store': 'site:write',
  'POST /sites/:siteId/url-store/delete': 'site:write',

  'PATCH /sites/:siteId/:auditType': 'audit:write',
  'GET /sites/:siteId/latest-audit/:auditType': 'audit:read',
  'GET /sites/:siteId/experiments': 'experiment:read',
  'GET /sites/:siteId/metrics/:metric/:source': 'site:read',
  'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl': 'site:read',
  'GET /sites/:siteId/latest-metrics': 'site:read',
  'GET /sites/by-base-url/:baseURL': 'site:read',
  'GET /sites/by-delivery-type/:deliveryType': 'site:read',
  'GET /sites/with-latest-audit/:auditType': 'site:read',

  // Opportunities
  'GET /sites/:siteId/opportunities': 'opportunity:read',
  'GET /sites/:siteId/opportunities/top-paid': 'opportunity:read',
  'GET /sites/:siteId/opportunities/by-status/:status': 'opportunity:read',
  'GET /sites/:siteId/opportunities/:opportunityId': 'opportunity:read',
  'POST /sites/:siteId/opportunities': 'opportunity:write',
  'PATCH /sites/:siteId/opportunities/:opportunityId': 'opportunity:write',
  'DELETE /sites/:siteId/opportunities/:opportunityId': 'opportunity:write',

  // Suggestions
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit/:cursor': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit/:cursor': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'suggestion:read',
  'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes': 'fixEntity:read',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions': 'suggestion:write',
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': 'suggestion:write',
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'suggestion:write',
  'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'suggestion:write',

  // Traffic
  'GET /sites/:siteId/traffic/paid': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-page-type-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-campaign-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/page-type-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-url-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-url': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/type-channel-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/type-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/type-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/type': 'site:read',
  'GET /sites/:siteId/traffic/paid/pta2/weekly-summary': 'site:read',
  'GET /sites/:siteId/traffic/paid/type-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/type-device-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/channel-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/channel-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/social-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/social-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/search-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/search-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/display-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/display-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/video-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/video-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/url': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-channel-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/url-channel-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-channel-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-channel-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/campaign-channel-platform-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-channel-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-url': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-url-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel-platform': 'site:read',
  'GET /sites/:siteId/traffic/paid/impact-by-page': 'site:read',
  'GET /sites/:siteId/traffic/paid/impact-by-page-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type': 'site:read',
  'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type-device': 'site:read',
  'GET /sites/:siteId/traffic/paid/traffic-loss-by-devices': 'site:read',
  'POST /sites/:siteId/traffic/predominant-type': 'site:write',
  'POST /sites/:siteId/traffic/predominant-type/:channel': 'site:write',

  // Brands
  'GET /sites/:siteId/brand-guidelines': 'site:read',
  'GET /sites/:siteId/brand-profile': 'site:read',
  'POST /sites/:siteId/brand-profile': 'site:write',

  // Page Citability
  'GET /sites/:siteId/page-citability/counts': 'site:read',

  // Top Pages
  'GET /sites/:siteId/top-pages': 'site:read',
  'GET /sites/:siteId/top-pages/:source': 'site:read',
  'GET /sites/:siteId/top-pages/:source/:geo': 'site:read',

  // Graph
  'POST /sites/:siteId/graph': 'site:write',

  // Trigger — GET triggers side effect; consider POST for RFC 7231 semantics (follow-up)
  'GET /trigger': 'audit:write',

  // API Keys
  'POST /tools/api-keys': 'apiKey:write',
  'DELETE /tools/api-keys/:id': 'apiKey:write',
  'GET /tools/api-keys': 'apiKey:read',

  // Import Jobs
  'POST /tools/import/jobs': 'importJob:write',
  'GET /tools/import/jobs/:jobId': 'importJob:read',
  'DELETE /tools/import/jobs/:jobId': 'importJob:write',
  'PATCH /tools/import/jobs/:jobId': 'importJob:write',
  'GET /tools/import/jobs/:jobId/progress': 'importJob:read',
  'POST /tools/import/jobs/:jobId/result': 'importJob:write',
  'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs': 'importJob:read',

  // Scraped Content
  'GET /sites/:siteId/scraped-content/:type': 'site:read',
  'GET /sites/:siteId/metadata': 'site:read',
  'GET /sites/:siteId/files': 'site:read',

  // Scrape Jobs
  'POST /tools/scrape/jobs': 'scrapeJob:write',
  'GET /tools/scrape/jobs/:jobId': 'scrapeJob:read',
  'GET /tools/scrape/jobs/:jobId/results': 'scrapeJob:read',
  'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': 'scrapeJob:read',
  'GET /tools/scrape/jobs/by-base-url/:baseURL': 'scrapeJob:read',
  'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': 'scrapeJob:read',
  'GET /tools/scrape/jobs/by-url/:url/:processingType': 'scrapeJob:read',
  'GET /tools/scrape/jobs/by-url/:url': 'scrapeJob:read',

  // Fixes
  'GET /sites/:siteId/opportunities/:opportunityId/fixes': 'fixEntity:read',
  'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status': 'fixEntity:read',
  'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'fixEntity:read',
  'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions': 'suggestion:read',
  'POST /sites/:siteId/opportunities/:opportunityId/fixes': 'fixEntity:write',
  'PATCH /sites/:siteId/opportunities/:opportunityId/status': 'opportunity:write',
  'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'fixEntity:write',
  'POST /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/actions/rolled_back': 'fixEntity:write',
  'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'fixEntity:write',

  // LLMO
  'GET /sites/:siteId/llmo/sheet-data/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': 'site:read',
  'POST /sites/:siteId/llmo/sheet-data/:dataSource': 'site:write',
  'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': 'site:write',
  'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': 'site:write',
  'GET /sites/:siteId/llmo/data': 'site:read',
  'GET /sites/:siteId/llmo/data/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/data/:sheetType/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/data/:sheetType/:week/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/config': 'site:read',
  'PATCH /sites/:siteId/llmo/config': 'site:write',
  'POST /sites/:siteId/llmo/config': 'site:write',
  'GET /sites/:siteId/llmo/questions': 'site:read',
  'POST /sites/:siteId/llmo/questions': 'site:write',
  'DELETE /sites/:siteId/llmo/questions/:questionKey': 'site:write',
  'PATCH /sites/:siteId/llmo/questions/:questionKey': 'site:write',
  'GET /sites/:siteId/llmo/customer-intent': 'site:read',
  'POST /sites/:siteId/llmo/customer-intent': 'site:write',
  'DELETE /sites/:siteId/llmo/customer-intent/:intentKey': 'site:write',
  'PATCH /sites/:siteId/llmo/customer-intent/:intentKey': 'site:write',
  'PATCH /sites/:siteId/llmo/cdn-logs-filter': 'site:write',
  'PATCH /sites/:siteId/llmo/cdn-logs-bucket-config': 'site:write',
  'GET /sites/:siteId/llmo/global-sheet-data/:configName': 'site:read',
  'GET /sites/:siteId/llmo/rationale': 'site:read',
  'GET /sites/:siteId/llmo/edge-optimize-config': 'site:read',
  'GET /sites/:siteId/llmo/strategy': 'site:read',
  'PUT /sites/:siteId/llmo/strategy': 'site:write',
  'GET /sites/:siteId/llmo/edge-optimize-status': 'site:read',

  // Site Enrollments
  'GET /sites/:siteId/site-enrollments': 'siteEnrollment:read',

  // Entitlements
  'GET /organizations/:organizationId/entitlements': 'entitlement:read',
  'GET /organizations/:organizationId/feature-flags': 'organization:read',

  // Sandbox
  'POST /sites/:siteId/sandbox/audit': 'site:write',

  // Reports
  'POST /sites/:siteId/reports': 'report:write',
  'GET /sites/:siteId/reports': 'report:read',
  'GET /sites/:siteId/reports/:reportId': 'report:read',
  'PATCH /sites/:siteId/reports/:reportId': 'report:write',
  'DELETE /sites/:siteId/reports/:reportId': 'report:write',

  'GET /sites-resolve': 'site:read',

  // Sentiment - Topics
  'GET /sites/:siteId/sentiment/topics': 'sentimentTopic:read',
  'GET /sites/:siteId/sentiment/topics/:topicId': 'sentimentTopic:read',
  'POST /sites/:siteId/sentiment/topics': 'sentimentTopic:write',
  'PATCH /sites/:siteId/sentiment/topics/:topicId': 'sentimentTopic:write',
  'DELETE /sites/:siteId/sentiment/topics/:topicId': 'sentimentTopic:write',

  // Sentiment - Guidelines
  'GET /sites/:siteId/sentiment/guidelines': 'sentimentGuideline:read',
  'GET /sites/:siteId/sentiment/guidelines/:guidelineId': 'sentimentGuideline:read',
  'POST /sites/:siteId/sentiment/guidelines': 'sentimentGuideline:write',
  'PATCH /sites/:siteId/sentiment/guidelines/:guidelineId': 'sentimentGuideline:write',
  'DELETE /sites/:siteId/sentiment/guidelines/:guidelineId': 'sentimentGuideline:write',
  'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits': 'sentimentGuideline:write',
  'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits/unlink': 'sentimentGuideline:write',

  // Sentiment - Config
  'GET /sites/:siteId/sentiment/config': 'sentimentTopic:read',

  // Tokens
  'GET /sites/:siteId/tokens/by-type/:tokenType': 'token:read',
};

export default routeRequiredCapabilities;
