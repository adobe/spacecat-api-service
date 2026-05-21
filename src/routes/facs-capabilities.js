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
 * FACS (Federal Access Control Service) per-route required permissions, organised by product.
 *
 * Consumed by `facsWrapper` from `@adobe/spacecat-shared-http-utils` to enforce MAC
 * (Modern Access Control) permissions for external customer users on a route-by-route basis.
 *
 * ## Top-level shape
 *
 * ```
 * {
 *   INTERNAL_ROUTES: ['METHOD /path', ...],
 *   PRODUCTS_ROUTES: {
 *     LLMO: { 'METHOD /path': ['llmo/can_view', 'llmo/can_view_all'], ... },
 *     ASO:  { ... },
 *     ACO:  { ... },
 *   },
 *   PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS: {
 *     LLMO: ['llmo/can_view_all', 'llmo/can_manage_user'],
 *     ASO:  [],
 *     ACO:  [],
 *   },
 *   PRODUCTS_FACS_RESOURCE_PARAM_ALIASES: { LLMO: { brand: ['brandId'] }, ... },
 *   FACS_NON_RESOURCE_PARAMS: [...],
 * }
 * ```
 *
 * `INTERNAL_ROUTES` is the set of routes that are NOT exposed to FACS-governed external
 * customer users at all — these are admin-only endpoints (gated upstream by
 * `hasAdminAccess()` / `hasAdminReadAccess()` in controllers), S2S-only endpoints
 * (gated by capability claim), or pure infrastructure surfaces (webhooks, slack events,
 * hooks, monitoring). They are reachable only via the bypass paths in `facsWrapper`
 * (`is_admin`, `is_s2s_admin`, `is_s2s_consumer`, `is_read_only_admin`, and Adobe
 * internal IMS orgs).
 *
 * `PRODUCTS_ROUTES` is keyed by uppercase SpaceCat product code. Each route value is a
 * **non-empty array** of fully-qualified FACS permissions (any-of semantics). Reads
 * typically list `['llmo/can_view', 'llmo/can_view_all']` so both brand-scoped viewers
 * and org-wide readers are admitted; writes typically list a single permission.
 *
 * `PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS` lists permissions whose holders bypass
 * the Phase 2 state-layer check. The wrapper resolves the held permission with
 * exempt-preference semantics (Option B): if the caller holds any exempt permission the
 * route requires, the wrapper picks that one and skips the state-layer step — regardless
 * of array order. Users with universal grants (e.g. `llmo_manager` holding
 * `llmo/can_view_all`) are therefore never forced through a brand-scoped state-layer
 * row.
 *
 * ## Per-product structure (departure from the original design)
 *
 * The original `mac-state-layer.md` design proposed a single flat map of `route → action`
 * with the product prefix composed at runtime from the `x-product` header. That assumes a
 * shared action vocabulary across all SpaceCat products (LLMO, ASO, ACO, …) and that the
 * same route under different products implies the same permission semantics.
 *
 * In practice each product's MAC policy is authored independently with its own role and
 * permission naming convention. ASO's read-equivalent may be `aso/view` while LLMO's is
 * `llmo/can_view`; some routes only exist for one product. Storing full permission strings
 * per product keeps:
 *   - product roll-outs decoupled (LLMO can ship while ASO policy is still being authored),
 *   - permission naming faithful to each product's MAC policy authoring, and
 *   - the map greppable — searching for `llmo/can_configure` finds every gated route.
 *
 * ## Runtime contract
 *
 * `facsWrapper` reads `x-product` from the request, looks up
 * `routeFacsCapabilities.PRODUCTS_ROUTES[product.toUpperCase()]`, and resolves the route
 * within that product's sub-map. If the route appears in `INTERNAL_ROUTES`, FACS does
 * not apply (the request stands or falls on the upstream admin/S2S gates). A request
 * without `x-product`, or for a product with no sub-map, is treated as not enrolled in
 * FACS and falls through to the existing auth path.
 *
 * ## Deny-by-default within an enrolled product
 *
 * Once a product is enrolled in FACS (its per-product LaunchDarkly flag is on for the org)
 * and the request maps to that product, absence from the product's sub-map means the route
 * is not exposed to external customer users for that product — `facsWrapper` returns 403.
 *
 * ## Invariant
 *
 * For any populated product P: `routes(P) ∪ INTERNAL_ROUTES = all_routes_in_src/routes/index.js`,
 * and `routes(P) ∩ INTERNAL_ROUTES = ∅`. Enforced by `test/routes/facs-capabilities.test.js`.
 *
 * ## Phase 1 scope
 *
 * MAC policy authoring is in progress; the entries below are the initial Phase 1 set agreed
 * with the MAC team for LLMO. ASO and ACO sub-maps are stubbed empty and will be populated
 * as their MAC policies land. See `mysticat-architecture/platform/decisions/mac-state-layer.md`.
 *
 * @type {{INTERNAL_ROUTES: string[], PRODUCTS_ROUTES: Record<string, Record<string, string>>}}
 */
