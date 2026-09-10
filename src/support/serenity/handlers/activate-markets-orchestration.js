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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../../utils.js';
import { handleCreateMarketSubworkspace } from './markets-subworkspace.js';
import { resolveDefaultModelIds } from '../default-models.js';
import { ensureSubworkspace } from '../workspace-lifecycle.js';
import { ensureMarketSite } from '../site-linkage.js';
import { linkSiteToLiveRows } from '../mapping-rows.js';
import {
  getBrandAliases, getBrandUrlSources, getBrandCompetitors, updateBrand,
} from '../../brands-storage.js';
import { computeWriteDeadline } from '../intent-classification.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

// Mirrors controllers/serenity.js's own MAX_MARKETS (same value) — not imported from there to
// avoid a circular import (serenity.js imports this module).
const MAX_MARKETS = 50;

// Mirrors brand-provisioning.js's own MAX_TOPICS_ON_CREATE (same value) — see
// create-market-orchestration.js's identical constant for the same avoid-circular-import
// rationale.
const MAX_TOPICS_ON_CREATE = 5;

/**
 * The FULL `POST /serenity/activate` project-activation batch — sub-workspace ensure, brand-level
 * alias/URL/competitor prefetch, model-id resolution, the per-market
 * {@link handleCreateMarketSubworkspace} loop, and the all-or-nothing post-batch site
 * mirroring/brand-active flip — extracted VERBATIM from `activate`'s project-activation branch in
 * `controllers/serenity.js` (PR-C, LLMO-7352/LLMO-7418) so a SECOND caller (the async
 * `serenity-activate-markets` job, once the workspace it depends on is `ready`) gets the exact
 * same behavior the synchronous endpoint has today, rather than a hand-reimplemented subset.
 * `activate` itself now calls this for its synchronous (async absent/false) branch.
 *
 * Only `ctx`/`auth`/`brand` are replaced with explicit, minimal params — everything else
 * (including comments) is unchanged from the original inline block, so behavior is provably
 * identical for the synchronous caller.
 *
 * @param {object} params
 * @param {object} params.dataAccess - `context.dataAccess` (Brand, BrandSemrushProject,
 *   services.postgrestClient — the same collections `activate` already had via `ctx`).
 * @param {object} [params.env]
 * @param {string} params.orgId - the org id (`ctx.params.spaceCatId` for the sync caller).
 * @param {SerenityTransport} params.transport
 * @param {string} params.brandUuid
 * @param {string} params.parentWorkspaceId
 * @param {object} params.requestBody - the activate request body (`markets`, `brandDomain`,
 *   `primaryUrl`, `brandNames`, `brandDisplayName`, `generatePrompts`).
 * @param {object} params.log
 * @param {number} [params.writeDeadline]
 * @param {string|null} [params.preResolvedWorkspaceId] - forwarded to `ensureSubworkspace`'s
 *   effective replacement; the async caller passes the already-ready `workspaceId` so it skips
 *   its own `ensureSubworkspace` call entirely (the whole point of deferring this to a job
 *   chained AFTER provisioning, not before).
 * @param {Function|null} [params.reloadPointer]
 * @param {string} [params.callerId]
 * @returns {Promise<{status: number, body: object}>} the same `{ status, body }` shape the
 *   synchronous endpoint itself has always returned (200/207/409).
 */
