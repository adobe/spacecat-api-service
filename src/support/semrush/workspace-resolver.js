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
 * sets `semrushWorkspaceId`, the next /semrush/* call within ~30s starts
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
