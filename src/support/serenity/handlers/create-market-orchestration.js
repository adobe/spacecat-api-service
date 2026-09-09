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

import { ErrorWithStatusCode } from '../../utils.js';
import { handleCreateMarketSubworkspace } from './markets-subworkspace.js';
import { resolveDefaultModelIds } from '../default-models.js';
import {
  ensureMarketSite, resolveMarketIdentity, logMarketCreated,
} from '../site-linkage.js';
import { linkSiteToRow } from '../mapping-rows.js';
import {
  getBrandAliases, getBrandUrlSources, getBrandCompetitors,
} from '../../brands-storage.js';
import { computeWriteDeadline } from '../intent-classification.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

// Mirrors brand-provisioning.js's own MAX_TOPICS_ON_CREATE (same value) — not imported from
// there to avoid a circular import (brand-provisioning.js imports handleCreateMarketSubworkspace,
// which this file also imports, from markets-subworkspace.js).
const MAX_TOPICS_ON_CREATE = 5;

// Mirrors controllers/serenity.js's own local MarketCreateSuccessBody typedef (a JSDoc @typedef
// is file-scoped, so this can't reference that one directly without an inter-layer type import).
/**
 * @typedef {{
 *   geoTargetId: number, languageCode: string|null, workspaceId: string,
 *   promptCount?: number,
 * }} MarketCreateSuccessBody
 */

/**
 * The FULL create-a-market orchestration (PR-C, LLMO-7352/LLMO-7418): identity resolution +
 * brand-level alias/URL/competitor prefetch + model-id resolution, the
 * {@link handleCreateMarketSubworkspace} call itself, and the post-create Site mirroring
 * (`ensureMarketSite`/`linkSiteToRow`/`logMarketCreated`) — extracted VERBATIM from
 * `createMarket`'s subworkspace-mode branch in `controllers/serenity.js` so a SECOND caller (the
 * async `serenity-create-market` job, once the workspace it depends on is `ready`) gets the exact
 * same behavior the synchronous endpoint has today, rather than a hand-reimplemented subset that
 * silently drops site-linking or picks the wrong model ids. `createMarket` itself now calls this.
 *
 * Only `ctx`/`auth` are replaced with explicit, minimal params — everything else (including
 * comments) is unchanged from the original inline block, so behavior is provably identical for
 * the synchronous caller.
 *
 * @param {object} params
 * @param {object} params.dataAccess - `context.dataAccess` (Brand, BrandSemrushProject, Site,
 *   services.postgrestClient — the same collections `createMarket` already had via `ctx`).
 * @param {object} [params.env]
 * @param {string} params.orgId - the org id (`ctx.params.spaceCatId` for the sync caller).
 * @param {SerenityTransport} params.transport
 * @param {string} params.brandUuid
 * @param {string} params.parentWorkspaceId
 * @param {string} params.workspaceId - the brand's Semrush sub-workspace id, used ONLY to
 *   resolve default model ids (mirroring existing markets) — the sync caller passes its
 *   already-resolved `auth.workspaceId`; the async caller passes the workspace this job's chain
 *   just confirmed `ready`, which is the same thing at this point in either flow.
 * @param {object} params.requestBody - the create-market request body.
 * @param {object} params.log
 * @param {number} [params.writeDeadline]
 * @param {object} [params.suppliedSiteIdentity]
 * @param {string|null} [params.suppliedSiteId]
 * @param {string|null} [params.preResolvedWorkspaceId] - forwarded to
 *   {@link handleCreateMarketSubworkspace}; the async caller passes the already-ready
 *   `workspaceId` so it skips its own `ensureSubworkspace` call entirely (the whole point of
 *   deferring this to a job chained AFTER provisioning, not before).
 * @param {Function|null} [params.reloadPointer]
 * @param {string} [params.callerId]
 * @param {string[]|null} [params.modelIds] - explicit caller-chosen model ids for THIS market,
 *   e.g. brand-create's `semrushModelIds` (PR-C, LLMO-7352/LLMO-7418). When omitted/empty, falls
 *   back to {@link resolveDefaultModelIds}'s existing-market mirroring — the only behavior Add
 *   Market itself ever needs, since it never has an explicit per-call override to honor. An
 *   explicit override is REQUIRED for a brand's very first market: at that point there are no
 *   existing markets yet for `resolveDefaultModelIds` to mirror, so without one a caller's chosen
 *   models would silently be replaced by the generic net-new default set.
 * @returns {Promise<{status: number, body: object}>} the same shape
 *   {@link handleCreateMarketSubworkspace} itself returns.
 */