export async function orchestrateActivateMarkets({
  dataAccess,
  env = null,
  orgId,
  transport,
  brandUuid,
  parentWorkspaceId,
  requestBody,
  log,
  writeDeadline = computeWriteDeadline(),
  preResolvedWorkspaceId = null,
  reloadPointer = null,
  callerId = 'unknown',
}) {
  const Brand = dataAccess?.Brand;
  if (!Brand || typeof Brand.findById !== 'function') {
    throw new ErrorWithStatusCode('Brand data-access not available', 500);
  }
  const brand = await Brand.findById(brandUuid);
  if (!brand) {
    throw new ErrorWithStatusCode(`Brand not found: ${brandUuid}`, 404);
  }
  const postgrestClient = dataAccess?.services?.postgrestClient;

  const { brandDomain } = requestBody;
  const generatePrompts = requestBody.generatePrompts === true;
  const brandDomainFallback = hasText(brandDomain) ? brandDomain : null;
  const brandPrimaryUrl = hasText(requestBody.primaryUrl)
    ? requestBody.primaryUrl
    : brandDomainFallback;

  // ----- Project activation (primary URL present) -----
  // Markets come from the body (reactivation). A URL with no market supplied
  // provisions a single US/EN fallback project — the same default
  // brand-provisioning.js applies on the direct-create path.
  const requestedMarkets = Array.isArray(requestBody.markets) ? requestBody.markets : [];
  const markets = requestedMarkets.length > 0
    ? requestedMarkets
    : [{ market: 'US', languageCode: 'en' }];
  if (markets.length > MAX_MARKETS) {
    throw new ErrorWithStatusCode(`markets must not exceed ${MAX_MARKETS} entries`, 400);
  }
  // Brand aliases are brand-level but region-scoped: read once; each market's
  // create clamps them to that market's region before writing brand_names.
  const brandAliases = await getBrandAliases(brandUuid, postgrestClient);
  // Brand URLs are brand-level: read once, push (region-filtered) per market.
  const brandUrlSources = await getBrandUrlSources(brandUuid, postgrestClient);
  // Competitors are brand-level too: read once, merge (region-filtered) per market.
  const competitors = await getBrandCompetitors(brandUuid, postgrestClient);

  // Ensure the sub-workspace ONCE for the whole batch, then create each market against the
  // resolved workspace. (Calling ensureSubworkspace per market would re-poll N times —
  // seconds of redundant settling that risks the Lambda timeout.)
  const workspaceId = preResolvedWorkspaceId && hasText(preResolvedWorkspaceId)
    ? preResolvedWorkspaceId
    : await ensureSubworkspace(
      transport,
      brand,
      parentWorkspaceId,
      log,
      {},
      reloadPointer,
      { brandCollection: dataAccess?.Brand },
    );
  // LLMO-6554: resolved ONCE for the whole batch (same brand, so every market
  // in this request gets the same default) — mirrors whichever models the
  // brand's existing markets already track, falling back to the canonical
  // net-new default set when none do. A per-market `modelIds` in the body
  // still wins when supplied (see marketModelIds below), preserving the
  // override for any API-driven caller.
  const defaultModelIds = await resolveDefaultModelIds(
    transport,
    workspaceId,
    brandUuid,
    log,
  );
  const results = [];
  for (const m of markets) {
    const createBody = {
      market: m.market,
      languageCode: m.languageCode,
      brandDomain,
      primaryUrl: brandPrimaryUrl ?? undefined,
      brandNames: requestBody.brandNames,
      brandDisplayName: requestBody.brandDisplayName,
      name: m.name,
    };
    // AI models (LLMs) the draft staged for this market (or that the activate
    // request supplied). handleCreateMarketSubworkspace reads them from its
    // OPTIONS arg (NOT the body) and attaches them to the project before
    // publish; omitted/empty → the resolved default (LLMO-6554) applies.
    const marketModelIds = Array.isArray(m.modelIds) && m.modelIds.length > 0
      ? m.modelIds
      : defaultModelIds;
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await handleCreateMarketSubworkspace(
        transport,
        brand,
        parentWorkspaceId,
        createBody,
        log,
        workspaceId,
        null,
        {
          modelIds: marketModelIds,
          // Generate topics/prompts only when the brand opted in. When false
          // the project is published empty (no prompts) — today's default.
          generateTopics: generatePrompts,
          topicCap: generatePrompts ? MAX_TOPICS_ON_CREATE : 0,
          // SITES-49206: Semrush no longer enforces AI limits, so an empty-units
          // publish no longer 405s — every market now publishes with 'require'
          // regardless of whether it has models/prompts attached.
          publishMode: 'require',
          brandAliases,
          brandUrlSources,
          competitors,
          env,
          writeDeadline,
          // `brand` was loaded via Brand.findById above — an already-persisted
          // row, so the mapping-row upsert's FK to brands is satisfied.
          // Narrowed to the one model the mapping-row helpers touch — see
          // the single-market create call site for the same rationale.
          dataAccess: { BrandSemrushProject: dataAccess.BrandSemrushProject },
          // serenity-docs#72 §5: feeds the quota-rejection Slack alert (opt-in via
          // SERENITY_QUOTA_ALERTS_ENABLED) — never required, a no-op when unset.
          orgId,
          callerId,
        },
      );
    } catch (e) {
      // A single market failing must NOT abort the batch: markets already
      // published in this loop are live upstream, and aborting would leave
      // them live while the brand stays pending with no per-market record.
      // Record the failure and continue; the multi-status response reports
      // it per market. (A generic message - never the upstream error text,
      // which carries the gateway URL.)
      log?.error?.('serenity activate: market create failed', {
        market: m.market,
        languageCode: m.languageCode,
        status: e?.status,
      });
      r = {
        status: e?.status || 502,
        body: { error: 'serenityUpstreamError', message: 'Market activation failed' },
      };
    }
    // 201 = created+published now; 409 = sliceExists (already live upstream).
    // Both mean the slice IS live (a full idempotent re-activate where every
    // market 409s is a complete success). The live/failed tally is derived
    // from `results` after the loop (see allMarketsLive below).
    results.push({
      market: m.market,
      languageCode: m.languageCode,
      status: r.status,
      body: r.body,
    });
  }

  // ALL-OR-NOTHING activation. The brand flips to 'active' ONLY when the
  // full provisioning chain succeeded:
  //   1. sub-workspace ensured (above; throws → caught → error response),
  //   2. EVERY market's project published (status 201/409 — all live),
  //   3. the brand is linked to its sub-workspace (semrushWorkspaceId,
  //      persisted by ensureSubworkspace above), AND
  //   4. every provisioned market is mirrored as a Site + brand_sites row
  //      (type='serenity').
  // If ANY step fails, a brand that was pending STAYS pending — its workspace
  // pointer is left intact so a retry converges idempotently (live markets
  // return 409; the site-link re-runs) — and the response is an error. (An
  // already-active brand re-supplying markets is never downgraded.)
  const allMarketsLive = results.length > 0
    && results.every((r) => r.status === 201 || r.status === 409);

  // The brand_sites mirror is now a REQUIRED activation step (NOT
  // best-effort): run it only once every market is live. Every market in
  // this batch was provisioned against the single resolved `brandPrimaryUrl`
  // (the body's tracked URL), so one idempotent ensure on that url links
  // them all. A null return (any failure: bad input, cross-org, write error)
  // keeps the brand pending below.
  //
  // Mirror the url the projects TRACK, not the host they are filed under.
  // These markets were just provisioned on `brandPrimaryUrl`; anchoring their
  // Site — which becomes `brands.site_id` via `baseSiteId` below, and the link
  // `linkSiteToLiveRows` writes onto the mapping rows — to `brandDomain`
  // instead would leave a brand analysing `nba.com/kings` recorded against the
  // root `nba.com` Site. It also stops sibling brands on one apex from
  // colliding on `brands_base_site_unique`. Identical for a body-supplied
  // `brandDomain` (a bare FQDN by contract, whose identity is itself); only a
  // body-threaded `primaryUrl` carrying a subpath moves. A null value is the
  // same malformed input the project provisioning above already rejected, and
  // resolves to null here, keeping the brand pending.
  let siteLinked = false;
  let linkedSiteId = null;
  if (allMarketsLive) {
    linkedSiteId = await ensureMarketSite({ dataAccess }, {
      // From the route, not the Brand entity: `brand.schema.js` deliberately
      // does not map `organization_id`, so no accessor is generated for it and
      // `brand.getOrganizationId?.()` is always `undefined`. `ensureMarketSite`
      // reads that as bad input and returns null through its one early return
      // that logs nothing — every market goes live upstream while the site
      // link never lands, so activation answers a permanent 207 with
      // `baseSiteId` never written and nothing warning. The route org is
      // exact here: the caller resolved the brand scoped to it.
      organizationId: orgId,
      brandId: brandUuid,
      domain: brandPrimaryUrl,
      updatedBy: 'serenity-activate',
      log,
    });
    siteLinked = !!linkedSiteId && hasText(linkedSiteId);
    // Best-effort, scope-guarded to unlinked live rows (mapping-rows.js) —
    // never overwrites an existing link. All markets in this batch share
    // one resolved primary URL and thus one mirror Site, so by-brand picks
    // up every row this batch wrote (including 409/already-live ones).
    await linkSiteToLiveRows(dataAccess, brandUuid, linkedSiteId, log);
  }

  let fullySucceeded = allMarketsLive && siteLinked;

  if (fullySucceeded) {
    try {
      // Persist status + primary site in ONE atomic write via the
      // storage helper (the Brand model exposes no site_id setter, so a
      // model.save() can't set it — this is why Serenity historically never
      // populated brands.site_id). baseSiteId is the primary domain's mirror
      // Site (linkedSiteId): a NULL->value first set, allowed on the pending
      // brand. updateBrand's own guard rejects activating without a base site,
      // so this is where an active Serenity brand becomes site-anchored — same
      // authoritative brands.site_id contract as the brandalf activate path.
      await updateBrand({
        organizationId: orgId,
        brandId: brandUuid,
        updates: {
          status: 'active',
          baseSiteId: linkedSiteId,
        },
        postgrestClient,
        updatedBy: 'serenity-activate',
      });
    } catch (saveError) {
      fullySucceeded = false;
      // TERMINAL: the primary domain is already another active brand's primary
      // site (brands_base_site_unique -> 409). The markets are live upstream,
      // but the brand CANNOT activate on this domain, so it stays pending. This
      // is NOT the retryable divergence below — a retry re-collides forever — so
      // surface a clean 409 naming the conflict; the operator must pick a
      // different primary URL (mirrors the brandalf activate behavior).
      if (saveError?.status === 409) {
        log.info('serenity activate: SERENITY_ACTIVATE_SITE_CONFLICT — primary site already owned by another active brand; brand stays pending', {
          brandId: brandUuid,
          semrushWorkspaceId: workspaceId,
          siteId: linkedSiteId,
        });
        return {
          status: 409,
          body: {
            brandId: brandUuid,
            status: 'pending',
            error: 'serenityActivationSiteConflict',
            message: 'This site is already the primary URL for another brand',
            markets: results,
          },
        };
      }
      // Divergence seam: markets live + site linked upstream, but persisting
      // the 'active' flip failed transiently -> the brand stays 'pending'. A
      // re-activate converges (idempotent). Emit a DISTINCT, greppable token so
      // the orphaned status is alertable, then fall through to the error
      // response (do NOT collapse to a bare mapError 5xx — that discards the
      // per-market results telling the caller what went live).
      log.error('serenity activate: SERENITY_ACTIVATE_SAVE_DIVERGENCE — markets live + site linked upstream but failed to persist active status', {
        brandId: brandUuid,
        semrushWorkspaceId: workspaceId,
        marketsLive: results.filter((r) => r.status === 201 || r.status === 409).length,
        error: saveError?.message,
      });
    }
  }

  const marketsLiveCount = results.filter((r) => r.status === 201 || r.status === 409).length;
  log.info('serenity activate: completed', {
    brandId: brandUuid,
    semrushWorkspaceId: workspaceId,
    fullySucceeded,
    siteLinked,
    marketsTotal: results.length,
    marketsLive: marketsLiveCount,
    marketsFailed: results.length - marketsLiveCount,
  });

  if (fullySucceeded) {
    return {
      status: 200,
      body: {
        brandId: brandUuid,
        status: 'active',
        baseSiteId: linkedSiteId,
        markets: results,
      },
    };
  }

  // Not fully succeeded. The body-driven market path (reactivation / onboarding
  // API) runs ONLY for a brand that is already ACTIVE — a pending brand activates
  // sub-workspace-only above (LLMO-6405) and never reaches here. An already-active
  // brand is never downgraded on a partial failure: a failed market is reported as
  // 207 Multi-Status while the brand stays active.
  return {
    status: 207,
    body: { brandId: brandUuid, status: 'active', markets: results },
  };
}
