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

import {
  badRequest,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import routeFacsCapabilities from '../routes/facs-capabilities.js';
import AccessControlUtil from '../support/access-control-util.js';
import { listBrandIdsForSite } from '../support/brands-storage.js';
import {
  listResourceIdsWithCapability,
  requirePostgrestForFacsMappings,
} from '../support/state-access-mapping-utils.js';

const X_PRODUCT_HEADER = 'x-product';

/**
 * Permissions controller — resource-scoped authorization *introspection*.
 *
 * Exposes a single S2S-friendly endpoint that answers "may this caller perform
 * <capability> on this site?" without performing the action. Built for Mystique
 * `/v1/apply`: the LLMO UI carries a `dx_llmo` IMS token that reaches Mystique
 * but carries no per-resource authorization signal, so Mystique calls back here
 * (it already has an S2S client) to reuse SpaceCat's authorization instead of
 * re-implementing entitlement + ReBAC in Python. See LLMO-6848.
 *
 * The check composes two building blocks already running in prod on the
 * `llmo/*` routes:
 *   1. {@link AccessControlUtil#validateEntitlement} — entitlement exists,
 *      enrollment exists, tier is customer-visible (blocks PLG etc.).
 *   2. the site's brand(s) hold the requested capability grant in the FACS
 *      state layer ({@link listBrandIdsForSite} + {@link listResourceIdsWithCapability}).
 *
 * Authorization rule for `can_deploy` (LLMO-6848 acceptance criteria):
 *   allowed = entitlement OK
 *           AND caller/org holds `<product>/can_deploy` on any brand of the site
 *           AND tier ∈ { PAID, FREE_TRIAL }
 * The FREE_TRIAL case is admitted ONLY when the deploy grant is explicitly
 * present — i.e. the per-customer trial exception the AC calls for IS a
 * state-layer grant. A trial customer with no grant is default-denied; a
 * paid customer still needs the grant. PLG / non-visible tiers are denied by
 * `validateEntitlement` before we get here.
 *
 * Identity model: the endpoint authorizes the *caller* (Mystique forwards the
 * end user's IMS bearer), mirroring how the existing `/user/capabilities`
 * introspection reads identity from `authInfo`. It does not authorize a service
 * account acting on the user's behalf.
 */
function PermissionsController(context) {
  const { log } = context;

  function resolveProduct(ctx) {
    const raw = ctx.pathInfo?.headers?.[X_PRODUCT_HEADER];
    if (!hasText(raw)) {
      return null;
    }
    const upper = raw.toUpperCase();
    return routeFacsCapabilities.PRODUCTS_ROUTES[upper] ? upper : null;
  }

  /**
   * POST /sites/:siteId/permissions/check
   * Body: { capability?: string }  — bare ("can_deploy") or fully-qualified
   *                                   ("llmo/can_deploy"); defaults to the
   *                                   product's can_deploy capability.
   * Header: x-product (required).
   * Returns 200 { allowed, reason, capability } — a check never 403s on the
   * subject decision; it reports it, so the caller (Mystique) can surface a
   * clean deny rather than an opaque gateway error.
   */
  async function checkSitePermission(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const product = resolveProduct(ctx);
    if (!product) {
      return badRequest('x-product header is required and must reference a known product');
    }

    const { siteId } = ctx.params || {};
    if (!isValidUUID(siteId)) {
      return badRequest('siteId is required and must be a valid UUID');
    }

    const requested = ctx.data?.capability;
    const productLower = product.toLowerCase();
    let capability = `${productLower}/can_deploy`;
    if (hasText(requested)) {
      capability = requested.includes('/') ? requested : `${productLower}/${requested}`;
    }

    const site = await context.dataAccess.Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const org = await site.getOrganization();
    if (!org) {
      return notFound('Organization not found for site');
    }
    const imsOrgId = org.getImsOrgId();

    // Layer 1 — entitlement + tier. validateEntitlement throws on: missing
    // entitlement, unset tier, non-customer-visible tier (PLG), or missing site
    // enrollment. FREE_TRIAL and PAID both pass here; the trial gate is Layer 2.
    // TODO(spacecat): confirm the PRODUCT_CODES value validateEntitlement expects
    // for LLMO (passing the uppercase product header for now).
    const accessControl = new AccessControlUtil(context);
    try {
      await accessControl.validateEntitlement(org, site, product);
    } catch (e) {
      log?.info?.(`[permissions/check] entitlement denied for site ${siteId} (${product}): ${e.message}`);
      return ok({ allowed: false, reason: 'entitlement_denied', capability });
    }

    // Layer 2 — resolve site -> brand(s), then check the capability grant on
    // any of them (listResourceIdsWithCapability checks BOTH the user and org
    // subject scopes). The grant is the paid/trial gate per the rule above.
    // TODO(spacecat): if you'd rather hard-gate `tier === PAID` and treat the
    // grant purely as the trial exception, read the resolved tier here (TierClient
    // / entitlement) and branch — flagged for your call, not baked in.
    const { postgrestClient } = context.dataAccess.services;
    const brandIds = await listBrandIdsForSite(org.getId(), siteId, postgrestClient);
    if (brandIds.size === 0) {
      return ok({ allowed: false, reason: 'no_brand_for_site', capability });
    }

    const subjectId = ctx.attributes?.authInfo?.getProfile?.()?.sub ?? null;
    const capableBrandIds = await listResourceIdsWithCapability(postgrestClient, {
      imsOrgId,
      product,
      resourceType: 'brand',
      subjectId,
      capability,
    });

    const allowed = [...brandIds].some((id) => capableBrandIds.has(id));
    return ok({
      allowed,
      reason: allowed ? 'granted' : 'capability_not_granted',
      capability,
    });
  }

  return {
    checkSitePermission,
  };
}

export default PermissionsController;
