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
 * FACS (Federal Access Control Service) per-route required capability map,
 * organised by product.
 *
 * Consumed by `facsWrapper` from `@adobe/spacecat-shared-http-utils` to enforce
 * the **hybrid permission model** for external customer users on a
 * route-by-route basis. See:
 *   - `mysticat-architecture/platform/decisions/rebac-hybrid-permission-model.md`
 *   - `mysticat-architecture/platform/decisions/mac-state-layer.md`
 *     (§"State Layer Schema", §"State Layer Evaluation Engine",
 *     §"Capability catalog", §"Components + Deploy Ordering")
 *
 * ## Top-level shape
 *
 * ```
 * {
 *   INTERNAL_ROUTES: ['METHOD /path', ...],
 *   PRODUCTS_ROUTES: {
 *     LLMO: { 'METHOD /path': 'llmo/can_view', ... },   // single capability string
 *     ASO:  { ... },
 *     ACO:  { ... },
 *   },
 *   PRODUCTS_FACS_RESOURCE_PARAM_ALIASES: { LLMO: { brand: ['brandId'] }, ... },
 *   FACS_NON_RESOURCE_PARAMS: [...],
 * }
 * ```
 *
 * `INTERNAL_ROUTES` is the set of routes NOT exposed to FACS-governed external
 * customer users at all — admin-only endpoints (gated upstream by
 * `hasAdminAccess()` / `hasAdminReadAccess()` in controllers), S2S-only
 * endpoints (gated by capability claim), or pure infrastructure surfaces
 * (webhooks, slack events, hooks, monitoring). They are reachable only via the
 * bypass paths in `facsWrapper` (`is_admin`, `is_s2s_admin`, `is_s2s_consumer`,
 * `is_read_only_admin`, and Adobe internal IMS orgs).
 *
 * `PRODUCTS_ROUTES` is keyed by uppercase SpaceCat product code. Each route
 * value is a **single** fully-qualified `<product>/<capability>` string —
 * the capability the route guards. The hybrid model collapsed the previous
 * any-of array semantics: one route guards one capability.
 *
 * ## Hybrid permission model — runtime rule
 *
 *     effectiveCapabilities(user, resource, product) =
 *         JWT.facs_permissions(user, product)               -- universal grants
 *       ∪ state.granted_capabilities(user, resource, product) -- per-resource grants
 *       ∪ state.granted_capabilities(org,  resource, product) -- org-wide grants
 *
 *     admit iff routeCapability ∈ effectiveCapabilities
 *
 * Grants are additive and grant-only. Org-wide viewers (previously holding a
 * `can_view_all` claim) now receive a state-layer org-scoped row carrying
 * `granted_capabilities=['llmo/can_view']` — the wrapper unions that with the
 * JWT and admits a `can_view`-gated route without per-brand bindings.
 *
 * The previous `PRODUCTS_FACS_ADMIN_PERMISSIONS` and
 * `PRODUCTS_FACS_STATE_LAYER_EXEMPT_PERMISSIONS` config keys are removed:
 * universal grants now flow through `JWT.facs_permissions` and/or state-layer
 * org-scoped bindings; product admins are users who hold `can_manage_users`
 * plus an unrestricted capability set delivered via either layer.
 *
 * ## Per-product structure (departure from the original design)
 *
 * The original `mac-state-layer.md` design proposed a single flat map of
 * `route → action` with the product prefix composed at runtime from the
 * `x-product` header. That assumes a shared action vocabulary across all
 * SpaceCat products (LLMO, ASO, ACO, …) and that the same route under different
 * products implies the same capability semantics.
 *
 * In practice each product's MAC policy is authored independently with its own
 * role and capability naming convention. ASO's read-equivalent may be
 * `aso/view` while LLMO's is `llmo/can_view`; some routes only exist for one
 * product. Storing full capability strings per product keeps:
 *   - product roll-outs decoupled (LLMO can ship while ASO policy is still
 *     being authored),
 *   - capability naming faithful to each product's MAC policy authoring, and
 *   - the map greppable — searching for `llmo/can_configure` finds every gated
 *     route.
 *
 * ## Runtime contract
 *
 * `facsWrapper` reads `x-product` from the request, looks up
 * `routeFacsCapabilities.PRODUCTS_ROUTES[product.toUpperCase()]`, and resolves
 * the route within that product's sub-map. If the route appears in
 * `INTERNAL_ROUTES`, FACS does not apply (the request stands or falls on the
 * upstream admin/S2S gates). A request without `x-product`, or for a product
 * with no sub-map, is treated as not enrolled in FACS and falls through to the
 * existing auth path.
 *
 * ## Deny-by-default within an enrolled product
 *
 * Once a product is enrolled in FACS (its per-product LaunchDarkly flag is on
 * for the org) and the request maps to that product, absence from the product's
 * sub-map means the route is not exposed to external customer users for that
 * product — `facsWrapper` returns 403.
 *
 * ## Invariant — union-equality model
 *
 *   (∪ PRODUCTS_ROUTES[*]) ⊎ INTERNAL_ROUTES = all_routes_in_src/routes/index.js
 *
 * Disjoint union: every route belongs either to **at least one product**
 * sub-map OR to `INTERNAL_ROUTES`, never both. Routes CAN appear under
 * multiple products simultaneously (e.g. `GET /sites/:siteId` appears under
 * both LLMO and ASO as `can_view`) — cross-product routes are expected
 * because the same URL surface is reachable under any product header that
 * has been enrolled. There is no pairwise-disjoint product rule.
 *
 * `INTERNAL_ROUTES` is a single shared list of admin / S2S / infrastructure
 * routes that no external customer reaches under any product header.
 *
 * Enforced by `test/routes/facs-capabilities.test.js`.
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
    // ASO redirect overlay — authenticated by X-ASO-API-Key, not a FACS user.
    'GET /config/:service/redirects.txt',
    // LLMO onboarding — internal/manual provisioning flow, not a customer FACS surface.
    'POST /v2/orgs/:spaceCatId/llmo/onboard-site',
    // LLMO CloudFront "Optimize at Edge" onboarding wizard — admin-only
    // (gateEdgeOptimizeWizard requires LLMO admin); cross-account control-plane, not a
    // customer FACS surface.
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
    // LLMO Cloudflare onboarding — LLMO-admin manual provisioning, gated by
    // isLLMOAdministrator() with a caller-supplied x-cloudflare-token; not a FACS surface.
    'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/config',
    'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/accounts',
    'GET /sites/:siteId/llmo/cdn-onboard/cloudflare/zones',
    'POST /sites/:siteId/llmo/cdn-onboard/cloudflare/deploy',
    'POST /sites/:siteId/llmo/cdn-onboard/cloudflare/routes',
    // Admin-only writes
    'POST /sites', // hasAdminAccess
    'DELETE /sites/:siteId', // restricted (always 403)
    'PATCH /sites/:siteId/:auditType', // hasAdminAccess (sites-audits-toggle)
    'POST /sites/:siteId/site-enrollments', // hasAdminAccess
    'POST /sites/:siteId/entitlements', // hasAdminAccess
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

    // Internal proxy tool
    'GET /tools/proxy', // internal preview proxy (no external auth required)

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
  // Capability names follow the agreed LLMO MAC policy:
  //   - llmo/can_view          — read-only
  //   - llmo/can_configure     — edit/add/delete prompts, topics, categories,
  //                              aliases, competitors, customer intent, strategy,
  //                              sheet data, site config
  //   - llmo/can_onboard       — brands, URLs, integrations (analytics, CMS, CDN)
  //   - llmo/can_deploy        — optimizations (edge/source)
  //   - llmo/can_manage_users  — state-layer management: assign / revoke
  //                              per-resource bindings, view product capability
  //                              catalog, view a user's effective capability
  //                              set. Plural per the hybrid-model capability
  //                              catalog (was `can_manage_user`).
  //
  // Org-wide viewers (previously gated on `llmo/can_view_all`) now hold an
  // org-scoped state-layer row carrying `granted_capabilities=['llmo/can_view']`.
  // The wrapper unions that with the JWT, so a single `can_view` value here
  // admits both per-brand viewers and org-wide readers. `can_view_all` is no
  // longer part of the LLMO capability catalog.
  //
  // POST endpoints that are body-based queries (no side effects beyond a read /
  // export) are mapped to `can_view`. Writes are categorised by their domain
  // (configure vs onboard vs deploy), not by HTTP verb.
    LLMO: {
    // ---- Onboard / integrations ----------------------------------------
      'POST /llmo/onboard': 'llmo/can_onboard',
      'POST /llmo/onboard/update-query-index': 'llmo/can_onboard',
      'POST /sites/:siteId/llmo/offboard': 'llmo/can_onboard',
      'PATCH /sites/:siteId/llmo/cdn-logs-bucket-config': 'llmo/can_onboard',
      'PATCH /sites/:siteId/llmo/cdn-logs-filter': 'llmo/can_onboard',

      // ---- Configure -----------------------------------------------------
      // Site-level LLMO config
      'POST /sites/:siteId/llmo/config': 'llmo/can_configure',
      'PATCH /sites/:siteId/llmo/config': 'llmo/can_configure',
      // Site-level scraper config — a site write surfaced through the
      // generic /config namespace rather than under /llmo/, but
      // configuration nonetheless.
      'PATCH /sites/:siteId/config/scraper': 'llmo/can_configure',
      // Customer intent
      'POST /sites/:siteId/llmo/customer-intent': 'llmo/can_configure',
      'PATCH /sites/:siteId/llmo/customer-intent/:intentKey': 'llmo/can_configure',
      'DELETE /sites/:siteId/llmo/customer-intent/:intentKey': 'llmo/can_configure',
      // Prompts (questions)
      'POST /sites/:siteId/llmo/questions': 'llmo/can_configure',
      'PATCH /sites/:siteId/llmo/questions/:questionKey': 'llmo/can_configure',
      'DELETE /sites/:siteId/llmo/questions/:questionKey': 'llmo/can_configure',
      // Strategy / opportunity review (state changes against configured content)
      'PUT /sites/:siteId/llmo/strategy': 'llmo/can_configure',
      'PUT /sites/:siteId/llmo/opportunities-reviewed': 'llmo/can_configure',

      // ---- Deploy --------------------------------------------------------
      // Edge-source optimization writes. Read-side endpoints stay under can_view.
      'POST /sites/:siteId/llmo/edge-optimize-config': 'llmo/can_deploy',
      'POST /sites/:siteId/llmo/edge-optimize-config/stage': 'llmo/can_deploy',

      // ---- View (read-only) ----------------------------------------------
      // Top-level LLMO surfaces
      'GET /v2/regions': 'llmo/can_view',
      'GET /llmo/agentic-traffic/global': 'llmo/can_view',
      // Body-based queries that read sheet data (S2S: site:read).
      'POST /sites/:siteId/llmo/sheet-data/:dataSource': 'llmo/can_view',
      'POST /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': 'llmo/can_view',
      'POST /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': 'llmo/can_view',

      // AI visibility
      'GET /llmo/ai-visibility/brands/stats': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/topics': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/prompts': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/cited-pages': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/topic-opportunities': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/top-brands': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/cited-sources': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/source-opportunities': 'llmo/can_view',
      'GET /llmo/ai-visibility/brands/competitors': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/brand/stats-by-country': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/brand/stats-by-llm': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/meta/meta': 'llmo/can_view',
      'GET /llmo/ai-visibility/competitors/metrics': 'llmo/can_view',
      'GET /llmo/ai-visibility/meta': 'llmo/can_view',
      'GET /llmo/ai-visibility/prompts/responses/latest': 'llmo/can_view',
      'GET /llmo/ai-visibility/prompts/responses': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/research/stats': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/research/prompts': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/research/brands': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/research/source-domains': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/research': 'llmo/can_view',
      'GET /llmo/ai-visibility/topics/stats': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/brand-topics': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/gap-topics': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/brand-prompts': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/gap-prompts': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/prompt-response': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/brand-topics-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/brand-topics-totals': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/gap-topics-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/topic/gap-topics-totals': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/brand-prompts-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/gap-prompts-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt/gap-prompts-totals': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/source/gap-source-domains': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/source/gap-source-domains-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/source/gap-source-domains-totals': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt-research/prompts-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt-research/brands-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt-research/source-domains-export': 'llmo/can_view',
      'GET /llmo/ai-visibility/v1/prompt-research/topics-export': 'llmo/can_view',

      // Brand presence — org-scoped, includes "all" and per-brand variants.
      // Org-wide "all" reads are admitted via an org-scoped state-layer row
      // carrying `granted_capabilities=['llmo/can_view']` (no separate
      // `can_view_all` capability anymore).
      'GET /org/:spaceCatId/brands/:brandId/fanout-report': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/filter-dimensions': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/weeks': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/weeks': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-overview': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/market-tracking-trends': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/competitor-summary': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/competitor-summary': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/topics': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/prompt-execution-status': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompt-execution-status': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/search': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/search': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/prompts/:promptId/detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/prompts/:promptId/detail': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/executions/:executionId/sources': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/executions/:executionId/sources': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/sentiment-movers': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/share-of-voice': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/stats': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/stats': 'llmo/can_view',

      // URL inspector — read-only under brand presence
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/stats': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/domain-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/domain-urls': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/url-prompts': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/url-prompts': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/filter-dimensions': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/filter-dimensions': 'llmo/can_view',

      // Opportunities — org-scoped reads
      'GET /org/:spaceCatId/opportunities/count': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/all/opportunities': 'llmo/can_view',
      'GET /org/:spaceCatId/brands/:brandId/opportunities': 'llmo/can_view',

      // Agentic traffic (site-scoped)
      'GET /sites/:siteId/agentic-traffic/kpis': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/kpis-trend': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-region': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-category': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-page-type': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-status': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-user-agent': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/by-url': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/url-brand-presence': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/filter-dimensions': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/weeks': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/movers': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/has-data': 'llmo/can_view',
      // Batch read of hits for a set of URLs; read-only access semantics.
      'POST /sites/:siteId/agentic-traffic/hits-by-urls': 'llmo/can_view',
      // Export — kicks off a data export job; read-only access semantics.
      'POST /sites/:siteId/agentic-traffic/urls/export': 'llmo/can_view',
      'GET /sites/:siteId/agentic-traffic/urls/export/:exportId': 'llmo/can_view',

      // Agentic categories / page types — meta-data used to classify site
      // content for agentic AI analysis.  :name is the category/page-type
      // identifier (non-resource param — see FACS_NON_RESOURCE_PARAMS).
      'GET /sites/:siteId/agentic-categories': 'llmo/can_view',
      'POST /sites/:siteId/agentic-categories': 'llmo/can_configure',
      'PATCH /sites/:siteId/agentic-categories/:name': 'llmo/can_configure',
      'DELETE /sites/:siteId/agentic-categories/:name': 'llmo/can_configure',
      'GET /sites/:siteId/agentic-page-types': 'llmo/can_view',
      'POST /sites/:siteId/agentic-page-types': 'llmo/can_configure',
      'PATCH /sites/:siteId/agentic-page-types/:name': 'llmo/can_configure',
      'DELETE /sites/:siteId/agentic-page-types/:name': 'llmo/can_configure',

      // Referral traffic (site-scoped)
      'GET /sites/:siteId/referral-traffic/kpis': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/trend': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-device': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-platform': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-region': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-page-intent': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-url': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/by-url-trend': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/business-impact': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/filter-dimensions': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/weeks': 'llmo/can_view',
      'GET /sites/:siteId/referral-traffic/has-data': 'llmo/can_view',

      // Site LLMO surfaces — read side
      'GET /sites/:siteId/llmo/brand-claims': 'llmo/can_view',
      'GET /sites/:siteId/llmo/config': 'llmo/can_view',
      'GET /sites/:siteId/llmo/customer-intent': 'llmo/can_view',
      'GET /sites/:siteId/llmo/data': 'llmo/can_view',
      'GET /sites/:siteId/llmo/data/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/data/:sheetType/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/data/:sheetType/:week/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/edge-optimize-config': 'llmo/can_view',
      'GET /sites/:siteId/llmo/edge-optimize-status': 'llmo/can_view',
      'GET /sites/:siteId/llmo/global-sheet-data/:configName': 'llmo/can_view',
      'GET /sites/:siteId/llmo/probes/edge-optimize': 'llmo/can_view',
      'GET /sites/:siteId/llmo/questions': 'llmo/can_view',
      'GET /sites/:siteId/llmo/rationale': 'llmo/can_view',
      'GET /sites/:siteId/llmo/sheet-data/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/sheet-data/:sheetType/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/sheet-data/:sheetType/:week/:dataSource': 'llmo/can_view',
      'GET /sites/:siteId/llmo/strategy': 'llmo/can_view',
      'GET /sites/:siteId/llmo/strategy/demo/brand-presence': 'llmo/can_view',
      'GET /sites/:siteId/llmo/strategy/demo/recommendations': 'llmo/can_view',

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
      'POST /sites/:siteId/brand-profile': 'llmo/can_onboard',
      'POST /v2/orgs/:spaceCatId/brands': 'llmo/can_onboard',
      'POST /plg/onboard': 'llmo/can_onboard',
      'PATCH /sites/:siteId/config/cdn-logs': 'llmo/can_onboard',

      // ---- Deploy (edge optimizations + auto-fix) ------------------------
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy': 'llmo/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview': 'llmo/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview': 'llmo/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback': 'llmo/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/actions/rolled_back': 'llmo/can_deploy',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': 'llmo/can_deploy',

      // ---- Configure (default for writes that aren't onboard/deploy) -----
      // Admin-only writes live in INTERNAL_ROUTES above and bypass FACS entirely.
      // DELETE
      'DELETE /sites/:siteId/geo-experiments/:geoExperimentId': 'llmo/can_configure',
      'DELETE /sites/:siteId/ims-org-access/:accessId': 'llmo/can_configure',
      'DELETE /sites/:siteId/opportunities/:opportunityId': 'llmo/can_configure',
      'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'llmo/can_configure',
      'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'llmo/can_configure',
      'DELETE /sites/:siteId/reports/:reportId': 'llmo/can_configure',
      'DELETE /sites/:siteId/sentiment/guidelines/:guidelineId': 'llmo/can_configure',
      'DELETE /sites/:siteId/sentiment/topics/:topicId': 'llmo/can_configure',
      'DELETE /sites/:siteId/suggestions/grants/:grantId': 'llmo/can_configure',
      'DELETE /tools/api-keys/:id': 'llmo/can_configure',
      'DELETE /tools/import/jobs/:jobId': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/categories/:categoryId': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/topics/:topicId': 'llmo/can_configure',
      // PATCH
      'PATCH /contact-sales-leads/:contactSalesLeadId': 'llmo/can_configure',
      'PATCH /organizations/:organizationId': 'llmo/can_configure',
      'PATCH /projects/:projectId': 'llmo/can_configure',
      'PATCH /sites/:siteId': 'llmo/can_configure',
      'PATCH /sites/:siteId/geo-experiments/:geoExperimentId': 'llmo/can_configure',
      'PATCH /sites/:siteId/opportunities/:opportunityId': 'llmo/can_configure',
      'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'llmo/can_configure',
      'PATCH /sites/:siteId/opportunities/:opportunityId/status': 'llmo/can_configure',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'llmo/can_configure',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': 'llmo/can_configure',
      'PATCH /sites/:siteId/reports/:reportId': 'llmo/can_configure',
      'PATCH /sites/:siteId/sentiment/guidelines/:guidelineId': 'llmo/can_configure',
      'PATCH /sites/:siteId/sentiment/topics/:topicId': 'llmo/can_configure',
      'PATCH /sites/:siteId/url-store': 'llmo/can_configure',
      'PATCH /tools/import/jobs/:jobId': 'llmo/can_configure',
      'PATCH /trial-users/email-preferences': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId/status': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/activate': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/categories/:categoryId': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/topics/:topicId': 'llmo/can_configure',
      // POST (non-onboard, non-deploy, non-query)
      'POST /consent-banner': 'llmo/can_configure',
      'POST /organizations/:organizationId/sites/:siteId/contact-sales-lead': 'llmo/can_configure',
      'POST /organizations/:organizationId/trial-user-invite': 'llmo/can_configure',
      'POST /preflight/jobs': 'llmo/can_configure',
      'POST /sites/:siteId/graph': 'llmo/can_configure',
      'POST /sites/:siteId/ims-org-access': 'llmo/can_configure',
      'POST /sites/:siteId/opportunities': 'llmo/can_configure',
      'POST /sites/:siteId/opportunities/:opportunityId/fixes': 'llmo/can_configure',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions': 'llmo/can_configure',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/backoffice-reviews': 'llmo/can_configure',
      'POST /sites/:siteId/reports': 'llmo/can_configure',
      'POST /sites/:siteId/sandbox/audit': 'llmo/can_configure',
      'POST /sites/:siteId/sentiment/guidelines': 'llmo/can_configure',
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits': 'llmo/can_configure',
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits/unlink': 'llmo/can_configure',
      'POST /sites/:siteId/sentiment/topics': 'llmo/can_configure',
      'POST /sites/:siteId/url-store': 'llmo/can_configure',
      'POST /sites/:siteId/url-store/delete': 'llmo/can_configure',
      'POST /sites/:siteId/user-activities': 'llmo/can_configure',
      'POST /sites/detect/jobs': 'llmo/can_configure',
      'POST /tools/api-keys': 'llmo/can_configure',
      'POST /tools/import/jobs': 'llmo/can_configure',
      'POST /tools/import/jobs/:jobId/result': 'llmo/can_configure',
      'POST /tools/scrape/jobs': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/categories': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/topics': 'llmo/can_configure',
      // Serenity proxy writes — prompts / markets / models under brand
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts/bulk-delete': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts/:semrushPromptId': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags': 'llmo/can_configure',
      'PATCH /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags/:tagId': 'llmo/can_configure',
      'DELETE /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags/:tagId': 'llmo/can_configure',
      'PUT /v2/orgs/:spaceCatId/brands/:brandId/serenity/models': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/activate': 'llmo/can_configure',
      'POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/deactivate': 'llmo/can_configure',
      // Prompt suitability check — body-based mutation against the brand
      'POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/check': 'llmo/can_configure',
      // LLMO sheet-data row patches
      'PATCH /sites/:siteId/llmo/data/:dataSource/row': 'llmo/can_configure',
      'PATCH /sites/:siteId/llmo/data/:sheetType/:dataSource/row': 'llmo/can_configure',
      // Preflight job create (site-scoped)
      'POST /sites/:siteId/preflights': 'llmo/can_configure',
      // POSTs that S2S confirms are :write (not body-based queries).
      'POST /llmo/agentic-traffic/global': 'llmo/can_configure',
      'POST /sites/:siteId/traffic/predominant-type': 'llmo/can_configure',
      'POST /sites/:siteId/traffic/predominant-type/:channel': 'llmo/can_configure',

      // ---- Manage users (state-layer management endpoints) ---------------
      // Customer org admins manage per-resource bindings via these endpoints
      // per the hybrid-model URL grammar `/state/access-mappings`. Each
      // binding row carries `(subject, resource, ims_org_id, product,
      // granted_capabilities)` — the row's `granted_capabilities` are
      // unioned with the JWT to form the caller's effective set.
      //
      // `/product/capabilities` and `/user/capabilities/:resourceId` are
      // catalog / introspection endpoints — any LLMO user with `can_view`
      // can list the product capability catalog and their own effective
      // capability set; the management mutations require `can_manage_users`.
      'GET /state/access-mappings': 'llmo/can_manage_users',
      'GET /state/access-mappings/history': 'llmo/can_manage_users',
      'POST /state/access-mappings': 'llmo/can_manage_users',
      'PATCH /state/access-mappings/:id': 'llmo/can_manage_users',
      'DELETE /state/access-mappings/:id': 'llmo/can_manage_users',
      'GET /organizations/:organizationId/permission/audit-logs': 'llmo/can_manage_users',
      'GET /product/capabilities': 'llmo/can_view',
      'GET /user/capabilities/:resourceId': 'llmo/can_view',

      // ---- View (read-only) ----------------------------------------------
      // Cross-product GETs + POSTs that are body-based queries (no side
      // effects beyond a read / lookup). Admin-only reads live in
      // INTERNAL_ROUTES above and bypass FACS entirely.
      'GET /consent-banner/:jobId': 'llmo/can_view',
      'GET /organizations/:organizationId': 'llmo/can_view',
      'GET /organizations/:organizationId/brands': 'llmo/can_view',
      'GET /organizations/:organizationId/by-project-name/:projectName/sites': 'llmo/can_view',
      'GET /organizations/:organizationId/contact-sales-leads': 'llmo/can_view',
      'GET /organizations/:organizationId/entitlements': 'llmo/can_view',
      'GET /organizations/:organizationId/feature-flags': 'llmo/can_view',
      'GET /organizations/:organizationId/projects': 'llmo/can_view',
      'GET /organizations/:organizationId/projects/:projectId/sites': 'llmo/can_view',
      'GET /organizations/:organizationId/sites': 'llmo/can_view',
      'GET /organizations/:organizationId/sites/:siteId/contact-sales-lead': 'llmo/can_view',
      'GET /organizations/:organizationId/trial-users': 'llmo/can_view',
      'GET /organizations/:organizationId/userDetails/:externalUserId': 'llmo/can_view',
      'GET /organizations/by-ims-org-id/:imsOrgId': 'llmo/can_view',
      'GET /plg/onboard/status/:imsOrgId': 'llmo/can_view',
      'GET /preflight/jobs/:jobId': 'llmo/can_view',
      'GET /projects/:projectId': 'llmo/can_view',
      'GET /projects/:projectId/sites': 'llmo/can_view',
      'GET /projects/:projectId/sites/primary-locale': 'llmo/can_view',
      'GET /projects/by-project-name/:projectName/sites': 'llmo/can_view',
      'GET /sites-resolve': 'llmo/can_view',
      'GET /sites/:siteId': 'llmo/can_view',
      'GET /sites/:siteId/identity': 'llmo/can_view',
      'GET /sites/:siteId/audits': 'llmo/can_view',
      'GET /sites/:siteId/audits/:auditType': 'llmo/can_view',
      'GET /sites/:siteId/audits/:auditType/:auditedAt': 'llmo/can_view',
      'GET /sites/:siteId/audits/latest': 'llmo/can_view',
      'GET /sites/:siteId/bot-blocker': 'llmo/can_view',
      'GET /sites/:siteId/brand-guidelines': 'llmo/can_view',
      'GET /sites/:siteId/brand-profile': 'llmo/can_view',
      'GET /sites/:siteId/experiments': 'llmo/can_view',
      'GET /sites/:siteId/files': 'llmo/can_view',
      'GET /sites/:siteId/geo-experiments': 'llmo/can_view',
      'GET /sites/:siteId/geo-experiments/:geoExperimentId': 'llmo/can_view',
      'GET /sites/:siteId/ims-org-access': 'llmo/can_view',
      'GET /sites/:siteId/ims-org-access/:accessId': 'llmo/can_view',
      'GET /sites/:siteId/latest-audit/:auditType': 'llmo/can_view',
      'GET /sites/:siteId/latest-metrics': 'llmo/can_view',
      'GET /sites/:siteId/metadata': 'llmo/can_view',
      'GET /sites/:siteId/metrics/:metric/:source': 'llmo/can_view',
      'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl': 'llmo/can_view',
      'GET /sites/:siteId/opportunities': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit/:cursor': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit/:cursor': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/by-status/:status': 'llmo/can_view',
      'GET /sites/:siteId/opportunities/top-paid': 'llmo/can_view',
      'GET /sites/:siteId/page-citability/counts': 'llmo/can_view',
      'GET /sites/:siteId/reports': 'llmo/can_view',
      'GET /sites/:siteId/reports/:reportId': 'llmo/can_view',
      'GET /sites/:siteId/scraped-content/:type': 'llmo/can_view',
      'GET /sites/:siteId/sentiment/config': 'llmo/can_view',
      'GET /sites/:siteId/sentiment/guidelines': 'llmo/can_view',
      'GET /sites/:siteId/sentiment/guidelines/:guidelineId': 'llmo/can_view',
      'GET /sites/:siteId/sentiment/topics': 'llmo/can_view',
      'GET /sites/:siteId/sentiment/topics/:topicId': 'llmo/can_view',
      'GET /sites/:siteId/site-enrollments': 'llmo/can_view',
      'GET /sites/:siteId/tokens': 'llmo/can_view',
      'GET /sites/:siteId/tokens/:tokenId/grants': 'llmo/can_view',
      'GET /sites/:siteId/tokens/by-type/:tokenType': 'llmo/can_view',
      'GET /sites/:siteId/top-pages': 'llmo/can_view',
      'GET /sites/:siteId/top-pages/:source': 'llmo/can_view',
      'GET /sites/:siteId/top-pages/:source/:geo': 'llmo/can_view',
      // Paid traffic (cross-product reads)
      'GET /sites/:siteId/traffic/paid': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-url': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-url-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/channel-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/channel-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/display-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/display-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-campaign-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/pta2/weekly-summary': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/search-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/search-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/social-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/social-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/traffic-loss-by-devices': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type-channel-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/type-device-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/video-platform': 'llmo/can_view',
      'GET /sites/:siteId/traffic/paid/video-platform-device': 'llmo/can_view',
      'GET /sites/:siteId/url-store': 'llmo/can_view',
      'GET /sites/:siteId/url-store/:base64Url': 'llmo/can_view',
      'GET /sites/:siteId/url-store/by-audit/:auditType': 'llmo/can_view',
      'GET /sites/:siteId/user-activities': 'llmo/can_view',
      'GET /sites/by-base-url/:baseURL': 'llmo/can_view',
      'GET /sites/detect/jobs/:jobId': 'llmo/can_view',
      'GET /tools/api-keys': 'llmo/can_view',
      'GET /tools/import/jobs/:jobId': 'llmo/can_view',
      'GET /tools/import/jobs/:jobId/progress': 'llmo/can_view',
      'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs': 'llmo/can_view',
      'GET /tools/scrape/jobs/:jobId': 'llmo/can_view',
      'GET /tools/scrape/jobs/:jobId/results': 'llmo/can_view',
      'GET /tools/scrape/jobs/by-base-url/:baseURL': 'llmo/can_view',
      'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': 'llmo/can_view',
      'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': 'llmo/can_view',
      'GET /tools/scrape/jobs/by-url/:url': 'llmo/can_view',
      'GET /tools/scrape/jobs/by-url/:url/:processingType': 'llmo/can_view',
      'GET /trial-users/email-preferences': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId': 'llmo/can_view',
      // Serenity proxy (Semrush AIO replacement) — reads under brand
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/tags': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/models': 'llmo/can_view',
      // Org-level Serenity catalog reads (no brandId).
      'GET /v2/orgs/:spaceCatId/serenity/models': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/serenity/languages': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/filter-dimensions': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/weeks': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/prompts': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/stats': 'llmo/can_view',
      // Preflight (site-scoped reads)
      'GET /sites/:siteId/preflights': 'llmo/can_view',
      'GET /sites/:siteId/preflights/:preflightId': 'llmo/can_view',
      // Site-level scraper config read
      'GET /sites/:siteId/config/scraper': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/categories': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/sites/:siteId/brand': 'llmo/can_view',
      'GET /v2/orgs/:spaceCatId/topics': 'llmo/can_view',
      // POST as query / bulk-read (S2S confirms these are :read).
      'POST /organizations/:organizationId/userDetails': 'llmo/can_view',
      'POST /sites/:siteId/page-relationships/search': 'llmo/can_view',
      // Autofix check returns recommendations without applying them
      // (S2S: site:read).
      'POST /sites/:siteId/autofix-checks': 'llmo/can_view',
    },

    // ASO — site-anchored ReBAC. Capability catalog (see `PRODUCTS_CAPABILITIES`
    // below — the single source of truth):
    //   - aso/can_view          — read-only
    //   - aso/can_edit          — opportunity / suggestion content writes
    //   - aso/can_configure     — site config writes
    //   - aso/can_deploy        — apply / rollback fixes
    //   - aso/can_manage_users  — state-layer management endpoints
    //
    // Note: ASO has no `can_onboard` capability (site creation is admin-only,
    // gated by `hasAdminAccess`); LLMO has no `can_edit` (edit semantics roll
    // up into `can_configure`). The catalogs are intentionally per-product —
    // see the "Per-product structure" docstring at the top of this file.
    //
    // The state-layer URL grammar (`/state/access-mappings/*`,
    // `/product/capabilities`, `/user/capabilities/:resourceId`) is
    // product-agnostic — the same URL surface is reached under x-product=ASO
    // and gated by the aso/* capabilities below.
    //
    // ASO customer surface — site-anchored ReBAC. The customer routes for
    // ASO are populated from the ASO section of
    // `mysticat-architecture/platform/decisions/rebac-ui-coverage-analysis.md`,
    // extended with the rest of the cross-product surface that ASO
    // customers reach (site config, reports, sentiment, tokens, scrape /
    // import tools, api-keys, preflight, page-relationships, autofix,
    // url-store, organization-scoped lookups). Classification heuristics:
    //   - all GETs and body-based query POSTs → can_view
    //   - opportunity / suggestion / fix / report / sentiment / url-store
    //     content writes → can_edit
    //   - edge-deploy / edge-rollback / edge-preview / edge-live-preview,
    //     suggestion auto-fix, fix actions/rolled_back → can_deploy
    //   - site config writes (PATCH /sites/:siteId, /config/*, cdn-logs,
    //     scraper, api keys CRUD, trial invites) → can_configure
    //   - state-layer management endpoints → can_manage_users
    ASO: {
      // ---- Deploy --------------------------------------------------------
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-deploy': 'aso/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-preview': 'aso/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-live-preview': 'aso/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/edge-rollback': 'aso/can_deploy',
      'POST /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/actions/rolled_back': 'aso/can_deploy',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/auto-fix': 'aso/can_deploy',
      'PATCH /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'aso/can_deploy',

      // ---- Edit (opportunity / suggestion / fix / report / sentiment / url-store content) ----
      'POST /sites/:siteId/opportunities': 'aso/can_edit',
      'PATCH /sites/:siteId/opportunities/:opportunityId': 'aso/can_edit',
      'DELETE /sites/:siteId/opportunities/:opportunityId': 'aso/can_edit',
      'PATCH /sites/:siteId/opportunities/:opportunityId/status': 'aso/can_edit',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions': 'aso/can_edit',
      'POST /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/backoffice-reviews': 'aso/can_edit',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/status': 'aso/can_edit',
      'PATCH /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'aso/can_edit',
      'DELETE /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'aso/can_edit',
      'POST /sites/:siteId/opportunities/:opportunityId/fixes': 'aso/can_edit',
      'DELETE /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'aso/can_edit',
      'POST /sites/:siteId/reports': 'aso/can_edit',
      'PATCH /sites/:siteId/reports/:reportId': 'aso/can_edit',
      'DELETE /sites/:siteId/reports/:reportId': 'aso/can_edit',
      'POST /sites/:siteId/sentiment/guidelines': 'aso/can_edit',
      'PATCH /sites/:siteId/sentiment/guidelines/:guidelineId': 'aso/can_edit',
      'DELETE /sites/:siteId/sentiment/guidelines/:guidelineId': 'aso/can_edit',
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits': 'aso/can_edit',
      'POST /sites/:siteId/sentiment/guidelines/:guidelineId/audits/unlink': 'aso/can_edit',
      'POST /sites/:siteId/sentiment/topics': 'aso/can_edit',
      'PATCH /sites/:siteId/sentiment/topics/:topicId': 'aso/can_edit',
      'DELETE /sites/:siteId/sentiment/topics/:topicId': 'aso/can_edit',
      'POST /sites/:siteId/url-store': 'aso/can_edit',
      'PATCH /sites/:siteId/url-store': 'aso/can_edit',
      'POST /sites/:siteId/url-store/delete': 'aso/can_edit',
      'PATCH /sites/:siteId/geo-experiments/:geoExperimentId': 'aso/can_edit',
      'DELETE /sites/:siteId/geo-experiments/:geoExperimentId': 'aso/can_edit',
      'POST /sites/:siteId/sandbox/audit': 'aso/can_edit',
      'POST /preflight/jobs': 'aso/can_edit',
      'POST /sites/:siteId/preflights': 'aso/can_edit',
      'POST /sites/:siteId/brand-profile': 'aso/can_edit',
      'DELETE /sites/:siteId/suggestions/grants/:grantId': 'aso/can_edit',

      // ---- Configure (site config / api-keys / trial invites / scraper /
      // cdn / ims-org-access / contact-sales / consent-banner /
      // import-tools / scrape-tools)
      // ------------------------------------------------------------------
      'PATCH /sites/:siteId': 'aso/can_configure',
      'PATCH /sites/:siteId/config/cdn-logs': 'aso/can_configure',
      'PATCH /sites/:siteId/config/scraper': 'aso/can_configure',
      'POST /sites/:siteId/ims-org-access': 'aso/can_configure',
      'DELETE /sites/:siteId/ims-org-access/:accessId': 'aso/can_configure',
      'POST /tools/api-keys': 'aso/can_configure',
      'DELETE /tools/api-keys/:id': 'aso/can_configure',
      'POST /tools/import/jobs': 'aso/can_configure',
      'PATCH /tools/import/jobs/:jobId': 'aso/can_configure',
      'DELETE /tools/import/jobs/:jobId': 'aso/can_configure',
      'POST /tools/import/jobs/:jobId/result': 'aso/can_configure',
      'POST /tools/scrape/jobs': 'aso/can_configure',
      'POST /sites/detect/jobs': 'aso/can_configure',
      'POST /consent-banner': 'aso/can_configure',
      'POST /organizations/:organizationId/sites/:siteId/contact-sales-lead': 'aso/can_configure',
      'PATCH /contact-sales-leads/:contactSalesLeadId': 'aso/can_configure',
      'POST /organizations/:organizationId/trial-user-invite': 'aso/can_configure',
      'PATCH /trial-users/email-preferences': 'aso/can_configure',
      'POST /sites/:siteId/traffic/predominant-type': 'aso/can_configure',
      'POST /sites/:siteId/traffic/predominant-type/:channel': 'aso/can_configure',

      // ---- Manage users (state-layer management endpoints) ---------------
      'GET /state/access-mappings': 'aso/can_manage_users',
      'GET /state/access-mappings/history': 'aso/can_manage_users',
      'POST /state/access-mappings': 'aso/can_manage_users',
      'PATCH /state/access-mappings/:id': 'aso/can_manage_users',
      'DELETE /state/access-mappings/:id': 'aso/can_manage_users',
      'GET /organizations/:organizationId/permission/audit-logs': 'aso/can_manage_users',

      // ---- View (read-only) ----------------------------------------------
      // Site reads
      'GET /sites-resolve': 'aso/can_view',
      'GET /sites/:siteId': 'aso/can_view',
      'GET /sites/:siteId/identity': 'aso/can_view',
      'GET /sites/by-base-url/:baseURL': 'aso/can_view',
      'GET /sites/:siteId/bot-blocker': 'aso/can_view',
      'GET /sites/:siteId/brand-guidelines': 'aso/can_view',
      'GET /sites/:siteId/brand-profile': 'aso/can_view',
      'GET /sites/:siteId/config/scraper': 'aso/can_view',
      'GET /sites/:siteId/files': 'aso/can_view',
      'GET /sites/:siteId/latest-metrics': 'aso/can_view',
      'GET /sites/:siteId/metadata': 'aso/can_view',
      'GET /sites/:siteId/metrics/:metric/:source': 'aso/can_view',
      'GET /sites/:siteId/metrics/:metric/:source/by-url/:base64PageUrl': 'aso/can_view',
      'GET /sites/:siteId/page-citability/counts': 'aso/can_view',
      'GET /sites/:siteId/scraped-content/:type': 'aso/can_view',
      'GET /sites/:siteId/site-enrollments': 'aso/can_view',
      'GET /sites/:siteId/experiments': 'aso/can_view',
      'GET /sites/:siteId/top-pages': 'aso/can_view',
      'GET /sites/:siteId/top-pages/:source': 'aso/can_view',
      'GET /sites/:siteId/top-pages/:source/:geo': 'aso/can_view',
      'GET /sites/:siteId/user-activities': 'aso/can_view',

      // Audits
      'GET /sites/:siteId/audits': 'aso/can_view',
      'GET /sites/:siteId/audits/latest': 'aso/can_view',
      'GET /sites/:siteId/audits/:auditType': 'aso/can_view',
      'GET /sites/:siteId/audits/:auditType/:auditedAt': 'aso/can_view',
      'GET /sites/:siteId/latest-audit/:auditType': 'aso/can_view',

      // Opportunities / suggestions / fixes (reads)
      'GET /sites/:siteId/opportunities': 'aso/can_view',
      'GET /sites/:siteId/opportunities/top-paid': 'aso/can_view',
      'GET /sites/:siteId/opportunities/by-status/:status': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/paged/:limit/:cursor': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/by-status/:status/paged/:limit/:cursor': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/suggestions/:suggestionId/fixes': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/by-status/:status': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId': 'aso/can_view',
      'GET /sites/:siteId/opportunities/:opportunityId/fixes/:fixId/suggestions': 'aso/can_view',
      'POST /sites/:siteId/page-relationships/search': 'aso/can_view',
      'POST /sites/:siteId/autofix-checks': 'aso/can_view',

      // Reports / sentiment / tokens / url-store / geo / ims-org-access (reads)
      'GET /sites/:siteId/reports': 'aso/can_view',
      'GET /sites/:siteId/reports/:reportId': 'aso/can_view',
      'GET /sites/:siteId/sentiment/config': 'aso/can_view',
      'GET /sites/:siteId/sentiment/guidelines': 'aso/can_view',
      'GET /sites/:siteId/sentiment/guidelines/:guidelineId': 'aso/can_view',
      'GET /sites/:siteId/sentiment/topics': 'aso/can_view',
      'GET /sites/:siteId/sentiment/topics/:topicId': 'aso/can_view',
      'GET /sites/:siteId/tokens': 'aso/can_view',
      'GET /sites/:siteId/tokens/by-type/:tokenType': 'aso/can_view',
      'GET /sites/:siteId/tokens/:tokenId/grants': 'aso/can_view',
      'GET /sites/:siteId/url-store': 'aso/can_view',
      'GET /sites/:siteId/url-store/:base64Url': 'aso/can_view',
      'GET /sites/:siteId/url-store/by-audit/:auditType': 'aso/can_view',
      'GET /sites/:siteId/geo-experiments': 'aso/can_view',
      'GET /sites/:siteId/geo-experiments/:geoExperimentId': 'aso/can_view',
      'GET /sites/:siteId/ims-org-access': 'aso/can_view',
      'GET /sites/:siteId/ims-org-access/:accessId': 'aso/can_view',
      'POST /sites/:siteId/graph': 'aso/can_view',
      'GET /sites/:siteId/preflights': 'aso/can_view',
      'GET /sites/:siteId/preflights/:preflightId': 'aso/can_view',
      'GET /preflight/jobs/:jobId': 'aso/can_view',
      'GET /sites/detect/jobs/:jobId': 'aso/can_view',

      // Paid traffic (full surface)
      'GET /sites/:siteId/traffic/paid': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-channel-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-url': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/campaign-url-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/channel-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/channel-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/display-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/display-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/impact-by-page-traffic-type-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-campaign-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-campaign-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/page-type-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/pta2/weekly-summary': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/search-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/search-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/social-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/social-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-channel-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-campaign-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-channel-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-channel-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/temporal-series-by-url-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/traffic-loss-by-devices': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type-channel-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/type-device-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-channel-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-campaign-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-campaign-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/url-page-type-platform-device': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/video-platform': 'aso/can_view',
      'GET /sites/:siteId/traffic/paid/video-platform-device': 'aso/can_view',

      // Organization-level reads
      'GET /organizations/:organizationId': 'aso/can_view',
      'GET /organizations/:organizationId/brands': 'aso/can_view',
      'GET /organizations/:organizationId/sites': 'aso/can_view',
      'GET /organizations/:organizationId/sites/:siteId/contact-sales-lead': 'aso/can_view',
      'GET /organizations/:organizationId/contact-sales-leads': 'aso/can_view',
      'GET /organizations/:organizationId/entitlements': 'aso/can_view',
      'GET /organizations/:organizationId/feature-flags': 'aso/can_view',
      'GET /organizations/:organizationId/projects': 'aso/can_view',
      'GET /organizations/:organizationId/projects/:projectId/sites': 'aso/can_view',
      'GET /organizations/:organizationId/by-project-name/:projectName/sites': 'aso/can_view',
      'GET /organizations/:organizationId/trial-users': 'aso/can_view',
      'GET /organizations/:organizationId/userDetails/:externalUserId': 'aso/can_view',
      'POST /organizations/:organizationId/userDetails': 'aso/can_view',
      'GET /organizations/by-ims-org-id/:imsOrgId': 'aso/can_view',
      'GET /projects/:projectId': 'aso/can_view',
      'GET /projects/:projectId/sites': 'aso/can_view',
      'GET /projects/:projectId/sites/primary-locale': 'aso/can_view',
      'GET /projects/by-project-name/:projectName/sites': 'aso/can_view',

      // Tools / api-keys (reads)
      'GET /tools/api-keys': 'aso/can_view',
      'GET /tools/import/jobs/:jobId': 'aso/can_view',
      'GET /tools/import/jobs/:jobId/progress': 'aso/can_view',
      'GET /tools/import/jobs/by-date-range/:startDate/:endDate/all-jobs': 'aso/can_view',
      'GET /tools/scrape/jobs/:jobId': 'aso/can_view',
      'GET /tools/scrape/jobs/:jobId/results': 'aso/can_view',
      'GET /tools/scrape/jobs/by-base-url/:baseURL': 'aso/can_view',
      'GET /tools/scrape/jobs/by-base-url/:baseURL/by-processingtype/:processingType': 'aso/can_view',
      'GET /tools/scrape/jobs/by-date-range/:startDate/:endDate/all-jobs': 'aso/can_view',
      'GET /tools/scrape/jobs/by-url/:url': 'aso/can_view',
      'GET /tools/scrape/jobs/by-url/:url/:processingType': 'aso/can_view',
      'GET /consent-banner/:jobId': 'aso/can_view',
      'GET /trial-users/email-preferences': 'aso/can_view',

      // PLG onboard surface (also reachable by ASO customers)
      'POST /plg/onboard': 'aso/can_configure',
      'GET /plg/onboard/status/:imsOrgId': 'aso/can_view',

      // State-layer introspection endpoints
      'GET /product/capabilities': 'aso/can_view',
      'GET /user/capabilities/:resourceId': 'aso/can_view',
    },

    // ACO — TBD. Same status as ASO.
    ACO: {
    },
  },

  /**
   * Per-product map of FACS-controlled resources → list of param aliases that
   * identify each resource in the route surface. Each product decides
   * independently which resources go through the state-layer (ReBAC) check.
   *
   * The resolver scans path params, then request body, then query string for
   * any alias key — this means the body/query alias path is reachable on the
   * `/state/access-mappings` endpoints (resource is carried either as a
   * `resourceType`/`resourceId` pair, or directly as `brandId` in the body
   * or query string, whichever the caller supplies).
   *
   * Adding `siteId`, `organizationId`, etc. into a product's map graduates
   * those params from `FACS_NON_RESOURCE_PARAMS` below — the coverage test
   * enforces exhaustive classification.
   *
   * See mac-state-layer.md §"Resource Identification".
   */
  PRODUCTS_FACS_RESOURCE_PARAM_ALIASES: {
    LLMO: {
      brand: ['brandId'],
    },
    // ASO ReBAC anchor is the site — confirmed by the UI-coverage analysis
    // (mysticat-architecture/platform/decisions/rebac-ui-coverage-analysis.md).
    // No other ASO param identifies a ReBAC entity today:
    //   - opportunityId / suggestionId / fixId are sub-resources of :siteId
    //   - organizationId / spaceCatId / projectId are not ReBAC-scoped for
    //     ASO (the tenancy boundary is the site, not the org)
    //   - everything else is filter/pagination/format.
    ASO: {
      site: ['siteId'],
    },
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
   * while their resources are out of ReBAC scope; they move into
   * PRODUCTS_FACS_RESOURCE_PARAM_ALIASES when a product brings them in.
   */
  FACS_NON_RESOURCE_PARAMS: [
    // Domain identifiers / sub-resource ids — never independently
    // ReBAC-controlled at the wrapper layer:
    'auditType', 'auditedAt', 'categoryId', 'configName', 'executionId',
    // Category / page-type name — the identifier used in PATCH/DELETE on
    // agentic-categories and agentic-page-types routes. It is a label, not
    // a standalone FACS resource.
    'name',
    'fixId', 'geoExperimentId', 'guidelineId', 'intentKey',
    'jobId', 'jobType', 'onboardingId', 'opportunityId', 'plgOnboardingId',
    'promptId', 'questionKey', 'reportId', 'suggestionId', 'tokenId',
    'topicId',
    // Resources not yet in any product's FACS scope (graduate to a product
    // map when ReBAC is added). `siteId` is omitted — it is the ASO ReBAC
    // anchor and lives in PRODUCTS_FACS_RESOURCE_PARAM_ALIASES.ASO above.
    'organizationId', 'spaceCatId', 'projectId',
    // External / shared identifiers:
    'accessId', 'batchId', 'clientId', 'consumerId', 'contactSalesLeadId',
    'externalUserId', 'imsOrgId', 'grantId', 'userId',
    // ASO dispatcher-overlay service name (GET /config/:service/redirects.txt) —
    // an X-ASO-API-Key-authenticated internal route, not a FACS resource.
    'service',
    // Serenity proxy params — identifiers from the upstream API (geo
    // target / language / semrush prompt id / aio tag id), not SpaceCat
    // resources. The enclosing :brandId is the FACS resource for these routes.
    'semrushPromptId', 'geoTargetId', 'languageCode', 'tagId',
    // Preflight job id — sub-resource of the enclosing :siteId.
    'preflightId',
    // Filter / pagination / format params (not entities):
    'base64PageUrl', 'base64Url', 'baseURL', 'channel', 'cursor',
    'dataSource', 'deliveryType', 'endDate', 'eventType',
    'exportId', 'flagName', 'geo', 'handlerType', 'hookSecret', 'limit',
    'metric', 'processingType', 'product', 'projectName',
    'sheetType', 'source', 'startDate', 'status', 'tokenType', 'type',
    'url', 'version', 'week',
    // Single-row id used by the state-layer management endpoints
    // (`/state/access-mappings/:id` — the binding row's own UUID, never a
    // resource being granted). Also used by /user/capabilities/:resourceId
    // where it identifies the resource the caller wants their effective
    // capability set computed for (still a row/path identifier rather than
    // a ReBAC-gated entity).
    'id', 'resourceId',
  ],
};

