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
export const LLMO_BRANDALF_MIGRATION_FLAG = 'brandalf_migration';
export const LLMO_ONBOARDING_MODE_V1 = 'v1';
export const LLMO_ONBOARDING_MODE_V2 = 'v2';

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
 * Reads the `brandalf_migration` flag for an org (LLMO-4723). The migration
 * flag is the safety-net state during the cohort rollout: orgs in this mode
 * still take v1 reads for *content*, but BP DB sync is on so v2 brand records
 * exist. The (org, site) → brand resolver endpoint treats this state as
 * v2-eligible so the BP Fargate runner can enter the v2 path during the
 * dual-publish window even before brandalf flips fully.
 *
 * TEMPORARY — remove with the rest of the brandalf_migration plumbing once
 * all customers have been migrated to brandalf=true.
 */
export async function readBrandalfMigrationFlagOverride(organizationId, postgrestClient) {
  if (!organizationId || !postgrestClient?.from) {
    return null;
  }

  return readFeatureFlag({
    organizationId,
    product: LLMO_FEATURE_FLAG_PRODUCT,
    flagName: LLMO_BRANDALF_MIGRATION_FLAG,
    postgrestClient,
  });
}

/**
 * Resolves the LLMO onboarding mode (v1 or v2) for the given organization.
 *
 * Decision order:
 *  1. If brandalf=true on the org → return v2 (explicit v2 migration).
 *  2. If brandalf_migration=true on the org → return v2. brandalf_migration
 *     marks an existing v1 customer that's mid-migration to v2: v2 brand
 *     entities exist and the org reads v2 config. Runs before the kill switch
 *     so ops can't accidentally pin a brandalf_migration org back to v1.
 *  3. If LLMO_ONBOARDING_DEFAULT_VERSION is 'v1' → return v1 (global kill
 *     switch for orgs that have not been migrated to v2).
 *  4. Otherwise → return v2 (default for everyone else).
 *
 * The legacy-site cutoff that previously forced pre-GA customers onto v1
 * (createdAt before LLMO_BRANDALF_GA_CUTOFF_MS) was removed in LLMO-7108 so every
 * new onboarding defaults to v2 unless the kill switch holds the org back.
 *
 * This is consumed on two paths, not just onboarding: performLlmoOnboarding
 * (which upserts brandalf=true org-wide on a v2 result) and the read-only
 * (org, site) -> brand resolver in brands.js (hit by BP refresh and the DRS
 * scheduler). Removing the cutoff flips a flagless pre-cutoff org to v2 on both
 * — the brand resolver now returns the v2 brand where it used to 404. It does
 * not by itself flip an already-onboarded org's brandalf flag (only an
 * onboarding does that, org-wide), and DRS gates on the flag independently, so a
 * still-flagless org keeps running v1 downstream until it is onboarded/flagged.
 *
 * TEMPORARY — the LLMO_ONBOARDING_DEFAULT_VERSION kill switch and the v1 branch
 * should be removed once all v1 customers have been migrated to v2, at which
 * point this collapses to "always v2".
 *
 * @param {string} organizationId
 * @param {object} context - Request context
 * @returns {Promise<'v1'|'v2'>}
 */
export async function resolveLlmoOnboardingMode(organizationId, context) {
  const { log = console } = context || {};
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  // 1. Brandalf flag check: if the org has brandalf=true, it has been
  //    explicitly migrated to v2. Honor it.
  let brandalfEnabled = false;
  try {
    brandalfEnabled = await readBrandalfFlagOverride(organizationId, postgrestClient) === true;
  } catch (flagError) {
    log.warn(
      `Failed to read brandalf flag for org ${organizationId}: ${flagError.message} — proceeding with default resolution`,
    );
  }

  // 1b. brandalf_migration short-circuit: orgs mid-migration have v2 brand
  //     entities and use v2 config, so always treat as v2. New onboardings
  //     set brandalf=true directly — this branch only fires for in-flight
  //     migrations. Runs BEFORE the env-level kill switch so brandalf_migration
  //     orgs aren't accidentally pinned to v1 by ops.
  if (!brandalfEnabled) {
    try {
      const migrationEnabled = await readBrandalfMigrationFlagOverride(
        organizationId,
        postgrestClient,
      );
      if (migrationEnabled === true) {
        log.info(
          `LLMO mode resolution: organization ${organizationId} has `
          + 'brandalf_migration=true — using v2',
        );
        return LLMO_ONBOARDING_MODE_V2;
      }
    } catch (migrationFlagError) {
      log.warn(
        `Failed to read brandalf_migration flag for org ${organizationId}: ${migrationFlagError.message} — proceeding with brandalf-only resolution`,
      );
    }
  }

  if (brandalfEnabled) {
    log.info(
      `LLMO mode resolution: organization ${organizationId} has brandalf=true — using v2`,
    );
    return LLMO_ONBOARDING_MODE_V2;
  }

  // 2. Environment-level default (brandalf is false/missing from here on).
  //    'v1' is the global kill switch; anything else defaults to v2.
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  if (configuredDefault === LLMO_ONBOARDING_MODE_V1) {
    return LLMO_ONBOARDING_MODE_V1;
  }
  if (configuredDefault && configuredDefault !== LLMO_ONBOARDING_MODE_V2) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${LLMO_ONBOARDING_MODE_V2}`,
    );
  }

  return LLMO_ONBOARDING_MODE_V2;
}
