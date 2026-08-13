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
import { listBrandIdsForSite } from './brands-storage.js';
import { listResourceIdsWithCapability } from './state-access-mapping-utils.js';

/**
 * Cross-resource ReBAC check for site-scoped LLMO routes: does `subjectId` hold
 * `capability` on ANY brand linked to `siteId` (within the site's own org)?
 *
 * This is the predicate behind `facsWrapper`'s LLMO `site` secondary param. It
 * runs only when the wrapper resolved no PRIMARY (brand) resource for the route
 * and the caller lacks the org-wide FACS grant (the JWT short-circuit already
 * ruled that out) — see
 * mysticat-architecture/platform/decisions/facs-wrapper-secondary-resource-param.md.
 *
 * Reuses the SAME helpers as `AccessControlUtil.hasLlmoCapabilityForSite`
 * (org-scoped `listBrandIdsForSite` + a single `listResourceIdsWithCapability`
 * query) so the wrapper and the controller decide identically — keep the two in
 * parity. Fail-closed: returns `false` when postgrest, the site, its org, its
 * `imsOrgId`, or its brands cannot be resolved; each fail-closed branch logs
 * (tag `facs-secondary`, distinct `reason`) so a production denial is debuggable
 * — anomalies (`no-postgrest`, `no-ims-org`) at `warn`, ordinary data-shape
 * denials (`site-not-found`, `no-brands`) at `info` to stay low-noise. The
 * normal "evaluated, not authorized" outcome is intentionally not logged here.
 *
 * @param {object} context - request context (dataAccess: Site, Organization, postgrestClient).
 * @param {object} args
 * @param {string} args.siteId
 * @param {string} args.product     - uppercase product code (e.g. 'LLMO').
 * @param {string} [args.subjectId] - caller's canonical user id (JWT sub).
 * @param {string} args.capability  - required fully-qualified `<product>/<capability>`.
 * @returns {Promise<boolean>}
 */
export async function hasCapabilityOnSiteBrands(context, {
  siteId, product, subjectId, capability,
}) {
  const { log } = context;
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    log?.warn?.({
      tag: 'facs-secondary', reason: 'no-postgrest', siteId, product, capability,
    }, 'FACS secondary resolver fail-closed: postgrest client unavailable');
    return false;
  }
  const site = await context.dataAccess.Site.findById(siteId);
  if (!site) {
    log?.info?.({
      tag: 'facs-secondary', reason: 'site-not-found', siteId, product, capability,
    }, 'FACS secondary resolver fail-closed: site not found');
    return false;
  }
  const orgId = site.getOrganizationId();
  const org = await context.dataAccess.Organization.findById(orgId);
  const imsOrgId = org?.getImsOrgId?.();
  if (!hasText(imsOrgId)) {
    log?.warn?.({
      tag: 'facs-secondary', reason: 'no-ims-org', siteId, orgId, product,
    }, 'FACS secondary resolver fail-closed: site org has no imsOrgId');
    return false;
  }
  const brandIds = await listBrandIdsForSite(orgId, siteId, postgrestClient);
  if (brandIds.size === 0) {
    log?.info?.({
      tag: 'facs-secondary', reason: 'no-brands', siteId, orgId, product,
    }, 'FACS secondary resolver fail-closed: no brands linked to site');
    return false;
  }
  const capable = await listResourceIdsWithCapability(postgrestClient, {
    imsOrgId, product, resourceType: 'brand', subjectId, capability,
  });
  for (const id of brandIds) {
    if (capable.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * Secondary-resource resolver registry passed to `facsWrapper` as
 * `secondaryResolvers`. Each key matches
 * `PRODUCTS_FACS_SECONDARY_RESOURCE.<product>.resolver` in
 * `src/routes/facs-capabilities.js`. Resolvers return `true` to grant, `false`
 * to deny; a thrown error is treated by the wrapper as deny (fail-closed).
 */
export const secondaryResolvers = {
  llmoSiteToBrands: (context, {
    resourceId, capability, product, subjectId,
  }) => hasCapabilityOnSiteBrands(context, {
    siteId: resourceId, product, subjectId, capability,
  }),
};