/**
 * Canonical FACS capability catalog per product — the **single source of
 * truth** for which capability strings are valid in this codebase. Consumed
 * by:
 *
 *   - `GET /product/capabilities` — returns the catalog for the requesting
 *     product (filtered by the `x-product` header).
 *   - `POST /state/access-mappings` and `PATCH /state/access-mappings/:id` —
 *     validate each entry in `granted_capabilities` against the catalog so
 *     a state-layer row can never grant a capability the product doesn't
 *     recognise.
 *   - `spacecat-auth-service` — login-time mock fallback list when MacGiver
 *     is unreachable.
 *   - LLMO / ASO admin UIs — populate the capability picker on the
 *     user-management screens.
 *
 * Hybrid permission model: catalogs are intentionally per-product. LLMO's
 * `can_configure` covers both edit and config writes; ASO splits them into
 * `can_edit` (suggestion / opportunity content) and `can_configure` (site
 * config). LLMO has `can_onboard` (brand creation); ASO does not (site
 * creation is admin-only). Aligning the two would require a MAC policy
 * change in one of the products — keep the catalogs honest to each
 * product's authored policy.
 *
 * See `mysticat-architecture/platform/decisions/mac-state-layer.md`
 * §"Capability catalog".
 */
export const PRODUCTS_CAPABILITIES = {
  LLMO: [
    'llmo/can_view',
    'llmo/can_deploy',
    'llmo/can_configure',
    'llmo/can_onboard',
    'llmo/can_manage_users',
  ],
  ASO: [
    'aso/can_view',
    'aso/can_edit',
    'aso/can_deploy',
    'aso/can_configure',
    'aso/can_manage_users',
  ],
};

