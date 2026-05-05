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

import { readFeatureFlag, upsertFeatureFlag } from './feature-flags-storage.js';

export const LLMO_FEATURE_FLAG_PRODUCT = 'LLMO';
export const LLMO_BRANDALF_FLAG = 'brandalf';
export const LLMO_BRANDALF_MIGRATION_FLAG = 'brandalf_migration';
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
 * Decision order (see decision matrix in v1-v2-onboarding-consistency-safeguard.md):
 *  1. If brandalf=true on the org:
 *     a. If kill switch is v1 AND org has pre-cutoff sites → revert brandalf
 *        flag to false, log warning, return v1 (row 1 remediation).
 *     b. Otherwise → return v2 (rows 3, 5, 7).
 *  2. If LLMO_ONBOARDING_DEFAULT_VERSION is 'v1' → return v1 (kill switch, rows 2, 4).
 *  3. If org has pre-cutoff sites → return v1 (legacy protection, row 6).
 *  4. Otherwise → return v2 (new customer default, row 8).
 *
 * TEMPORARY — should be removed once all v1 customers have been migrated to v2.
 *
 * @param {string} organizationId
 * @param {object} context - Request context
 * @param {object} [options]
 * @param {boolean} [options.readOnly=false] When true, the resolver computes the
 *   mode but skips the row-1 remediation that flips the brandalf flag back to
 *   false in the database. Read-only callers (e.g. high-traffic resolver
 *   endpoints called from BP refresh and the DRS scheduler) should pass
 *   `readOnly: true` so a GET never mutates org-level feature-flag state.
 * @param {boolean} [options.brandalfMigrationCountsAsV2=false] When true, an
 *   org with `brandalf_migration=true` (regardless of brandalf) is treated as
 *   v2. Used by the (org, site) → brand resolver endpoint so orgs in the
 *   migration safety-net window (Adobe today) can still surface their v2
 *   brand to the BP Fargate runner. Default false preserves the resolver's
 *   onboarding-mode contract for everyone else (LLMO-4723's truth table:
 *   brandalf=true → v2, brandalf_migration alone → v1).
 * @returns {Promise<'v1'|'v2'>}
 */
export async function resolveLlmoOnboardingMode(organizationId, context, options = {}) {
  const { readOnly = false, brandalfMigrationCountsAsV2 = false } = options;
  const { log = console } = context || {};
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  // 1. Brandalf flag check: if the org has brandalf=true, it has been
  //    explicitly migrated to v2. Honor it — except when the kill switch
  //    is active AND the org has pre-cutoff sites (row 1 remediation).
  let brandalfEnabled = false;
  try {
    brandalfEnabled = await readBrandalfFlagOverride(organizationId, postgrestClient) === true;
  } catch (flagError) {
    log.warn(
      `Failed to read brandalf flag for org ${organizationId}: ${flagError.message} — proceeding with default resolution`,
    );
  }

  // 1b. Brandalf-migration override: callers that treat the dual-publish
  //     migration window as v2-eligible (currently only the LLMO-4716 brand
  //     resolver endpoint) short-circuit to v2 when brandalf_migration=true.
  //     This must run BEFORE the env-level kill switch so brandalf_migration
  //     orgs aren't accidentally pinned to v1 by ops.
  if (!brandalfEnabled && brandalfMigrationCountsAsV2) {
    try {
      const migrationEnabled = await readBrandalfMigrationFlagOverride(
        organizationId,
        postgrestClient,
      );
      if (migrationEnabled === true) {
        log.info(
          `LLMO mode resolution: organization ${organizationId} has `
          + 'brandalf_migration=true (caller treats as v2-eligible) — using v2',
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
    const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;

    // Row 1: kill switch active + pre-cutoff sites + brandalf=true
    // → revert flag to false and force v1. Read-only callers compute the
    //   same downgrade decision but skip the upsert side effect — write
    //   paths (onboarding controllers) handle remediation explicitly.
    if (configuredDefault === LLMO_ONBOARDING_MODE_V1) {
      try {
        if (await hasPreBrandalfSites(organizationId, context)) {
          if (!readOnly) {
            try {
              await upsertFeatureFlag({
                organizationId,
                product: LLMO_FEATURE_FLAG_PRODUCT,
                flagName: LLMO_BRANDALF_FLAG,
                value: false,
                updatedBy: 'llmo-onboarding-mode-resolution',
                postgrestClient,
              });
              log.warn(
                `LLMO mode resolution: organization ${organizationId} has brandalf=true but also has `
                + 'pre-cutoff sites while kill switch is active. Reverted brandalf flag to false. '
                + 'This org has sites that require migration before it can use v2.',
              );
            } catch (revertError) {
              log.error(
                `Failed to revert brandalf flag for org ${organizationId}: ${revertError.message}. `
                + 'Flag may still be true — manual intervention required.',
              );
            }
          } else {
            log.info(
              `LLMO mode resolution (read-only): organization ${organizationId} has `
              + 'brandalf=true but kill switch is active and org has pre-cutoff sites. '
              + 'Returning v1 without flipping the brandalf flag.',
            );
          }
          return LLMO_ONBOARDING_MODE_V1;
        }
      } catch (error) {
        log.warn(
          `Failed to check pre-Brandalf sites for org ${organizationId}: ${error.message}`,
        );
        // Cannot confirm pre-cutoff sites — fall through to v2
        // (brandalf=true is still set, so honor the migration).
      }
    }

    // Rows 3, 5, 7: brandalf=true without row-1 condition → v2.
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

  // 3. Protect legacy customers: any org with a pre-cutoff site stays on v1.
  try {
    if (await hasPreBrandalfSites(organizationId, context)) {
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to check pre-Brandalf sites for organization ${organizationId}: ${error.message}`,
    );
  }

  return LLMO_ONBOARDING_MODE_V2;
}
