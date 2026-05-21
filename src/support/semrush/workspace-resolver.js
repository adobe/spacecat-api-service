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
 * Module-scoped in-memory cache. AWS Lambda reuses module state across warm
 * invocations of the same container, so a Map here amortises Organization
 * reads to mysticat-data-service over the container's lifetime.
 *
 * Entries expire after CACHE_TTL_MS; a null workspace is cached too so a
 * non-onboarded org doesn't pay the round-trip on every /semrush/* call.
 *
 * Exported for unit tests; production code should not call clearWorkspaceCache.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

export function clearWorkspaceCache() {
  cache.clear();
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

  cache.set(spaceCatId, { value: workspaceId, expiresAt: now + CACHE_TTL_MS });
  return workspaceId;
}