/**
 * Whether a product ReBAC-scopes a given resource type at the state layer.
 *
 * The collection-filter controllers (list-sites, list-brands, resolveSite,
 * getSitesByProjectId) narrow their results to the resources a FACS-enrolled
 * caller may view. That narrowing is only valid when the resource type is
 * actually a ReBAC-enforced resource **for the current product** — LLMO scopes
 * `brand` (not `site`), ASO scopes `site` (not `brand`). Applying a `site`
 * filter under LLMO (or a `brand` filter under ASO) would query a state layer
 * that holds no grants for that type and wrongly hide the whole collection.
 * Callers use this to bypass the filter for cross-product resources.
 *
 * @param {string} product - Product code (any case), e.g. 'LLMO' / 'ASO'.
 * @param {string} resourceType - ReBAC resource type, e.g. 'site' / 'brand'.
 * @returns {boolean} true iff `resourceType` is ReBAC-scoped for `product`.
 */
export function isFacsRebacResource(product, resourceType) {
  const aliases = routeFacsCapabilities
    .PRODUCTS_FACS_RESOURCE_PARAM_ALIASES?.[product?.toUpperCase?.()];
  return !!aliases && Object.prototype.hasOwnProperty.call(aliases, resourceType);
}

export default routeFacsCapabilities;
