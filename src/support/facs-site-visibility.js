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
import { requirePostgrestForFacsMappings } from './postgrest-availability.js';
import { isFacsRebacResource } from '../routes/facs-capabilities.js';

/**
 * Resolves the set of an organization's sites a FACS-enrolled,
 * resource-scoped caller may view via a state-layer `can_view` grant.
 *
 * Shared by `getSitesForOrganization` and `getProjectsByOrganizationId`
 * (`controllers/organizations.js`) so the authorization boundary — the
 * capability check, the cross-product bypass, the PostgREST-availability
 * guard, and the `listViewableResourceIds` call — exists in exactly one
 * place instead of drifting between two copies.
 *
 * @param {object} context - Universal request context.
 * @param {object} organization - Organization model instance owning the sites.
 * @returns {Promise<Set<string>|Response|null>} `null` when no filtering
 *   applies (FACS disabled, caller holds an org-wide `<product>/can_view`
 *   JWT permission, or the product does not ReBAC-scope `site` — e.g. LLMO,
 *   which scopes `brand`) — callers should return the full collection
 *   unfiltered. A `Response` when PostgREST is unavailable — callers must
 *   return it directly. Otherwise a `Set<siteId>` of viewable site ids.
 */
export async function resolveViewableSiteIds(context, organization) {
  const facs = context.attributes?.facs;
  const hasFACSCapability = facs?.enabled
    && context.attributes?.authInfo?.hasFacsPermission?.(`${facs.product.toLowerCase()}/can_view`);

  if (!facs?.enabled || hasFACSCapability || !isFacsRebacResource(facs.product, 'site')) {
    return null;
  }

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