export async function orchestrateCreateMarketSubworkspace({
  dataAccess,
  env = null,
  orgId,
  transport,
  brandUuid,
  parentWorkspaceId,
  workspaceId,
  requestBody,
  log,
  writeDeadline = computeWriteDeadline(),
  suppliedSiteIdentity = null,
  suppliedSiteId = null,
  preResolvedWorkspaceId = null,
  reloadPointer = null,
  callerId = 'unknown',
  modelIds = null,
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

  // The subworkspace create handler has no Site access (narrowed dataAccess),
  // so derive the Semrush project domain HERE via the same shared rule the
  // flat handler uses (resolveMarketIdentity, markets.js): a resolving siteId
  // is authoritative over any brandDomain also sent; brandDomain is consulted
  // only when no siteId was supplied; a supplied-but-unresolvable siteId is a
  // hard 400 (see the pre-check above — suppliedSiteIdentity is already
  // guaranteed non-null here whenever a siteId was supplied). Both branches go
  // through the one function so this call site cannot silently diverge from
  // the flat handler's. `primaryUrl` is always DERIVED here, never taken from
  // the request — unlike the flat handler, which does trust a caller-supplied
  // primaryUrl when deriving from brandDomain. That primaryUrl is not part of
  // the documented create-market contract on this path, and passing a
  // caller's value straight through would put an unvalidated string on the
  // Semrush project, so it is deliberately omitted from the call below.
  const identity = resolveMarketIdentity(
    suppliedSiteIdentity,
    !!suppliedSiteId,
    requestBody.brandDomain,
    undefined,
  );
  // Only `primaryUrl` can carry a subpath — `brandDomain` is a bare FQDN
  // because a path there is rejected upstream. The two travel together —
  // resolveMarketIdentity never resolves one without the other — so both
  // are assigned the same way, with no separate null-coalescing on either.
  const effectiveBody = {
    ...requestBody,
    brandDomain: identity.domain,
    primaryUrl: identity.primaryUrl,
  };
  // Brand aliases are brand-level but region-scoped: the create handler
  // clamps each to the new market's region before writing brand_names.
  const brandAliases = await getBrandAliases(brandUuid, postgrestClient);
  // Brand URLs (own sites + social + earned) are brand-level too: read the
  // persisted set and push it (region-filtered) onto the new market.
  const brandUrlSources = await getBrandUrlSources(brandUuid, postgrestClient);
  // Competitors ("other brands to track") merge into the new market's CI list.
  const competitors = await getBrandCompetitors(brandUuid, postgrestClient);
  // Optional prompt/topic generation for this market, defaulting to off so
  // the endpoint's behavior is unchanged unless the caller opts in.
  const genMarketTopics = effectiveBody.generatePrompts === true;
  // An explicit override (brand-create's `semrushModelIds`) always wins — there is no
  // "existing market" for resolveDefaultModelIds to mirror on a brand's very first market, so
  // skipping it here is what lets the caller's own choice survive rather than being silently
  // replaced by the generic default set. Absent an override (Add Market's own call, LLMO-6554):
  // this brand is already active, so its sub-workspace (and likely other markets) already
  // exists — mirror whichever models those markets already track, falling back to the canonical
  // net-new default only if none of them has any (see resolveDefaultModelIds). Without this,
  // "Add Market" on an active brand attached zero models and the subsequent publish 405'd as a
  // disguised empty-units quota rejection.
  const newMarketModelIds = Array.isArray(modelIds) && modelIds.length > 0
    ? modelIds
    : await resolveDefaultModelIds(transport, workspaceId, brandUuid, log);
  const result = await handleCreateMarketSubworkspace(
    transport,
    brand,
    parentWorkspaceId ?? '',
    effectiveBody,
    log,
    preResolvedWorkspaceId,
    reloadPointer,
    {
      modelIds: newMarketModelIds,
      generateTopics: genMarketTopics,
      topicCap: genMarketTopics ? MAX_TOPICS_ON_CREATE : 0,
      brandAliases,
      brandUrlSources,
      competitors,
      env,
      writeDeadline,
      // brandUuid is an already-persisted brand row here (found above), so the
      // mapping-row upsert's FK to brands is satisfied — see mapping-rows.js
      // upsertMappingRow doc.
      // Narrowed to the one model the mapping-row helpers touch (defense in
      // depth: this options bag flows into markets-subworkspace.js and
      // shouldn't carry access to unrelated tables).
      dataAccess: { BrandSemrushProject: dataAccess.BrandSemrushProject },
      // Sub-workspace titles are bare brand names, so ensureSubworkspace needs the Brand
      // collection to tell this brand's own interrupted create from a same-named sibling
      // brand's workspace. Only consulted when this brand has no sub-workspace yet.
      brandCollection: dataAccess.Brand,
      // serenity-docs#72 §5: feeds the quota-rejection Slack alert (opt-in via
      // SERENITY_QUOTA_ALERTS_ENABLED) — never required, a no-op when unset.
      orgId,
      // Caller identity for the created_* stamp on any generated prompt
      // (LLMO-6289) — from the auth profile, never the upstream bearer.
      callerId,
    },
  );
  // Mirror this market as a SpaceCat Site (+ brand_sites link), once its
  // Semrush project is created. Best-effort: never fails a live market.
  if (result?.status === 201) {
    const linkedSiteId = await ensureMarketSite({ dataAccess }, {
      // The org from the route, which is the same org the brand belongs to
      // (resolveBrandUuid scopes the brand lookup to it). It cannot come
      // from the Brand model: that schema deliberately does not map
      // `organization_id` (brand.schema.js), so there is no accessor for it
      // — and asking for one yields `undefined`, which `ensureMarketSite`
      // treats as bad input and returns null for WITHOUT logging. That is
      // the one silent path it has, which is why a market never carried a
      // site despite every visible step succeeding.
      organizationId: orgId,
      brandId: brandUuid,
      // The url this project TRACKS, which is what its Site must mirror —
      // `brandDomain` is the host it is filed under and drops any subpath.
      // The two coincide whenever both derive from one input; they part as
      // soon as a market carries a url of its own, and the Site must follow
      // the tracked value, never the host.
      domain: effectiveBody.primaryUrl ?? effectiveBody.brandDomain,
      // When the caller supplied a siteId, link THAT site directly (skip the
      // domain→Site find-or-create); the client already holds the identity.
      siteId: suppliedSiteId ?? undefined,
      updatedBy: 'serenity-create-market',
      // Market-create: the brand_sites mirror is best-effort, so bind the
      // market↔site on the mapping row (what the DTO surfaces) even if that
      // secondary mirror write doesn't land (LLMO-6405). Unlike activate, a
      // mirror hiccup must not leave the just-created market with no siteId.
      requireLink: false,
      log,
    });
    // Bind the market↔site on THIS market's row — the per-market source of
    // truth for the url its project tracks, and what the sub-workspace
    // list/get enrichment surfaces. Scoped to the one row named by the new
    // project id: a market created against its own url must not have that
    // site spread across whichever sibling rows are unlinked (mapping-rows.js).
    const projectId = result.body && 'projectId' in result.body
      ? result.body.projectId
      : null;
    if (projectId) {
      await linkSiteToRow(dataAccess, projectId, linkedSiteId, log);
    } else {
      // Unreachable while the handler keeps its 201 contract (a created
      // market always names its project). Worth a line if that ever
      // changes: the market silently keeps no site otherwise, which is
      // exactly the failure this whole path exists to have fixed.
      log?.warn?.('serenity create-market: 201 without a projectId — market left unlinked', {
        brandId: brandUuid, siteId: linkedSiteId,
      });
    }
    // Logged unconditionally on the outer `status === 201`, NOT nested inside
    // `if (projectId)` — a malformed 201 body still deserves the create-market
    // event (with `semrushProjectId: null`) so ops isn't blind to it, and it
    // matches the flat handler's own unconditional log.
    {
      const successBody = /** @type {MarketCreateSuccessBody} */ (result.body);
      logMarketCreated(log, {
        brandId: brandUuid,
        geoTargetId: successBody.geoTargetId,
        languageCode: successBody.languageCode,
        // The supplied/resolved siteId, not `linkedSiteId` — the brand_sites
        // mirror write is best-effort and can fail independently of a valid
        // siteId being supplied, which would otherwise log a null siteId for
        // a market that in fact had one. Matches the flat handler's own
        // telemetry, which reports the supplied siteId the same way.
        siteId: suppliedSiteId ?? null,
        brandDomain: effectiveBody.brandDomain,
        primaryUrl: effectiveBody.primaryUrl,
        semrushWorkspaceId: successBody.workspaceId,
        semrushProjectId: projectId,
        generatePrompts: genMarketTopics,
        promptCount: successBody.promptCount,
      });
    }
  }
  return result;
}
