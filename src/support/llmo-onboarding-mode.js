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

import { readFeatureFlag } from './feature-flags-storage.js';

export const LLMO_FEATURE_FLAG_PRODUCT = 'LLMO';
export const LLMO_BRANDALF_FLAG = 'brandalf';
export const LLMO_ONBOARDING_MODE_V1 = 'v1';
export const LLMO_ONBOARDING_MODE_V2 = 'v2';

/**
 * Brandalf GA cutoff in Unix epoch milliseconds (2026-04-01T00:00:00Z).
 * Any site whose createdAt is strictly before this value is treated as v1 (legacy).
 * Override per-environment via LLMO_BRANDALF_GA_CUTOFF_MS without a full redeploy.
 *
 * TEMPORARY — remove once all v1 customers have been migrated to v2.
 */
export const LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT = Date.UTC(2026, 3, 1);

export async function readBrandalfFlagOverride(organizationId, postgrestClient) {
  if (!organizationId || !postgrestClient?.from) {
    return null;
  }

  return readFeatureFlag({
    organizationId,
    product: LLMO_FEATURE_FLAG_PRODUCT,
    flagName: LLMO_BRANDALF_FLAG,
    postgrestClient,
  });
}

/**
 * Resolves the Brandalf GA cutoff from the environment (epoch ms).
 * Falls back to LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT if the env var is missing or invalid.
 *
 * TEMPORARY — remove once all v1 customers have been migrated to v2.
 *
 * @param {object} context - Request context
 * @returns {number} Cutoff timestamp in milliseconds
 */
export function resolveBrandalfCutoffMs(context) {
  const raw = context?.env?.LLMO_BRANDALF_GA_CUTOFF_MS;
  if (raw === undefined || raw === null || raw === '') {
    return LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    context?.log?.warn?.(
      `Invalid LLMO_BRANDALF_GA_CUTOFF_MS "${raw}", using default ${LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT}`,
    );
    return LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT;
  }
  return parsed;
}

/**
 * Returns true if the organization has any site whose createdAt is strictly before
 * the resolved cutoff. Sites with missing or unparseable createdAt are ignored (not
 * treated as legacy) to avoid false positives, but logged so monitoring can pick up
 * data-quality issues — silently swallowing them would bias the safeguard toward v2.
 *
 * TEMPORARY — remove once all v1 customers have been migrated to v2.
 *
 * @param {string} organizationId
 * @param {object} context - Request context (must have context.dataAccess.Site)
 * @returns {Promise<boolean>}
 */
export async function hasPreBrandalfSites(organizationId, context) {
  const cutoffMs = resolveBrandalfCutoffMs(context);
  const { Site } = context.dataAccess;
  const log = context?.log;
  const sites = await Site.allByOrganizationId(organizationId);
  return sites.some((s) => {
    const createdAt = s.getCreatedAt?.();
    if (createdAt === null || createdAt === undefined) {
      log?.warn?.(
        `Site ${s.getId?.() ?? '<unknown>'} in org ${organizationId} has no createdAt — skipping legacy check`,
      );
      return false;
    }
    const ts = createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();
    if (!Number.isFinite(ts)) {
      log?.warn?.(
        `Site ${s.getId?.() ?? '<unknown>'} in org ${organizationId} has unparseable createdAt "${createdAt}" — skipping legacy check`,
      );
      return false;
    }
    return ts < cutoffMs;
  });
}

/**
 * Resolves the LLMO onboarding mode (v1 or v2) for the given organization.
 *
 * Decision order:
 *  1. If LLMO_ONBOARDING_DEFAULT_VERSION is explicitly set to 'v1', return v1 immediately
 *     (global kill switch — skips the DB lookup).
 *  2. If the org has any site created before LLMO_BRANDALF_GA_CUTOFF_MS, return v1
 *     (legacy customer protection). If that org *also* has `brandalf=true` already
 *     set, log an error: this means a previously-migrated v2 org is being forced
 *     back to v1, which leaves the org in a mixed state (v2 flag + new v1 site)
 *     that needs manual remediation.
 *  3. Otherwise return v2 (new customer default).
 *
 * TEMPORARY — the legacy-customer check (step 2) should be removed once all v1
 * customers have been migrated to v2, at which point this function always returns v2.
 *
 * @param {string} organizationId
 * @param {object} context - Request context
 * @returns {Promise<'v1'|'v2'>}
 */
export async function resolveLlmoOnboardingMode(organizationId, context) {
  const { log = console } = context || {};

  // 1. Environment-level default.
  //    'v1' → global kill switch (everyone on v1, no DB lookup needed).
  //    'v2' or unset → proceed to per-org check.
  //    anything else → warn and treat as v2 (safe default for new customers).
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  if (configuredDefault === LLMO_ONBOARDING_MODE_V1) {
    return LLMO_ONBOARDING_MODE_V1;
  }
  if (configuredDefault && configuredDefault !== LLMO_ONBOARDING_MODE_V2) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${LLMO_ONBOARDING_MODE_V2}`,
    );
  }

  // 2. Protect legacy customers: any org with a pre-cutoff site stays on v1.
  try {
    if (await hasPreBrandalfSites(organizationId, context)) {
      // Detect the regression case: org has a pre-cutoff site but was *already*
      // migrated to v2 (brandalf flag set). Forcing back to v1 here will leave
      // a mixed v1/v2 state that the monitoring script needs to flag.
      // Best-effort — failure to read the flag must not block onboarding.
      try {
        const postgrestClient = context?.dataAccess?.services?.postgrestClient;
        const brandalfEnabled = await readBrandalfFlagOverride(organizationId, postgrestClient);
        if (brandalfEnabled === true) {
          log.error(
            `LLMO mode resolution: organization ${organizationId} has brandalf=true but also a pre-Brandalf-GA site. `
            + 'Forcing v1 will create a mixed v1/v2 state — manual remediation required.',
          );
        }
      } catch (flagError) {
        log.warn(
          `Failed to read brandalf flag for mixed-state check on org ${organizationId}: ${flagError.message}`,
        );
      }
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to check pre-Brandalf sites for organization ${organizationId}: ${error.message}`,
    );
    // Fall through to v2 — new orgs are unaffected; the monitoring script will
    // surface any legacy org that hit a transient error.
  }

  return LLMO_ONBOARDING_MODE_V2;
}
