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

import { listViewableResourceIds } from './state-access-mapping-utils.js';
import { listSiteIdsForBrands } from './brands-storage.js';
import { requirePostgrestForFacsMappings } from './postgrest-availability.js';
import { isFacsRebacResource } from '../routes/facs-capabilities.js';

// Env flag gating the LLMO brand-scoped site narrowing (below). The FACS
// per-product LaunchDarkly flag already controls WHICH orgs are enrolled
// (`facs.enabled`); this switch lets the new brand→site narrowing ship dark and
// be turned on deliberately once verified, so enrolling an LLMO org in FACS for
// other surfaces (e.g. edge-optimize) does not silently change its sites list.
// Off => the resolver returns null for LLMO (today's unfiltered behavior).
const LLMO_BRAND_SITE_FILTER_FLAG = 'ENABLE_LLMO_SITES_BRAND_FILTER';

/**
 * Resolves the set of an organization's sites a FACS-enrolled,
 * resource-scoped caller may view via state-layer `can_view` grants.
 *
 * Shared by `getSitesForOrganization` and `getProjectsByOrganizationId`
 * (`controllers/organizations.js`) so the authorization boundary — the
 * capability check, the cross-product bypass, the PostgREST-availability
 * guard, and the grant lookup — exists in exactly one place instead of
 * drifting between two copies.
 *
 * Two resource shapes:
 * - `site`-scoped products (ASO): grants are held directly on sites, so the
 *   viewable set is `listViewableResourceIds(resourceType: 'site')`.
 * - `brand`-scoped products (LLMO): grants are held on brands, so the viewable
 *   sites are derived by resolving the caller's viewable brands and mapping
 *   those brands back to sites. Sites with no viewable brand (or no brand at
 *   all) are excluded — matching `hasLlmoCapabilityForSite`. Gated by the
 *   `ENABLE_LLMO_SITES_BRAND_FILTER` env flag (default off).
 *
 * @param {object} context - Universal request context.
 * @param {object} organization - Organization model instance owning the sites.
 * @returns {Promise<Set<string>|Response|null>} `null` when no filtering
 *   applies (FACS disabled, caller holds an org-wide `<product>/can_view` JWT
 *   permission, the product ReBAC-scopes neither `site` nor `brand`, or the
 *   LLMO brand filter flag is off) — callers should return the full collection
 *   unfiltered. A `Response` when PostgREST is unavailable — callers must
 *   return it directly. Otherwise a `Set<siteId>` of viewable site ids.
 */
export async function resolveViewableSiteIds(context, organization) {
  const facs = context.attributes?.facs;
  const hasFACSCapability = facs?.enabled
    && context.attributes?.authInfo?.hasFacsPermission?.(`${facs.product.toLowerCase()}/can_view`);

  // FACS disabled, or the caller holds an org-wide can_view grant => no narrowing.
  if (!facs?.enabled || hasFACSCapability) {
    return null;
  }

  // Site-scoped products (ASO): grants live directly on sites.
  if (isFacsRebacResource(facs.product, 'site')) {
    const unavailable = requirePostgrestForFacsMappings(context);
    if (unavailable) {
      return unavailable;
    }
    return listViewableResourceIds(
      context.dataAccess.services.postgrestClient,
      {
        imsOrgId: organization.getImsOrgId(),
        product: facs.product,
        resourceType: 'site',
        subjectId: facs.subjectId,
      },
    );
  }

  // Brand-scoped products (LLMO): grants live on brands, so derive the viewable
  // sites from the caller's viewable brands. Flag-gated so it can ship dark.
  if (isFacsRebacResource(facs.product, 'brand')) {
    if (context.env?.[LLMO_BRAND_SITE_FILTER_FLAG] !== 'true') {
      return null;
    }
    const unavailable = requirePostgrestForFacsMappings(context);
    if (unavailable) {
      return unavailable;
    }
    const { postgrestClient } = context.dataAccess.services;
    const viewableBrandIds = await listViewableResourceIds(
      postgrestClient,
      {
        imsOrgId: organization.getImsOrgId(),
        product: facs.product,
        resourceType: 'brand',
        subjectId: facs.subjectId,
      },
    );
    // No viewable brands => no viewable sites (brand-less sites are excluded).
    if (viewableBrandIds.size === 0) {
      return new Set();
    }
    return listSiteIdsForBrands(organization.getId(), viewableBrandIds, postgrestClient);
  }

  // Product ReBAC-scopes neither `site` nor `brand` => no narrowing.
  return null;
}
