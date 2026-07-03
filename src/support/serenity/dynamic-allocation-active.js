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
 * The per-org rollout switch for **dynamic (just-in-time) AI resource allocation**, stored in the
 * `feature_flags` table (organization_id + product + flag_name). It is a SECOND, independent flag
 * from `LLMO/serenity`: serenity must already be active for an org, and this flag additionally
 * decides whether the sub-workspace metered ops top up JIT (ON) or keep the flat pre-calculated
 * carve (OFF).
 *
 * DEFAULT OFF and, per the dynamic-allocation rollout plan, it stays OFF for every org until the
 * PR-4 safeguards (per-org rightsizing sweep, concurrency serialization, the SLIs, and the
 * live-gateway canary) are in place — flipping it ON before then is unsafe. A missing/`false` row,
 * an unavailable PostgREST client, or a transient read error all resolve to `false`.
 */
export const DYNAMIC_ALLOCATION_FEATURE_FLAG_PRODUCT = 'LLMO';
// Lowercase snake_case per the feature-flags admin API validation (^[a-z][a-z0-9_]*$) —
// hyphens are rejected (see feature-flags-storage.js FLAG_NAME_PATTERN).
export const DYNAMIC_ALLOCATION_FEATURE_FLAG_NAME = 'dynamic_allocation';

/**
 * Module-scoped TTL+size-bounded cache — its own Map, separate from the serenity-flag cache, so the
 * two flags never collide. Positive value cached for the positive TTL; `false`/absent for the
 * shorter negative TTL so flipping an org ON takes effect within ~NEG_TTL_MS. Reuses the resolver's
 * TTL/size constants to stay in lockstep. Exported clear is for unit tests only.
 */
const flagCache = new Map();

/**
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @returns {string} composite cache key (org + product + flag).
 */
function flagCacheKey(spaceCatId) {
  return `${spaceCatId}::${DYNAMIC_ALLOCATION_FEATURE_FLAG_PRODUCT}::${DYNAMIC_ALLOCATION_FEATURE_FLAG_NAME}`;
}

export function clearDynamicAllocationFlagCache() {
  flagCache.clear();
}

function evictIfNeeded() {
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
 * Is dynamic (JIT) AI resource allocation active for an organization? Reads the org-wide
 * `LLMO/dynamic-allocation` feature flag (cached). Default OFF: a missing flag row, a `false` row,
 * an unavailable PostgREST client, or a transient read error all resolve to `false`, so an org is
 * never silently switched to JIT allocation.
 *
 * @param {object} ctx - Request context (uses `ctx.dataAccess.services.postgrestClient`).
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {object} [log] - Optional logger (surfaces a missing client / read error, never throws).
 * @returns {Promise<boolean>} `true` only when the org-wide dynamic-allocation flag is on.
 */
export async function isDynamicAllocationActiveForOrg(ctx, spaceCatId, log) {
  if (!hasText(spaceCatId)) {
    return false;
  }

  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    log?.warn?.('[serenity] isDynamicAllocationActiveForOrg: PostgREST client unavailable — treating dynamic allocation as inactive');
    return false;
  }

  const now = Date.now();
  const cacheKey = flagCacheKey(spaceCatId);
  const cached = flagCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let raw;
  try {
    raw = await readFeatureFlag({
      organizationId: spaceCatId,
      product: DYNAMIC_ALLOCATION_FEATURE_FLAG_PRODUCT,
      flagName: DYNAMIC_ALLOCATION_FEATURE_FLAG_NAME,
      postgrestClient,
    });
  } catch (e) {
    // Fail safe (inactive) on a transient read error, and do NOT cache it so a recovered DB takes
    // effect on the next call rather than after a TTL.
    log?.error?.(`[serenity] isDynamicAllocationActiveForOrg: failed to read flag for org ${spaceCatId}: ${e?.message}`);
    return false;
  }

  const value = raw === true;
  flagCache.delete(cacheKey);
  evictIfNeeded();
  flagCache.set(cacheKey, { value, expiresAt: now + (value ? CACHE_TTL_MS : NEG_TTL_MS) });
  return value;
}
