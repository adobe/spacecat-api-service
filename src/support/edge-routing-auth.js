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

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import { exchangePromiseToken, getCookieValue } from './utils.js';

// IMS service codes that represent the LLMO/Elmo product in the user's productContexts.
// TODO: replace placeholder with the real IMS service code once confirmed.
export const LLMO_IMS_SERVICE_CODES = ['dx_llmo'];

// Name of the LLMO Admin IMS group used for trial customer authorization.
export const LLMO_ADMIN_GROUP_NAME = 'LLMO Admin';

/**
 * Reads the promiseToken cookie from the request and exchanges it for an IMS user access token.
 *
 * @param {object} context - The request context.
 * @returns {Promise<string>} The IMS user access token.
 * @throws {Error} With a `status` property (400 or 401) on failure.
 */
export async function getImsTokenFromCookie(context) {
  const rawPromiseToken = getCookieValue(context, 'promiseToken');
  if (!hasText(rawPromiseToken)) {
    const err = new Error('promiseToken cookie is required for CDN routing');
    err.status = 400;
    throw err;
  }

  const promiseToken = decodeURIComponent(rawPromiseToken);

  try {
    return await exchangePromiseToken(context, promiseToken);
  } catch (tokenError) {
    context.log?.error?.('Authentication failed with upstream IMS service', tokenError);
    const err = new Error('Authentication failed with upstream IMS service');
    err.status = 401;
    throw err;
  }
}

/**
 * Checks whether a paid user's IMS profile contains the LLMO product context.
 *
 * @param {object} imsUserProfile - The IMS user profile (result of getImsUserProfile).
 * @returns {boolean}
 */
export function hasPaidLlmoProductContext(imsUserProfile) {
  const productContexts = imsUserProfile?.projectedProductContext;
  if (!Array.isArray(productContexts) || productContexts.length === 0) {
    return false;
  }
  return productContexts.some(
    (ctx) => LLMO_IMS_SERVICE_CODES.includes(ctx?.prodCtx?.serviceCode),
  );
}

/**
 * Authorizes a user to perform CDN routing changes for LLMO edge optimize.
 *
 * Authorization rules:
 * - Paid tier: the user's IMS profile must contain an LLMO product context.
 * - Trial tier: the user must be a member of the LLMO Admin IMS group in the org.
 *
 * @param {object} context - The request context (must have imsClient, dataAccess).
 * @param {object} params
 * @param {object} params.org - The site's organization entity.
 * @param {string} params.imsOrgId - The IMS org ID.
 * @param {string} params.imsUserToken - The IMS user access token (from promiseToken exchange).
 * @param {string} params.userEmail - The authenticated user's email.
 * @param {string} params.siteId - Site ID (for log context).
 * @param {object} log - Logger.
 * @returns {Promise<void>} Resolves if authorized.
 * @throws {Error} With a `status` property (403 or 500) if not authorized or on unexpected error.
 */
export async function authorizeEdgeCdnRouting(context, {
  org, imsOrgId, imsUserToken, siteId,
}, log) {
  const { Entitlement: EntitlementCollection } = context.dataAccess;

  // Fetch the LLMO entitlement for this org
  let entitlement;
  try {
    entitlement = await EntitlementCollection.findByOrganizationIdAndProductCode(
      org.getId(),
      EntitlementModel.PRODUCT_CODES.LLMO,
    );
  } catch (err) {
    log.warn(`[edge-routing-auth] Failed to fetch entitlement for org ${org.getId()}: ${err.message}`);
  }

  const tier = entitlement?.getTier();
  const isPaid = tier === EntitlementModel.TIERS.PAID;
  const isTrial = tier === EntitlementModel.TIERS.FREE_TRIAL;
  log.info(`[edge-routing-auth] Site ${siteId} has entitlement tier '${tier}'`);

  if (isPaid) {
    // Paid: validate LLMO product context in the user's IMS profile
    let imsUserProfile;
    try {
      imsUserProfile = await context.imsClient.getImsUserProfile(imsUserToken);
    } catch (profileErr) {
      log.warn(`[edge-routing-auth] Failed to fetch IMS profile for site ${siteId}: ${profileErr.message}`);
      const err = new Error('Failed to validate user permissions');
      err.status = 403;
      throw err;
    }

    if (!hasPaidLlmoProductContext(imsUserProfile)) {
      log.warn(`[edge-routing-auth] Paid user lacks LLMO product context for site ${siteId}`);
      const err = new Error('User does not have \'Adobe LLM Optimizer Users\' IMS Product Profile access');
      err.status = 403;
      throw err;
    }

    return;
  }

  if (isTrial) {
    // Trial: validate LLMO Admin IMS group membership via user's org list
    if (!hasText(imsOrgId)) {
      const err = new Error('Only LLMO administrators or LLMO Admin group members can configure CDN routing');
      err.status = 403;
      throw err;
    }
    let isGroupMember = false;
    try {
      const orgs = await context.imsClient.getImsUserOrganizations(imsUserToken);
      const matchingOrg = orgs.find((o) => `${o.orgRef?.ident}@${o.orgRef?.authSrc}` === imsOrgId);
      if (matchingOrg) {
        const adminName = LLMO_ADMIN_GROUP_NAME.toLowerCase();
        isGroupMember = matchingOrg.groups?.some(
          (g) => g.groupName?.toLowerCase() === adminName,
        ) ?? false;
      }
    } catch (groupErr) {
      log.warn(`[edge-routing-auth] IMS group check failed for site ${siteId}: ${groupErr.message}`);
    }

    if (!isGroupMember) {
      const err = new Error(`Only '${LLMO_ADMIN_GROUP_NAME}' IMS Group members can configure CDN routing`);
      err.status = 403;
      throw err;
    }

    return;
  }

  // Unknown or missing tier
  log.warn(`[edge-routing-auth] Unrecognized entitlement tier '${tier}' for site ${siteId}`);
  const err = new Error('Site does not have an LLMO entitlement');
  err.status = 403;
  throw err;
}
