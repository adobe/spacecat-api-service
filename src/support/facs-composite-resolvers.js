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
import { listFacsAccessMappings } from './state-access-mapping-utils.js';

const WILDCARD = 'all';
// A single site rarely carries this many distinct qualifier grants for one subject;
// mirrors the page cap used by the state-layer list helpers.
const MAX = 500;

/**
 * Fetches the caller's ACTIVE ASO bindings on a site — org-scoped and (when known)
 * user-scoped — across ALL composite-key qualifiers. Returns the raw rows; the
 * resolver inspects `composite_key_value_1` + `granted_capabilities` in memory
 * (2 queries + intersection, never N-per-qualifier).
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.imsOrgId - Canonical caller org id (the resource's owning org).
 * @param {string} args.product  - Uppercase product code (e.g. 'ASO').
 * @param {string} args.siteId
 * @param {string} [args.subjectId] - Caller's canonical user id (JWT sub).
 * @returns {Promise<object[]>}
 */
async function fetchSiteBindings(postgrestClient, {
  imsOrgId, product, siteId, subjectId,
}) {
  const scopes = [{ subjectType: 'org', subjectId: imsOrgId }];
  if (hasText(subjectId)) {
    scopes.push({ subjectType: 'user', subjectId });
  }
  const pages = await Promise.all(scopes.map((scope) => listFacsAccessMappings(postgrestClient, {
    imsOrgId,
    product,
    resourceType: 'site',
    resourceId: siteId,
    subjectType: scope.subjectType,
    subjectId: scope.subjectId,
    limit: MAX,
  })));
  return pages.flat();
}

/**
 * True when ANY binding whose `composite_key_value_1` is in `values` carries
 * `capability`. Pass `values = null` to match a binding with ANY qualifier
 * (the "site-level, qualifier-agnostic" check for non-opportunity routes).
 */
function bindingGrants(bindings, capability, values) {
  return bindings.some(
    (b) => (values == null || values.includes(b.composite_key_value_1))
      && (b.granted_capabilities ?? []).includes(capability),
  );
}

/**
 * True for the ASO opportunity COLLECTION route (`GET /sites/:siteId/opportunities`),
 * which has no single opportunity to type-scope against and is instead
 * result-filtered by the controller (rebac-composite-resource-key.md D4).
 */
function isOpportunityListRoute(routePattern) {
  return typeof routePattern === 'string' && /^GET\s.*\/opportunities$/.test(routePattern);
}

/**
 * ASO composite-resource resolver — registered as `asoOpportunityComposite` and invoked by
 * `facsWrapper` for ASO site routes (see
 * mysticat-architecture/platform/decisions/rebac-composite-resource-key.md, D3/D4). ASO scopes a
 * grant to (site × opportunity-type) via the `composite_key_value_1` qualifier ('all' = site-wide).
 *
 * Behavior by route shape (the wrapper delegates ALL ASO site routes here):
 *  - **Opportunity ITEM** route (carries `:opportunityId`): grant iff a site-wide (`'all'`) binding
 *    OR a binding for the opportunity's OWN type carries the route capability. The `'all'` check
 *    short-circuits BEFORE the Opportunity fetch, so site-wide grantees stay decoupled from
 *    Opportunity-record availability (INV-2 fail-closed applies only to the typed path).
 *  - **Opportunity LIST** route (`GET …/opportunities`): returns `'defer'` — the controller
 *    ReBAC-filters the results to the caller's permitted types.
 *  - **Any other ASO site route** (non-opportunity, incl. opportunity CREATE): grant iff ANY active
 *    site binding (regardless of qualifier) carries the capability — these routes are not
 *    opportunity-scoped.
 *
 * Fail-closed: missing postgrest / opportunity-not-found / opportunity-on-another-site → deny.
 * A thrown error is treated as deny by the wrapper. Each fail-closed branch logs (tag
 * `facs-composite`, distinct `reason`) for debuggability.
 *
 * @param {object} context - request context (dataAccess: Opportunity, services.postgrestClient).
 * @param {object} args
 * @param {string} args.resourceId - the siteId (resourceType 'site').
 * @param {string} args.capability - required fully-qualified `<product>/<capability>`.
 * @param {string} args.product    - uppercase product code ('ASO').
 * @param {string} [args.subjectId]- caller's canonical user id (JWT sub).
 * @param {string} args.orgId      - caller's canonical IMS org id.
 * @param {string} [args.routePattern]
 * @param {Object<string,string>} [args.routeParams]
 * @returns {Promise<boolean|'defer'>}
 */
export async function asoOpportunityComposite(context, {
  resourceId: siteId, capability, product, subjectId, orgId, routePattern, routeParams,
}) {
  const { log } = context;
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    log?.warn?.({
      tag: 'facs-composite', reason: 'no-postgrest', siteId, product, capability,
    }, 'FACS composite resolver fail-closed: postgrest client unavailable');
    return false;
  }

  const bindings = await fetchSiteBindings(postgrestClient, {
    imsOrgId: orgId, product, siteId, subjectId,
  });

  const opportunityId = routeParams?.opportunityId;

  if (hasText(opportunityId)) {
    // Opportunity ITEM route — type-scoped. A site-wide ('all') grant short-circuits
    // without touching the Opportunity record (availability decoupling).
    if (bindingGrants(bindings, capability, [WILDCARD])) {
      return true;
    }
    // Typed path: resolve the opportunity's type and match a type-scoped binding.
    const opportunity = await context.dataAccess.Opportunity.findById(opportunityId);
    if (!opportunity) {
      log?.info?.({
        tag: 'facs-composite', reason: 'opportunity-not-found', siteId, opportunityId, product,
      }, 'FACS composite resolver fail-closed: opportunity not found');
      return false;
    }
    if (opportunity.getSiteId() !== siteId) {
      log?.warn?.({
        tag: 'facs-composite',
        reason: 'site-mismatch',
        siteId,
        opportunityId,
        oppSiteId: opportunity.getSiteId(),
        product,
      }, 'FACS composite resolver fail-closed: opportunity belongs to a different site');
      return false;
    }
    return bindingGrants(bindings, capability, [opportunity.getType()]);
  }

  if (isOpportunityListRoute(routePattern)) {
    // Opportunity LIST — controller filters results to permitted types (D4).
    return 'defer';
  }

  // Any other ASO site route (non-opportunity, incl. opportunity create): not
  // opportunity-scoped → grant iff any active site binding carries the capability.
  return bindingGrants(bindings, capability, null);
}

/**
 * Composite-resource resolver registry passed to `facsWrapper` as `compositeResolvers`.
 * Each key matches `PRODUCTS_FACS_COMPOSITE_RESOURCE.<product>.resolver` in
 * `src/routes/facs-capabilities.js`. Resolvers return `true` to grant, `'defer'` to hand the
 * request to the controller for result-filtering, or `false`/anything else to deny; a thrown
 * error is treated by the wrapper as deny (fail-closed).
 */
export const compositeResolvers = {
  asoOpportunityComposite,
};
