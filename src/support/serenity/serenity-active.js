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

import { hasText } from '@adobe/spacecat-shared-utils';

import { readFeatureFlag } from '../feature-flags-storage.js';
import { CACHE_TTL_MS, NEG_TTL_MS, MAX_ENTRIES } from './workspace-resolver.js';

/**
 * The org-wide rollout switch for the Semrush-backed "serenity" experience,
 * stored in the `feature_flags` table (keyed organization_id + product +
 * flag_name). Flipping it to `true` activates serenity for that org; until
 * then the org's UI keeps reading the normal backend data — even if the org's
 * `semrush_workspace_id` / its brands' `semrush_sub_workspace_id` have
 * already been backfilled for rollout prep. This decouples the rollout from
 * provisioning.
 */
export const SERENITY_FEATURE_FLAG_PRODUCT = 'LLMO';
export const SERENITY_FEATURE_FLAG_NAME = 'serenity';

/**
 * The org-wide switch that pins the org's UI to the Serenity experience, set by
 * the same `feature_flags` table row shape as `serenity` above and read by the
 * frontend from `GET /organizations/:id/feature-flags/llmo` (LLMO-6565).
 *
 * On the backend it marks an org as past the migration window: its users are
 * provisioned in Semrush, so a Semrush failure on a brand edit is a real error
 * to surface rather than expected migration noise to absorb. See
 * `isSerenityUiActiveForOrg`.
 *
 * snake_case is mandatory, not stylistic: `feature_flags` carries a CHECK
 * constraint `flag_name ~ '^[a-z][a-z0-9_]*$'` (and `isValidFeatureFlagName`
 * mirrors it), so a hyphenated name cannot be stored at all. Clients matching on
 * this flag must use the same spelling.
 */
export const SERENITY_UI_FEATURE_FLAG_NAME = 'serenity_ui';

/**
 * Module-scoped TTL+size-bounded cache for the org-wide flag values, mirroring
 * the workspace-resolver cache (warm Lambda containers reuse module state, so a
 * Map here amortises the PostgREST flag read over the container's lifetime). A
 * `true` value caches for the positive TTL; a `false`/absent value caches for
 * the shorter negative TTL so flipping an org ON during rollout takes effect
 * within ~NEG_TTL_MS instead of the full positive window. Reuses the resolver's
 * TTL/size constants to stay in lockstep with it.
 *
 * Exported clear is for unit tests; production code should not call it.
 */
const flagCache = new Map();

/**
 * Composite cache key (org + product + flag), not the bare `spaceCatId`, so the
 * Map stays collision-proof now that this module caches more than one flag per
 * organization.
 *
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {string} flagName - Feature-flag name within the LLMO product.
 * @returns {string} The cache key.
 */
function flagCacheKey(spaceCatId, flagName) {
  return `${spaceCatId}::${SERENITY_FEATURE_FLAG_PRODUCT}::${flagName}`;
}

export function clearSerenityFlagCache() {
  flagCache.clear();
}

function evictIfNeeded() {
  // Map iteration order is insertion order; the first key is the oldest.
  while (flagCache.size >= MAX_ENTRIES) {
    const oldest = flagCache.keys().next().value;
    /* c8 ignore start -- defensive: size>=MAX_ENTRIES implies a key exists */
    if (oldest === undefined) {
      break;
    }
    /* c8 ignore stop */
    flagCache.delete(oldest);
  }
}

/**
 * Reads one cached org-wide `LLMO/<flagName>` feature flag. A missing flag row, a
 * `false` row, an unavailable PostgREST client, or a transient read error all
 * resolve to `false` (default OFF), so a flag is never silently on.
 *
 * @param {object} ctx - Request context (uses
 *   `ctx.dataAccess.services.postgrestClient`).
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {string} flagName - Feature-flag name within the LLMO product.
 * @param {object} [log] - Optional logger (used to surface a missing client /
 *   a read error without throwing on this hot path).
 * @returns {Promise<boolean>} `true` only when the flag row exists and is `true`.
 */
async function readCachedOrgFlag(ctx, spaceCatId, flagName, log) {
  if (!hasText(spaceCatId)) {
    return false;
  }

  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    log?.warn?.(`[serenity] readCachedOrgFlag: PostgREST client unavailable — treating ${flagName} as off`);
    return false;
  }

  const now = Date.now();
  const cacheKey = flagCacheKey(spaceCatId, flagName);
  const cached = flagCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let raw;
  try {
    raw = await readFeatureFlag({
      organizationId: spaceCatId,
      product: SERENITY_FEATURE_FLAG_PRODUCT,
      flagName,
      postgrestClient,
    });
  } catch (e) {
    // Fail safe (off) on a transient read error, and do NOT cache it so a
    // recovered DB takes effect on the very next call rather than after a TTL.
    log?.error?.(`[serenity] readCachedOrgFlag: failed to read ${flagName} flag for org ${spaceCatId}: ${e?.message}`);
    return false;
  }

  const value = raw === true;
  // Refresh insertion order so size eviction stays meaningful under churn.
  flagCache.delete(cacheKey);
  evictIfNeeded();
  flagCache.set(cacheKey, { value, expiresAt: now + (value ? CACHE_TTL_MS : NEG_TTL_MS) });
  return value;
}

/**
 * Central predicate: is the Semrush-backed "serenity" experience active for an
 * organization? Reads the org-wide `LLMO/serenity` feature flag (cached).
 *
 * This is the org-level rollout half of serenity activation. The serenity
 * controller composes it with the per-brand workspace resolution
 * (`resolveBrandWorkspace`), so a route is served only when BOTH this flag is
 * ON *and* a Semrush workspace resolves for the brand — i.e. "flag AND
 * workspace". Anything short of an explicit `true` resolves to `false`, so an
 * org is never silently activated.
 *
 * @param {object} ctx - Request context (uses
 *   `ctx.dataAccess.services.postgrestClient`).
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {object} [log] - Optional logger (used to surface a missing client /
 *   a read error without throwing on this hot path).
 * @returns {Promise<boolean>} `true` only when the org-wide serenity flag is on.
 */
export async function isSerenityActiveForOrg(ctx, spaceCatId, log) {
  return readCachedOrgFlag(ctx, spaceCatId, SERENITY_FEATURE_FLAG_NAME, log);
}

/**
 * Is the organization pinned to the Serenity UI? Reads the org-wide
 * `LLMO/serenity_ui` feature flag (cached).
 *
 * Backend meaning: the org is past the Semrush migration window. During the
 * migration an org's LLMO users may have no Semrush user record at all, so
 * Semrush answers 4xx on every call made on their behalf and brand edits absorb
 * that failure rather than reporting a write that did persist as broken. Once
 * this flag is on, that allowance ends and Semrush failures surface to the
 * caller — see the re-sync block in `src/controllers/brands.js`.
 *
 * Reads `false` unless the flag row is explicitly `true`, so the absorbing
 * behaviour stays the default for every org still mid-migration.
 *
 * @param {object} ctx - Request context (uses
 *   `ctx.dataAccess.services.postgrestClient`).
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {object} [log] - Optional logger (used to surface a missing client /
 *   a read error without throwing on this hot path).
 * @returns {Promise<boolean>} `true` only when the org-wide serenity_ui flag is on.
 */
export async function isSerenityUiActiveForOrg(ctx, spaceCatId, log) {
  return readCachedOrgFlag(ctx, spaceCatId, SERENITY_UI_FEATURE_FLAG_NAME, log);
}
