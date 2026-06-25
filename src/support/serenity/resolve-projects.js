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

/**
 * Resolves the sub-workspace project listing shared by the brand-edit across-markets
 * syncs (URLs / aliases / competitor benchmarks). When the caller already fetched the
 * projects it lists once and threads them through as `prefetchedProjects`, so the three
 * syncs reuse a single listing rather than each re-listing. The reuse is keyed on
 * `Array.isArray` (NOT truthiness): an explicit empty array `[]` is a valid prefetch
 * ("the sub-workspace has no projects — don't re-list"), whereas `null`/`undefined`
 * means "no prefetch supplied, list now".
 *
 * @param {object} transport - Semrush transport (must expose `listProjects`).
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {Array<object>|null} [prefetchedProjects=null] - a pre-fetched project listing
 *   to reuse, or null/undefined to list via `transport.listProjects`.
 * @returns {Promise<Array<object>>} the resolved project list (`[]` when the listing
 *   has no `items`).
 */
export async function resolveProjects(transport, workspaceId, prefetchedProjects = null) {
  if (Array.isArray(prefetchedProjects)) {
    return prefetchedProjects;
  }
  const listing = await transport.listProjects(workspaceId);
  return Array.isArray(listing?.items) ? listing.items : [];
}
