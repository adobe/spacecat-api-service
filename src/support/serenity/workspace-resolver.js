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

/**
 * Module-scoped TTL+size-bounded cache. AWS Lambda reuses module state across
 * warm invocations of the same container, so a Map here amortises Organization
 * reads to mysticat-data-service over the container's lifetime.
 *
 * Two TTLs:
 *   - CACHE_TTL_MS  — positive results (a known workspaceId)
 *   - NEG_TTL_MS    — negative results (org has no workspace yet)
 *
 * The shorter negative TTL keeps newly-onboarded orgs from being stuck in a
 * 404 loop for the full 5-minute positive cache window: once an operator
 * sets `semrushWorkspaceId`, the next /serenity/* call within ~30s starts
 * succeeding.
 *
 * The cap (MAX_ENTRIES) is a defense-in-depth bound on memory growth — Lambda
 * containers are short-lived in practice, but a long-running warm container
 * processing many distinct orgs would otherwise grow the Map without bound.
 * When the cap is hit we evict the oldest entry (LRU-ish using insertion
 * order; reads do not refresh order).
 *
 * Exported for unit tests; production code should not call clearWorkspaceCache.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — positive
export const NEG_TTL_MS = 30 * 1000; // 30 seconds — negative
// Brand-subworkspace positive TTL is deliberately short. A brand's mode can
// flip at runtime (activate binds a sub-workspace; deactivate clears it), and
// this cache is process-local: clearBrandWorkspaceCache() only evicts the
// calling Lambda container, so every OTHER warm container keeps routing the
// brand in its stale mode until its own entry expires. Bounding the positive
// TTL to a few seconds caps that cross-instance staleness window — after a
// flip, a sibling instance re-reads the pointer within ~BRAND_CACHE_TTL_MS
// instead of up to CACHE_TTL_MS. The flips are rare and low-QPS, so the extra
// Brand.findById reads are negligible.
export const BRAND_CACHE_TTL_MS = 10 * 1000; // 10 seconds — positive (brand subworkspace)
export const MAX_ENTRIES = 1024;

const cache = new Map();

export function clearWorkspaceCache() {
  cache.clear();
}

function evictIfNeeded() {
  // Map iteration order is insertion order; the first key is the oldest.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    /* c8 ignore start -- defensive: cache.size>=MAX_ENTRIES implies a key exists */
    if (oldest === undefined) {
      break;
    }
    /* c8 ignore stop */
    cache.delete(oldest);
  }
}

/**
 * Resolves the Semrush workspace ID for a SpaceCat organization.
 *
 * @param {object} ctx - Request context (uses ctx.dataAccess.Organization).
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @returns {Promise<string|null>} The workspace ID, or null if the org is
 *   missing or has no `semrush_workspace_id` set. Controllers map null to
 *   HTTP 404.
 */
export async function resolveWorkspaceId(ctx, spaceCatId) {
  if (!hasText(spaceCatId)) {
    return null;
  }

  const now = Date.now();
  const cached = cache.get(spaceCatId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const Organization = ctx?.dataAccess?.Organization;
  if (!Organization || typeof Organization.findById !== 'function') {
    throw new Error('Organization data-access not available on context');
  }

  const org = await Organization.findById(spaceCatId);
  const workspaceId = (org && typeof org.getSemrushWorkspaceId === 'function')
    ? (org.getSemrushWorkspaceId() ?? null)
    : null;

  // Refresh insertion order so size eviction stays meaningful under churn.
  cache.delete(spaceCatId);
  evictIfNeeded();
  const ttl = workspaceId === null ? NEG_TTL_MS : CACHE_TTL_MS;
  cache.set(spaceCatId, { value: workspaceId, expiresAt: now + ttl });
  return workspaceId;
}

/**
 * Brand-level cache, mirroring the org cache above. Keyed by brandId, it holds
 * the brand's OWN subworkspace id (or null when no subworkspace is bound).
 * The flat-mode parent is NOT cached here — it is resolved fresh via
 * resolveWorkspaceId (itself cached), so a parent change can never go stale
 * behind a brand entry.
 *
 * Positive entries use the short BRAND_CACHE_TTL_MS (not CACHE_TTL_MS) because
 * a brand's mode can flip at runtime and this Map is process-local: an
 * activate/deactivate on one container clears only that container's entry, so
 * a sibling container can keep routing the brand in its stale mode until its
 * own entry expires. The short TTL bounds that cross-instance staleness window.
 *
 * Exported for unit tests; production code should not call clearBrandWorkspaceCache.
 */
const brandCache = new Map();

export function clearBrandWorkspaceCache() {
  brandCache.clear();
}

function evictBrandIfNeeded() {
  while (brandCache.size >= MAX_ENTRIES) {
    const oldest = brandCache.keys().next().value;
    /* c8 ignore start -- defensive: size>=MAX_ENTRIES implies a key exists */
    if (oldest === undefined) {
      break;
    }
    /* c8 ignore stop */
    brandCache.delete(oldest);
  }
}

async function resolveBrandSubworkspaceId(ctx, brandId) {
  if (!hasText(brandId)) {
    return null;
  }
  const now = Date.now();
  const cached = brandCache.get(brandId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const Brand = ctx?.dataAccess?.Brand;
  if (!Brand || typeof Brand.findById !== 'function') {
    throw new Error('Brand data-access not available on context');
  }

  const brand = await Brand.findById(brandId);
  const subworkspaceId = (brand && typeof brand.getSemrushWorkspaceId === 'function')
    ? (brand.getSemrushWorkspaceId() ?? null)
    : null;

  brandCache.delete(brandId);
  evictBrandIfNeeded();
  const ttl = subworkspaceId === null ? NEG_TTL_MS : BRAND_CACHE_TTL_MS;
  brandCache.set(brandId, { value: subworkspaceId, expiresAt: now + ttl });
  return subworkspaceId;
}

/**
 * Dual-mode resolution predicate (serenity design §3). Computes, in one place,
 * which workspace a brand's serenity operations run against and which mode the
 * handlers branch on:
 *
 *   { mode: 'subworkspace', workspaceId: <sub ws>,  parentWorkspaceId: <parent ws> }
 *   { mode: 'flat',         workspaceId: <parent ws>, parentWorkspaceId: <parent ws> }
 *
 * `parentWorkspaceId` (the org's shared workspace) is always resolved and
 * returned so callers that mint a sub-workspace on activate do not have to
 * re-resolve it. In flat mode `workspaceId` IS the parent and may be null (org
 * has no parent workspace yet); the controller maps that to 404, exactly as
 * today.
 *
 * @param {object} ctx - Request context (uses ctx.dataAccess.Brand + .Organization).
 * @param {string} spaceCatId - SpaceCat organization UUID (for the flat-mode parent).
 * @param {string} brandId - Brand UUID.
 * @returns {Promise<{mode: 'subworkspace'|'flat', workspaceId: string|null,
 *   parentWorkspaceId: string|null}>}
 */
export async function resolveBrandWorkspace(ctx, spaceCatId, brandId) {
  // Independent reads (brand subworkspace + org parent) — resolve concurrently
  // so a cold cache costs one round-trip, not two, on this hot-path predicate.
  const [subworkspaceId, parentWorkspaceId] = await Promise.all([
    resolveBrandSubworkspaceId(ctx, brandId),
    resolveWorkspaceId(ctx, spaceCatId),
  ]);
  if (hasText(subworkspaceId)) {
    return { mode: 'subworkspace', workspaceId: subworkspaceId, parentWorkspaceId };
  }
  return { mode: 'flat', workspaceId: parentWorkspaceId, parentWorkspaceId };
}