const routeFacsCapabilities = {
  /**
   * Routes excluded from FACS enforcement. Each entry is either:
   *   - admin-only (gated in its controller by `hasAdminAccess()` or `hasAdminReadAccess()`),
   *   - S2S-only / capability-gated (`organization:readAll`, `site:readAll`, etc.),
   *   - restricted (always 403, e.g. `DELETE /sites/:siteId`),
   *   - pure infrastructure (webhooks, slack events, hooks, monitoring, fulfillment, trigger,
   *     ephemeral-run, internal configuration, consumer admin).
   *
   * Inline comment after each entry records the gate so the rationale is greppable.
   */
  INTERNAL_ROUTES: [
    // Admin-only writes
    'POST /sites', // hasAdminAccess
    'DELETE /sites/:siteId', // restricted (always 403)
    'PATCH /sites/:siteId/:auditType', // hasAdminAccess (sites-audits-toggle)
    'POST /sites/:siteId/site-enrollments', // hasAdminAccess
    'POST /projects', // hasAdminAccess
    'DELETE /projects/:projectId', // hasAdminAccess
    'POST /organizations', // hasAdminAccess
    'DELETE /organizations/:organizationId', // restricted (always 403)
    'POST /organizations/:organizationId/entitlements', // hasAdminAccess
    'PUT /organizations/:organizationId/feature-flags/:product/:flagName', // hasAdminAccess
    'DELETE /organizations/:organizationId/feature-flags/:product/:flagName', // hasAdminAccess
    'POST /plg/records', // hasAdminAccess
    'PATCH /plg/records/:plgOnboardingId', // hasAdminAccess
    'DELETE /plg/records/:plgOnboardingId', // hasAdminAccess
    'PATCH /plg/onboard/:onboardingId', // hasAdminAccess
    'PATCH /plg/onboard/:onboardingId/status', // hasAdminAccess

    // Admin-only reads
    'GET /organizations', // admin OR S2S readAll
    'GET /sites', // admin OR S2S readAll
    'GET /sites.csv', // hasAdminReadAccess
    'GET /sites.xlsx', // hasAdminReadAccess
    'GET /sites/by-delivery-type/:deliveryType', // hasAdminReadAccess
    'GET /sites/with-latest-audit/:auditType', // hasAdminReadAccess
    'GET /projects', // hasAdminReadAccess
    'GET /audits/latest/:auditType', // hasAdminReadAccess
    'GET /organizations/by-ims-org-id/:imsOrgId/slack-config', // hasAdminReadAccess
    'GET /plg/sites', // hasAdminAccess
    'GET /admin/users/:userId', // admin surface

    // Pure infrastructure — webhooks / event ingestion / hooks / scheduling
    'POST /event/fulfillment', // external system shared-secret
    'POST /event/fulfillment/:eventType', // external system shared-secret
    'POST /hooks/site-detection/cdn/:hookSecret', // hookSecret in path
    'POST /hooks/site-detection/rum/:hookSecret', // hookSecret in path
    'POST /webhooks/github', // HMAC-signed webhook
    'GET /slack/events', // Slack signature verification
    'POST /slack/events', // Slack signature verification
    'POST /slack/channels/invite-by-user-id', // Slack-internal
    'GET /trigger', // internal scheduler

    // Monitoring / admin telemetry
    'GET /monitoring/drs-bp-pg-audit', // internal monitoring

    // Ephemeral-run admin surface
    'POST /ephemeral-run/batch', // admin/internal
    'GET /ephemeral-run/batch/:batchId/status', // admin/internal

    // System configuration (Configuration model — admin-only)
    'GET /configurations/:version', // admin
    'GET /configurations/latest', // admin
    'PATCH /configurations/latest', // admin
    'PATCH /configurations/latest/handlers/:handlerType', // admin
    'PATCH /configurations/latest/jobs/:jobType', // admin
    'PATCH /configurations/sites/audits', // admin
    'POST /configurations/:version/restore', // admin
    'POST /configurations/audits', // admin
    'DELETE /configurations/audits/:auditType', // admin
    'PUT /configurations/latest/queues', // admin

    // S2S consumer administration
    'GET /consumers', // admin (S2S consumer admin)
    'GET /consumers/:consumerId', // admin
    'GET /consumers/by-client-id/:clientId', // admin
    'PATCH /consumers/:consumerId', // admin
    'POST /consumers/:consumerId/revoke', // admin
    'POST /consumers/register', // admin
  ],

  PRODUCTS_ROUTES: {
  // LLMO — first product to enrol in FACS.
  //
  // Permission names follow the agreed LLMO MAC policy:
  //   - llmo/can_view         — read-only
  //   - llmo/can_configure    — edit/add/delete prompts, topics, categories,
  //                             aliases, competitors, customer intent, strategy,
  //                             sheet data, site config
  //   - llmo/can_onboard      — brands, URLs, integrations (analytics, CMS, CDN)
  //   - llmo/can_deploy       — optimizations (edge/source)
  //   - llmo/can_manage_user  — add/delete user, assign capabilities, assign roles
  //                             (Phase 2: state layer management endpoints will
  //                             land under /facs/access-mappings)
  //
  // POST endpoints that are body-based queries (no side effects beyond a read /
  // export) are mapped to `can_view`. Writes are categorised by their domain
  // (configure vs onboard vs deploy), not by HTTP verb.
    LLMO: {
    // ---- Onboard / integrations ----------------------------------------
      'POST /llmo/onboard': ['llmo/can_onboard'],
      'POST /llmo/onboard/update-query-index': ['llmo/can_onboard'],
      'POST /sites/:siteId/llmo/offboard': ['llmo/can_onboard'],
      'PATCH /sites/:siteId/llmo/cdn-logs-bucket-config': ['llmo/can_onboard'],
      'PATCH /sites/:siteId/llmo/cdn-logs-filter': ['llmo/can_onboard'],

      // ---- Configure -----------------------------------------------------
      // Site-level LLMO config
      'POST /sites/:siteId/llmo/config': ['llmo/can_configure'],
      'PATCH /sites/:siteId/llmo/config': ['llmo/can_configure'],
      // Customer intent
      'POST /sites/:siteId/llmo/customer-intent': ['llmo/can_configure'],
      'PATCH /sites/:siteId/llmo/customer-intent/:intentKey': ['llmo/can_configure'],
      'DELETE /sites/:siteId/llmo/customer-intent/:intentKey': ['llmo/can_configure'],
      // Prompts (questions)
      'POST /sites/:siteId/llmo/questions': ['llmo/can_configure'],
      'PATCH /sites/:siteId/llmo/questions/:questionKey': ['llmo/can_configure'],
      'DELETE /sites/:siteId/llmo/questions/:questionKey': ['llmo/can_configure'],
      // Strategy / opportunity review (state changes against configured content)
      'PUT /sites/:siteId/llmo/strategy': ['llmo/can_configure'],
      'PUT /sites/:siteId/llmo/opportunities-reviewed': ['llmo/can_configure'],

      // ---- Deploy --------------------------------------------------------
      // Edge-source optimization writes. Read-side endpoints stay under can_view.
      'POST /sites/:siteId/llmo/edge-optimize-config': ['llmo/can_deploy'],
      'POST /sites/:siteId/llmo/edge-optimize-config/stage': ['llmo/can_deploy'],

      // ---- View (read-only) ----------------------------------------------
      // Top-level LLMO surfaces
      'GET /v2/regions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/agentic-traffic/global': ['llmo/can_view', 'llmo/can_view_all'],
      // Body-based queries that read sheet data (S2S: site:read).
      'POST /sites/:siteId/llmo/sheet-data/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],

      // AI visibility
      'GET /llmo/ai-visibility/brands/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/cited-pages': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/topic-opportunities': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/top-brands': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/cited-sources': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/source-opportunities': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/brands/competitors': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/competitors/metrics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/competitors/gap-topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/competitors/gap-source-domains': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/competitors/gap-prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/meta': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/prompts/responses/latest': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/prompts/responses': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/research/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/research/prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/research/brands': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/research/source-domains': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/research': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/topics/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/v1/topic/brand-topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /llmo/ai-visibility/v1/prompt/brand-prompts': ['llmo/can_view', 'llmo/can_view_all'],

      // Brand presence — org-scoped, includes "all" and per-brand variants
      'GET /org/:spaceCatId/brands/:brandId/fanout-report': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/weeks': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/weeks': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-overview': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/market-tracking-trends': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/competitor-summary': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/competitor-summary': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/prompt-execution-status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompt-execution-status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/search': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/search': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/prompts/:promptId/detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompts/:promptId/detail': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/executions/:executionId/sources': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/executions/:executionId/sources': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-movers': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/share-of-voice': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/stats': ['llmo/can_view', 'llmo/can_view_all'],

      // URL inspector — read-only under brand presence
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/domain-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/domain-urls': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/url-prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/url-prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],

      // Opportunities — org-scoped reads
      'GET /org/:spaceCatId/opportunities/count': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/all/opportunities': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /org/:spaceCatId/brands/:brandId/opportunities': ['llmo/can_view', 'llmo/can_view_all'],

      // Agentic traffic (site-scoped)
      'GET /sites/:siteId/agentic-traffic/kpis': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/kpis-trend': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-region': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-category': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-page-type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-user-agent': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/by-url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/url-brand-presence': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/weeks': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/movers': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/has-data': ['llmo/can_view', 'llmo/can_view_all'],
      // Export — kicks off a data export job; read-only access semantics.
      'POST /sites/:siteId/agentic-traffic/urls/export': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/agentic-traffic/urls/export/:exportId': ['llmo/can_view', 'llmo/can_view_all'],

      // Referral traffic (site-scoped)
      'GET /sites/:siteId/referral-traffic/kpis': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/trend': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-region': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-page-intent': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/by-url-trend': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/business-impact': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/filter-dimensions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/weeks': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/referral-traffic/has-data': ['llmo/can_view', 'llmo/can_view_all'],

      // Site LLMO surfaces — read side
      'GET /sites/:siteId/llmo/brand-claims': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/config': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/customer-intent': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/data': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/data/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/data/:sheetType/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/data/:sheetType/:week/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/edge-optimize-config': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/edge-optimize-status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/global-sheet-data/:configName': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/probes/edge-optimize': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/questions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/rationale': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/sheet-data/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/strategy': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/strategy/demo/brand-presence': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/llmo/strategy/demo/recommendations': ['llmo/can_view', 'llmo/can_view_all'],

      // ===================================================================
      // Cross-product routes — LLMO customers also call these. Deny-by-default
      // in facsWrapper means anything an LLMO customer can plausibly hit must be
      // declared here. Internal-only surfaces (admin/*, configurations/*,
      // consumers/*, event/*, hooks/*, webhooks/*, slack/*, trigger,
      // monitoring/*, ephemeral-run/*) are intentionally omitted and remain
      // accessible only to internal identities (which bypass facsWrapper).
      // ===================================================================

      // ---- Onboard (creation + integrations) -----------------------------
      // Admin-only creators (POST /sites, POST /projects, POST /organizations,
      // POST /sites/:siteId/site-enrollments) are intentionally omitted —
      // those handlers gate on `hasAdminAccess()` and are not reachable by
      // external customers. They stay accessible to internal identities via
      // facsWrapper's admin bypass.
      'POST /sites/:siteId/brand-profile': ['llmo/can_onboard'],
      'POST /v2/orgs/:spaceCatId/brands': ['llmo/can_onboard'],
      'POST /v2/orgs/:spaceCatId/sites/:siteId/sync-config': ['llmo/can_onboard'],
      'POST /plg/onboard': ['llmo/can_onboard'],
      'PATCH /sites/:siteId/config/cdn-logs': ['llmo/can_onboard'],

      // ---- Deploy (edge optimizations + auto-fix) ------------------------
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy': ['llmo/can_deploy'],
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview': ['llmo/can_deploy'],
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview': ['llmo/can_deploy'],
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback': ['llmo/can_deploy'],
      'POST /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/actions/rolled_back': ['llmo/can_deploy'],
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': ['llmo/can_deploy'],

      // ---- Configure (default for writes that aren't onboard/deploy) -----
      // Admin-only writes live in INTERNAL_ROUTES above and bypass FACS entirely.
      // DELETE
      'DELETE /sites/:siteId/geo-experiments/:geoExperimentId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/ims-org-access/:accessId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/opportunities/:opportunityId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/reports/:reportId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/sentiment/guidelines/:guidelineId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/sentiment/topics/:topicId': ['llmo/can_configure'],
      'DELETE /sites/:siteId/suggestions/grants/:grantId': ['llmo/can_configure'],
      'DELETE /tools/api-keys/:id': ['llmo/can_configure'],
      'DELETE /tools/import/jobs/:jobId': ['llmo/can_configure'],
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId': ['llmo/can_configure'],
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': ['llmo/can_configure'],
      'DELETE /v2/orgs/:spaceCatId/categories/:categoryId': ['llmo/can_configure'],
      'DELETE /v2/orgs/:spaceCatId/topics/:topicId': ['llmo/can_configure'],
      // PATCH
      'PATCH /contact-sales-leads/:contactSalesLeadId': ['llmo/can_configure'],
      'PATCH /organizations/:organizationId': ['llmo/can_configure'],
      'PATCH /projects/:projectId': ['llmo/can_configure'],
      'PATCH /sites/:siteId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/geo-experiments/:geoExperimentId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/opportunities/:opportunityId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/opportunities/:opportunityId/status': ['llmo/can_configure'],
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': ['llmo/can_configure'],
      'PATCH /sites/:siteId/reports/:reportId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/sentiment/guidelines/:guidelineId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/sentiment/topics/:topicId': ['llmo/can_configure'],
      'PATCH /sites/:siteId/url-store': ['llmo/can_configure'],
      'PATCH /tools/import/jobs/:jobId': ['llmo/can_configure'],
      'PATCH /trial-users/email-preferences': ['llmo/can_configure'],
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId': ['llmo/can_configure'],
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': ['llmo/can_configure'],
      'PATCH /v2/orgs/:spaceCatId/categories/:categoryId': ['llmo/can_configure'],
      'PATCH /v2/orgs/:spaceCatId/topics/:topicId': ['llmo/can_configure'],
      // POST (non-onboard, non-deploy, non-query)
      'POST /consent-banner': ['llmo/can_configure'],
      'POST /organizations/:organizationId/sites/:siteId/contact-sales-lead': ['llmo/can_configure'],
      'POST /organizations/:organizationId/trial-user-invite': ['llmo/can_configure'],
      'POST /preflight/beta/jobs': ['llmo/can_configure'],
      'POST /preflight/jobs': ['llmo/can_configure'],
      'POST /sites/:siteId/graph': ['llmo/can_configure'],
      'POST /sites/:siteId/ims-org-access': ['llmo/can_configure'],
      'POST /sites/:siteId/opportunities': ['llmo/can_configure'],
      'POST /sites/:siteId/opportunities/:opportunityId/fixes': ['llmo/can_configure'],
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions': ['llmo/can_configure'],
      'POST /sites/:siteId/reports': ['llmo/can_configure'],
      'POST /sites/:siteId/sandbox/audit': ['llmo/can_configure'],
      'POST /sites/:siteId/sentiment/guidelines': ['llmo/can_configure'],
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits': ['llmo/can_configure'],
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits/unlink': ['llmo/can_configure'],
      'POST /sites/:siteId/sentiment/topics': ['llmo/can_configure'],
      'POST /sites/:siteId/url-store': ['llmo/can_configure'],
      'POST /sites/:siteId/url-store/delete': ['llmo/can_configure'],
      'POST /sites/:siteId/user-activities': ['llmo/can_configure'],
      'POST /sites/detect/jobs': ['llmo/can_configure'],
      'POST /tools/api-keys': ['llmo/can_configure'],
      'POST /tools/import/jobs': ['llmo/can_configure'],
      'POST /tools/import/jobs/:jobId/result': ['llmo/can_configure'],
      'POST /tools/scrape/jobs': ['llmo/can_configure'],
      'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts': ['llmo/can_configure'],
      'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete': ['llmo/can_configure'],
      'POST /v2/orgs/:spaceCatId/categories': ['llmo/can_configure'],
      'POST /v2/orgs/:spaceCatId/topics': ['llmo/can_configure'],
      // POSTs that S2S confirms are :write (not body-based queries).
      'POST /llmo/agentic-traffic/global': ['llmo/can_configure'],
      'POST /sites/:siteId/traffic/predominant-type': ['llmo/can_configure'],
      'POST /sites/:siteId/traffic/predominant-type/:channel': ['llmo/can_configure'],

      // ---- Manage user (Phase 2 state-layer management) -----------------
      // Customer org admins assign / revoke ReBAC grants via these endpoints.
      // Also listed in required-capabilities.INTERNAL_ROUTES — never S2S.
      // Listing is gated the same as writes: viewing who has access to what
      // is itself a sensitive operation that only org admins should see.
      'GET /facs/access-mappings': ['llmo/can_manage_user'],
      'POST /facs/access-mappings': ['llmo/can_manage_user'],
      'DELETE /facs/access-mappings': ['llmo/can_manage_user'],
      'DELETE /facs/access-mappings/:id': ['llmo/can_manage_user'],

      // ---- View (read-only) ----------------------------------------------
      // Cross-product GETs + POSTs that are body-based queries (no side
      // effects beyond a read / lookup). Admin-only reads live in
      // INTERNAL_ROUTES above and bypass FACS entirely.
      'GET /consent-banner/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/brands': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/by-project-name/:projectName/sites': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/contact-sales-leads': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/entitlements': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/feature-flags': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/projects': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/projects/:projectId/sites': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/sites': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/sites/:siteId/contact-sales-lead': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/trial-users': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/:organizationId/userDetails/:externalUserId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /organizations/by-ims-org-id/:imsOrgId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /plg/onboard/status/:imsOrgId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /preflight/beta/jobs/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /preflight/jobs/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /projects/:projectId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /projects/:projectId/sites': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /projects/:projectId/sites/primary-locale': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /projects/by-project-name/:projectName/sites': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites-resolve': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/audits': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/audits/:auditType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/audits/:auditType/:auditedAt': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/audits/latest': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/bot-blocker': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/brand-guidelines': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/brand-profile': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/experiments': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/files': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/geo-experiments': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/geo-experiments/:geoExperimentId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/ims-org-access': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/ims-org-access/:accessId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/latest-audit/:auditType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/latest-metrics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/metadata': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/metrics/:metric/:source': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/fixes': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit/:cursor': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit/:cursor': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/by-status/:status': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/opportunities/top-paid': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/page-citability/counts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/reports': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/reports/:reportId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/scraped-content/:type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/sentiment/config': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/sentiment/guidelines': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/sentiment/guidelines/:guidelineId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/sentiment/topics': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/sentiment/topics/:topicId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/site-enrollments': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/tokens': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/tokens/:tokenId/grants': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/tokens/by-type/:tokenType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/top-pages': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/top-pages/:source': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/top-pages/:source/:geo': ['llmo/can_view', 'llmo/can_view_all'],
      // Paid traffic (cross-product reads)
      'GET /sites/:siteId/traffic/paid': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-channel-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/campaign-url-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/channel-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/channel-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/display-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/display-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/impact-by-page': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/impact-by-page-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-campaign-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/page-type-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/pta2/weekly-summary': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/search-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/search-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/social-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/social-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/traffic-loss-by-devices': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type-channel-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/type-device-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-channel': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-channel-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-channel-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/video-platform': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/traffic/paid/video-platform-device': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/url-store': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/url-store/:base64Url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/url-store/by-audit/:auditType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/:siteId/user-activities': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/by-base-url/:baseURL': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /sites/detect/jobs/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/api-keys': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/import/jobs/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/import/jobs/:jobId/progress': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/:jobId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/:jobId/results': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/by-base-url/:baseURL': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/by-url/:url': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /tools/scrape/jobs/by-url/:url/:processingType': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /trial-users/email-preferences': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/brands': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/brands/:brandId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/categories': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/sites/:siteId/brand': ['llmo/can_view', 'llmo/can_view_all'],
      'GET /v2/orgs/:spaceCatId/topics': ['llmo/can_view', 'llmo/can_view_all'],
      // POST as query / bulk-read (S2S confirms these are :read).
      'POST /organizations/:organizationId/userDetails': ['llmo/can_view', 'llmo/can_view_all'],
      'POST /sites/:siteId/page-relationships/search': ['llmo/can_view', 'llmo/can_view_all'],
      // Autofix check returns recommendations without applying them
      // (S2S: site:read).
      'POST /sites/:siteId/autofix-checks': ['llmo/can_view', 'llmo/can_view_all'],

    // ---- Manage user --------------------------------------------------
    // Phase 2: state-layer management endpoints (`/facs/access-mappings/*`)
    // and any LLMO-scoped role/capability assignment endpoints land here.
    // Intentionally empty for Phase 1 (the user-management routes that
    // exist today, e.g. POST /organizations/:organizationId/trial-user-invite,
    // are mapped to `can_configure` until a dedicated permission lands).
    },

    // ASO — TBD. MAC policy authoring for ASO is pending; routes will be added
    // once the permission set is agreed. Until then, the absent/empty sub-map
    // means ASO is not enrolled in FACS regardless of LaunchDarkly state.
    ASO: {
    },

    // ACO — TBD. Same status as ASO.
    ACO: {
    },
  },

  /**
   * Phase 2: per-product map of FACS-controlled resources → list of param
   * aliases that identify each resource in the route surface. Each product
   * decides independently which resources go through the state-layer
   * (ReBAC) check. Phase 2 starts with LLMO/brand only.
   *
   * Adding `siteId`, `organizationId`, etc. into a product's map graduates
   * those params from `FACS_NON_RESOURCE_PARAMS` below — the coverage test
   * enforces exhaustive classification.
   *
   * See mac-state-layer.md §"Resource Identification".
   */
  /**
   * Per-product list of permissions whose holders bypass the Phase 2
   * state-layer (ReBAC) check. When `facsWrapper` resolves the held
   * permission to one of these, the resource-resolution + PostgREST
   * lookup are skipped entirely.
   *
   * The wrapper picks an exempt permission whenever the caller holds one
   * the route requires (regardless of listing order), so users with
   * universal grants (e.g. `llmo_manager` holding `can_view_all`) are not
   * incorrectly forced through a brand-scoped state-layer row.
   *
   * For LLMO:
   *   - `llmo/can_view_all`     — org-wide read; no per-brand row needed.
   *   - `llmo/can_manage_user`  — gates the management endpoints
   *                                 (`/facs/access-mappings*`); the state
   *                                 layer cannot recurse into itself.
   *
   * See mac-state-layer.md §"State-layer-exempt permissions" and
   * §"Routes can require any-of multiple permissions".
   */
  PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS: {
    LLMO: ['llmo/can_view_all', 'llmo/can_manage_user'],
    ASO: [],
    ACO: [],
  },

  PRODUCTS_FACS_RESOURCE_PARAM_ALIASES: {
    LLMO: {
      brand: ['brandId'],
    },
    ASO: {},
    ACO: {},
  },

  /**
   * Every `:param` from `src/routes/index.js` that no product currently
   * treats as a FACS resource. Together with the union of every product's
   * resource aliases above, this exhaustively classifies every `:param`
   * in the route surface — enforced by
   * `test/routes/facs-capabilities.test.js`.
   *
   * Classification rule (each `:param` is in EXACTLY ONE bucket):
   *   - in some product's resource map → ReBAC for that product
   *   - here in FACS_NON_RESOURCE_PARAMS → no product gates on it
   *   - never both, never neither
   *
   * siteId / organizationId / orgId / spaceCatId / projectId live here
   * while their resources are out of Phase 2 scope; they move into
   * PRODUCTS_FACS_RESOURCE_PARAM_ALIASES when a product brings them
   * into ReBAC.
   */
  FACS_NON_RESOURCE_PARAMS: [
    // Domain identifiers / sub-resource ids — never independently
    // ReBAC-controlled at the wrapper layer:
    'auditType', 'auditedAt', 'categoryId', 'configName', 'executionId',
    'fixId', 'geoExperimentId', 'guidelineId', 'intentKey',
    'jobId', 'jobType', 'onboardingId', 'opportunityId', 'plgOnboardingId',
    'promptId', 'questionKey', 'reportId', 'suggestionId', 'tokenId',
    'topicId',
    // Resources not yet in any product's FACS scope (graduate to a product
    // map when ReBAC is added):
    'siteId', 'organizationId', 'spaceCatId', 'projectId',
    // External / shared identifiers:
    'accessId', 'batchId', 'clientId', 'consumerId', 'contactSalesLeadId',
    'externalUserId', 'imsOrgId', 'grantId', 'userId',
    // Filter / pagination / format params (not entities):
    'base64PageUrl', 'base64Url', 'baseURL', 'channel', 'cursor',
    'dataSource', 'deliveryType', 'endDate', 'eventType',
    'exportId', 'flagName', 'geo', 'handlerType', 'hookSecret', 'limit',
    'metric', 'processingType', 'product', 'projectName',
    'sheetType', 'source', 'startDate', 'status', 'tokenType', 'type',
    'url', 'version', 'week',
    // Single-row id used by the Phase 2 state-layer management endpoints
    // (the row's own UUID, never a resource being granted).
    'id',
  ],
};

export default routeFacsCapabilities;
