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

import {
  CAP_CONFIGURATION_READ,
  CAP_CONFIGURATION_WRITE,
  CAP_FIX_ENTITY_CREATE,
  CAP_ORG_READ_ALL,
  CAP_SITE_CREATE,
  CAP_SITE_READ_ALL,
  CAP_SUGGESTION_WRITE,
  CAP_TRIAL_USER_READ,
} from './capability-constants.js';

/**
 * Routes that are intentionally excluded from S2S consumer access.
 *
 * Enforcement note: deny-by-default for S2S JWT callers is driven by *absence* of a route
 * from `routeRequiredCapabilities` (see `s2sAuthWrapper` in `@adobe/spacecat-shared-http-utils`).
 * This list is documentation + a coverage-test assertion — it records the deliberate decision
 * to leave a route out of `routeRequiredCapabilities` so the decision is visible, greppable,
 * and reviewable. Admin `x-api-key` callers bypass the S2S path entirely and are unaffected
 * by either list.
 *
 * Every omission is a conscious decision documented below. A route must never appear in both
 * this list and `routeRequiredCapabilities` — the disjointness invariant is enforced by test.
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
  // GitHub App webhook - authenticated by HMAC-SHA256 signature, not S2S JWT
  'POST /webhooks/github',

  // ASO redirect overlay - authenticated by X-ASO-API-Key (AsoOverlayKeyHandler), not S2S JWT
  'GET /config/:service/redirects.txt',

  // Suggestion edge ops (edge-deploy, etc.): not yet required by S2S
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview',
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview',

  // Geo experiment — write/delete endpoints used by DRS/UI
  'PATCH /sites/:siteId/geo-experiments/:geoExperimentId',
  'DELETE /sites/:siteId/geo-experiments/:geoExperimentId',

  // Slack - event subscriptions and commands use Slack's signature verification
  'GET /slack/events',
  'POST /slack/events',
  'POST /slack/channels/invite-by-user-id',

  // Brand Presence stats - org-scoped, LLMO product; not yet required by S2S consumers
  'GET /org/:spaceCatId/brands/all/brand-presence/stats',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/stats',

  // URL Inspector - org-scoped, site-filtered; LLMO product, not yet required by S2S consumers
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/stats',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/domain-urls',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/domain-urls',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/url-prompts',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/url-prompts',
  'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/filter-dimensions',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/filter-dimensions',

  // LLMO Opportunities - org-scoped, LLMO product; not yet required by S2S consumers
  'GET /org/:spaceCatId/opportunities/count',
  'GET /org/:spaceCatId/brands/all/opportunities',
  'GET /org/:spaceCatId/brands/:brandId/opportunities',

  // Agentic traffic PG dashboard endpoints (site-scoped) - UI only, not yet required by S2S
  'GET /sites/:siteId/agentic-traffic/url-brand-presence',
  'GET /sites/:siteId/agentic-traffic/kpis',
  'GET /sites/:siteId/agentic-traffic/by-region',
  'GET /sites/:siteId/agentic-traffic/by-category',
  'GET /sites/:siteId/agentic-traffic/by-page-type',
  'GET /sites/:siteId/agentic-traffic/by-status',
  'GET /sites/:siteId/agentic-traffic/by-user-agent',
  'GET /sites/:siteId/agentic-traffic/by-url',
  'POST /sites/:siteId/agentic-traffic/hits-by-urls',
  'GET /sites/:siteId/agentic-traffic/filter-dimensions',
  'GET /sites/:siteId/agentic-traffic/weeks',
  'GET /sites/:siteId/agentic-traffic/movers',
  'POST /sites/:siteId/agentic-traffic/urls/export',
  'GET /sites/:siteId/agentic-traffic/urls/export/:exportId',

  // Referral traffic PG dashboard endpoints (site-scoped) - UI only, not yet required by S2S
  'GET /sites/:siteId/referral-traffic/has-data',
  'GET /sites/:siteId/referral-traffic/filter-dimensions',
  'GET /sites/:siteId/referral-traffic/kpis',
  'GET /sites/:siteId/referral-traffic/trend',
  'GET /sites/:siteId/referral-traffic/by-platform',
  'GET /sites/:siteId/referral-traffic/by-region',
  'GET /sites/:siteId/referral-traffic/by-page-intent',
  'GET /sites/:siteId/referral-traffic/by-url',
  'GET /sites/:siteId/referral-traffic/by-url-trend',
  'GET /sites/:siteId/referral-traffic/by-device',
  'GET /sites/:siteId/referral-traffic/business-impact',
  'GET /sites/:siteId/referral-traffic/weeks',

  // LLMO operations not exposed to S2S - onboard, offboard, edge config, brand claims, etc.
  'GET /sites/:siteId/llmo/brand-claims',
  'GET /sites/:siteId/llmo/strategy/demo/brand-presence',
  'GET /sites/:siteId/llmo/strategy/demo/recommendations',
  'POST /llmo/onboard',
  'POST /v2/orgs/:spaceCatId/llmo/onboard-site',
  'POST /llmo/onboard/update-query-index',
  'POST /sites/:siteId/llmo/offboard',
  'POST /sites/:siteId/llmo/edge-optimize-config',
  'POST /sites/:siteId/llmo/edge-optimize-config/stage',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/bootstrap-url',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/connect',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/distributions',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/prerequisites',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/origins',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/behaviors',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/create-origin',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/create-function',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/apply-cache',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/create-lambda',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/lambda-status',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/apply-associations',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/verify',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/deploy',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudfront/plan',
  'GET /sites/:siteId/llmo/cdn-onboard/cloudfront/permissions',
  'PUT /sites/:siteId/llmo/opportunities-reviewed',

  // LLMO Cloudflare onboarding - LLMO-admin self-service, gated by isLLMOAdministrator();
  // uses a caller-supplied x-cloudflare-token, not S2S JWT
  'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/config',
  'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/accounts',
  'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/zones',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudflare/deploy',
  'POST /sites/:siteId/llmo/cdn-onboard/cloudflare/routes',

  // PLG onboarding - IMS token auth, self-service flow, not S2S
  'POST /plg/onboard',
  'GET /plg/sites',
  'GET /plg/onboard/status/:imsOrgId',
  'PATCH /plg/onboard/:onboardingId',
  'PATCH /plg/onboard/:onboardingId/status',
  'POST /plg/records',
  'PATCH /plg/records/:plgOnboardingId',
  'DELETE /plg/records/:plgOnboardingId',

  // Tier-specific - user activities (POST only), user details: end-user/admin flows
  'POST /sites/:siteId/user-activities',
  'GET /admin/users/:userId',
  'GET /organizations/:organizationId/userDetails/:externalUserId',
  'POST /organizations/:organizationId/userDetails',
  'POST /organizations/:organizationId/trial-user-invite',
  'GET /trial-users/email-preferences',
  'PATCH /trial-users/email-preferences',

  // Entitlement upsert + PLG site enrollment - admin/manual provisioning only, not S2S
  'POST /organizations/:organizationId/entitlements',
  'POST /sites/:siteId/site-enrollments',
  'POST /sites/:siteId/entitlements',
  // Feature flags write - admin only, mysticat-backed org config
  'PUT /organizations/:organizationId/feature-flags/:product/:flagName',
  'DELETE /organizations/:organizationId/feature-flags/:product/:flagName',

  // IMS org access (delegation grants) - admin-only, cross-org grant management
  'POST /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access',
  'GET /sites/:siteId/ims-org-access/:accessId',
  'DELETE /sites/:siteId/ims-org-access/:accessId',

  // Contact sales leads - IMS-authenticated, end-user UI only; not for S2S consumers
  'POST /organizations/:organizationId/sites/:siteId/contact-sales-lead',
  'GET /organizations/:organizationId/contact-sales-leads',
  'GET /organizations/:organizationId/sites/:siteId/contact-sales-lead',
  'PATCH /contact-sales-leads/:contactSalesLeadId',

  // Consumer management - admin-only, requires is_s2s_admin; not for general S2S consumers
  'GET /consumers',
  'GET /consumers/by-client-id/:clientId',
  'GET /consumers/:consumerId',
  'POST /consumers/register',
  'PATCH /consumers/:consumerId',
  'POST /consumers/:consumerId/revoke',

  // API Keys - scoped API key management; end-user/admin flow, not exposed to S2S consumers
  'POST /tools/api-keys',
  'DELETE /tools/api-keys/:id',
  'GET /tools/api-keys',
  // URL preview proxy - UI-only utility for iframe rendering; not for S2S consumers
  'GET /tools/proxy',
  // Insights orchestration - admin-only via hasAdminAccess(); not for S2S consumers
  'POST /ephemeral-run/batch',
  'GET /ephemeral-run/batch/:batchId/status',

  // Regions lookup - global table, no org scope; session-token authenticated, not for S2S consumers
  'GET /v2/regions',

  // Monitoring - DRS Brand Presence PostgREST audit proxy. Called by DRS monitoring workers
  // via admin x-api-key only (DRS runs in a separate AWS account and holds no S2S consumer
  // registration). Kept internal because reusing `audit:read` would silently broaden that
  // site-scoped capability to cover platform/infra monitoring data. Revisit when a concrete
  // S2S consumer exists and introduce a dedicated capability scoped to the exposed resource
  // (e.g. `drsBrandPresenceAudit:read`) rather than bundling into `audit:read` or a domain
  // bucket like `monitoring:read` that would re-create the same problem for the next
  // monitoring endpoint.
  'GET /monitoring/drs-bp-pg-audit',

  // Hybrid permission model — state-layer management + capability
  // introspection. Customer-org admins manage their own ReBAC bindings here,
  // self-gated in the controller by `<product>/can_manage_users` (CRUD) and
  // `<product>/can_view` (catalog/effective-capabilities). Never S2S —
  // automated consumers must never be able to grant themselves access to
  // customer resources. (Until facsWrapper is attached in api-service, the
  // controller also restricts these to AWS_ENV === 'dev'.)
  'GET /state/access-mappings',
  'GET /state/access-mappings/history',
  'POST /state/access-mappings',
  'PATCH /state/access-mappings/:id',
  'DELETE /state/access-mappings/:id',
  'GET /organizations/:organizationId/permission/audit-logs',
  'GET /product/capabilities',
  'GET /user/capabilities/:resourceId',

  // Profiles feature — AI-generated custom profiles + workflows. Not yet
  // exposed to S2S consumers; auth handled by SKIP_AUTH / SkipAuthHandler.
  'POST /sites/:siteId/profiles/chat',
  'POST /sites/:siteId/profiles',
  'GET /sites/:siteId/profiles',
  'GET /sites/:siteId/profiles/:profileId',
  'POST /sites/:siteId/profiles/:profileId/copy',
  'DELETE /sites/:siteId/profiles/:profileId',
  'GET /sites/:siteId/profiles/:profileId/workflows',
  'POST /sites/:siteId/profiles/:profileId/workflows',
  'PATCH /sites/:siteId/profiles/:profileId/workflows/:workflowId',
  'DELETE /sites/:siteId/profiles/:profileId/workflows/:workflowId',
];

/**
 * Maps each route key to the required capability for S2S consumer validation.
 * Format: 'entity:action' where action is 'read' for GET, 'write' for all other methods.
 * Entity names use camelCase consistently (e.g. apiKey, botBlocker, importJob) to avoid
 * silent auth failures when granting capabilities — consumers must use exact entity names.
 *
 * Authoritative entity list: entity names must match those registered in
 * `@adobe/spacecat-shared-data-access` at `src/models/base/entity.registry.js` (plus the
 * S3-backed `configuration` entity). Capability strings referencing unregistered entities are
 * schema-valid but can never be granted to an S2S consumer — `Consumer.validateCapabilities`
 * in the data-access layer rejects them. Do not invent entity names here.
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

  // Consent Banner — POST is a screenshot *scrape* trigger, so it's gated like
  // the sibling `/tools/scrape/jobs` POST (scrapeJob:write) rather than
  // organization:write, letting S2S scrape consumers (e.g. Mystique) trigger it.
  'POST /consent-banner': 'scrapeJob:write',
  'GET /consent-banner/:jobId': 'organization:read',

  // Configuration
  'GET /configurations/latest': CAP_CONFIGURATION_READ,
  'PATCH /configurations/latest': CAP_CONFIGURATION_WRITE,
  'POST /configurations/:version/restore': CAP_CONFIGURATION_WRITE,
  'GET /configurations/:version': CAP_CONFIGURATION_READ,
  'POST /configurations/audits': CAP_CONFIGURATION_WRITE,
  'DELETE /configurations/audits/:auditType': CAP_CONFIGURATION_WRITE,
  'PUT /configurations/latest/queues': CAP_CONFIGURATION_WRITE,
  'PATCH /configurations/latest/jobs/:jobType': CAP_CONFIGURATION_WRITE,
  'PATCH /configurations/latest/handlers/:handlerType': CAP_CONFIGURATION_WRITE,
  'PATCH /configurations/sites/audits': CAP_CONFIGURATION_WRITE,

  // Organizations
  'GET /organizations': CAP_ORG_READ_ALL,
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
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId/status': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/brands/:brandId': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/activate': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'organization:read',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/stats': 'organization:read',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:write',
  'DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/check': 'organization:read',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts/:semrushPromptId': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts/bulk-delete': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode': 'organization:read',
  'DELETE /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags': 'organization:write',
  'PATCH /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags/:tagId': 'organization:write',
  'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/models': 'organization:read',
  'PUT /v2/orgs/:spaceCatId/brands/:brandId/serenity/models': 'organization:write',
  // Org-level Semrush catalogue lookups (brand-independent): read-only, org
  // access enforced in the controller (listOrgModels / listOrgLanguages).
  'GET /v2/orgs/:spaceCatId/serenity/models': 'organization:read',
  'GET /v2/orgs/:spaceCatId/serenity/languages': 'organization:read',
  'GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/filter-dimensions': 'organization:read',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/activate': 'organization:write',
  'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/deactivate': 'organization:write',
  'GET /v2/orgs/:spaceCatId/sites/:siteId/brand': 'organization:read',
  'GET /org/:spaceCatId/brands/:brandId/fanout-report': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/filter-dimensions': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/weeks': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/weeks': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-overview': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/market-tracking-trends': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/competitor-summary': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/competitor-summary': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/prompt-execution-status': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompt-execution-status': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/search': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/search': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/prompts/:promptId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompts/:promptId/detail': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/executions/:executionId/sources': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/executions/:executionId/sources': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-movers': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers': 'brand:read',
  'GET /org/:spaceCatId/brands/all/brand-presence/share-of-voice': 'brand:read',
  'GET /org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice': 'brand:read',
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

  // preflight jobs (legacy)
  'POST /preflight/jobs': 'site:write',
  'GET /preflight/jobs/:jobId': 'site:read',
  // preflight site-scoped endpoints
  'POST /sites/:siteId/preflights': 'site:write',
  'GET /sites/:siteId/preflights': 'site:read',
  'GET /sites/:siteId/preflights/:preflightId': 'site:read',
  // Preflight checks - proxies user's Bearer token to AEM Author; end-user UI only
  'POST /sites/:siteId/autofix-checks': 'site:read',

  // Sites
  // GET /sites is the cross-tenant list endpoint - guarded by site:readAll, not site:read.
  // Tenant-scoped /sites/:siteId stays on site:read. See READALL_CAPABILITY_DESIGN.md.
  'GET /sites': CAP_SITE_READ_ALL,
  // GET /sites/:siteId/identity is a readAll-class single-site route: it returns only the
  // routing identity (org ids, baseURL, deliveryType) a site:readAll holder can already
  // derive from the bulk list + org join, so it is gated on site:readAll, not site:read.
  'GET /sites/:siteId/identity': CAP_SITE_READ_ALL,
  'POST /sites': CAP_SITE_CREATE,
  'POST /sites/detect/jobs': 'site:write',
  'GET /sites/detect/jobs/:jobId': 'site:read',
  'GET /sites.csv': 'site:read',
  'GET /sites.xlsx': 'site:read',
  'GET /sites/:siteId': 'site:read',
  'PATCH /sites/:siteId': 'site:write',
  'PATCH /sites/:siteId/config/cdn-logs': 'site:write',
  'GET /sites/:siteId/config/scraper': 'site:read',
  'PATCH /sites/:siteId/config/scraper': 'site:write',
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

  // Agentic traffic
  'GET /sites/:siteId/agentic-traffic/has-data': 'site:read',
  // UI-facing read; mapped to site:read so read-only admins hit the read fast-path
  // (RO-admin wrapper) instead of the ownership gate. SITES — RO-admin 403 regression.
  'GET /sites/:siteId/agentic-traffic/kpis-trend': 'site:read',

  // Agentic URL classification rules
  'GET /sites/:siteId/agentic-categories': 'site:read',
  'POST /sites/:siteId/agentic-categories': 'site:write',
  'PATCH /sites/:siteId/agentic-categories/:name': 'site:write',
  'DELETE /sites/:siteId/agentic-categories/:name': 'site:write',
  'GET /sites/:siteId/agentic-page-types': 'site:read',
  'POST /sites/:siteId/agentic-page-types': 'site:write',
  'PATCH /sites/:siteId/agentic-page-types/:name': 'site:write',
  'DELETE /sites/:siteId/agentic-page-types/:name': 'site:write',

  'PATCH /sites/:siteId/:auditType': 'audit:write',
  'GET /sites/:siteId/latest-audit/:auditType': 'audit:read',
  'GET /sites/:siteId/experiments': 'experiment:read',
  'GET /sites/:siteId/geo-experiments': 'site:read',
  'GET /sites/:siteId/geo-experiments/:geoExperimentId': 'site:read', // detail includes prompts
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
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions': CAP_SUGGESTION_WRITE,
  'POST /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/backoffice-reviews': CAP_SUGGESTION_WRITE,
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': CAP_SUGGESTION_WRITE,
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': CAP_FIX_ENTITY_CREATE,
  'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': CAP_SUGGESTION_WRITE,
  'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': CAP_SUGGESTION_WRITE,

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

  // Page Relationships
  'POST /sites/:siteId/page-relationships/search': 'site:read',

  // Trigger — GET triggers side effect; consider POST for RFC 7231 semantics (follow-up)
  'GET /trigger': 'audit:write',

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
  // These POST sheet-data routes use POST only to accommodate complex query payloads that exceed
  // URL length limits. They are non-mutating (no side effects) and intentionally require
  // only site:read, which also allows read-only admins and S2S consumers with read-only tokens
  // to query sheet data.
  'POST /sites/:siteId/llmo/sheet-data/:dataSource': 'site:read',
  'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': 'site:read',
  'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/data': 'site:read',
  'GET /sites/:siteId/llmo/data/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/data/:sheetType/:dataSource': 'site:read',
  'GET /sites/:siteId/llmo/data/:sheetType/:week/:dataSource': 'site:read',
  'PATCH /sites/:siteId/llmo/data/:dataSource/row': 'site:write',
  'PATCH /sites/:siteId/llmo/data/:sheetType/:dataSource/row': 'site:write',
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
  'GET /sites/:siteId/llmo/probes/edge-optimize': 'site:read',
  'GET /llmo/agentic-traffic/global': 'report:read',
  'POST /llmo/agentic-traffic/global': 'report:write',

  // AI Visibility (Semrush proxy): gated like GET /llmo/agentic-traffic/global (report:read)
  'GET /llmo/ai-visibility/brands/stats': 'report:read',
  'GET /llmo/ai-visibility/brands/topics': 'report:read',
  'GET /llmo/ai-visibility/brands/prompts': 'report:read',
  'GET /llmo/ai-visibility/brands/cited-pages': 'report:read',
  'GET /llmo/ai-visibility/brands/topic-opportunities': 'report:read',
  'GET /llmo/ai-visibility/brands/top-brands': 'report:read',
  'GET /llmo/ai-visibility/brands/cited-sources': 'report:read',
  'GET /llmo/ai-visibility/brands/source-opportunities': 'report:read',
  'GET /llmo/ai-visibility/brands/competitors': 'report:read',
  'GET /llmo/ai-visibility/competitors/metrics': 'report:read',
  'GET /llmo/ai-visibility/meta': 'report:read',
  'GET /llmo/ai-visibility/prompts/responses/latest': 'report:read',
  'GET /llmo/ai-visibility/prompts/responses': 'report:read',
  'GET /llmo/ai-visibility/topics/research/stats': 'report:read',
  'GET /llmo/ai-visibility/topics/research/prompts': 'report:read',
  'GET /llmo/ai-visibility/topics/research/brands': 'report:read',
  'GET /llmo/ai-visibility/topics/research/source-domains': 'report:read',
  'GET /llmo/ai-visibility/topics/research': 'report:read',
  'GET /llmo/ai-visibility/topics/stats': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/brand-topics': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/brand-topics-export': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/brand-topics-totals': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/gap-topics': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/gap-topics-export': 'report:read',
  'GET /llmo/ai-visibility/v1/topic/gap-topics-totals': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/brand-prompts': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/brand-prompts-export': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/gap-prompts': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/gap-prompts-export': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/gap-prompts-totals': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt/prompt-response': 'report:read',
  'GET /llmo/ai-visibility/v1/source/gap-source-domains': 'report:read',
  'GET /llmo/ai-visibility/v1/source/gap-source-domains-export': 'report:read',
  'GET /llmo/ai-visibility/v1/source/gap-source-domains-totals': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt-research/prompts-export': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt-research/brands-export': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt-research/source-domains-export': 'report:read',
  'GET /llmo/ai-visibility/v1/prompt-research/topics-export': 'report:read',
  'GET /llmo/ai-visibility/v1/brand/stats-by-country': 'report:read',
  'GET /llmo/ai-visibility/v1/brand/stats-by-llm': 'report:read',
  'GET /llmo/ai-visibility/v1/meta/meta': 'report:read',

  // User Activities
  'GET /sites/:siteId/user-activities': 'trialUser:read',

  // Site Enrollments
  'GET /sites/:siteId/site-enrollments': 'siteEnrollment:read',

  // Trial Users
  'GET /organizations/:organizationId/trial-users': CAP_TRIAL_USER_READ,

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
  'GET /sites/:siteId/tokens': 'token:read',
  'GET /sites/:siteId/tokens/by-type/:tokenType': 'token:read',
  'GET /sites/:siteId/tokens/:tokenId/grants': 'token:read',

  // Suggestion grants
  'DELETE /sites/:siteId/suggestions/grants/:grantId': CAP_SUGGESTION_WRITE,
};

export default routeRequiredCapabilities;
