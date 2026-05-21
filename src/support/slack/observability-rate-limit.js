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

/**
 * Best-effort, per-container rate limiter for observability Slack posts.
 *
 * A maintainer of a repo where Mysticat is installed could otherwise spam the
 * channel by re-requesting review in a loop. This caps posts to one per key per
 * window. It is in-memory and per-Lambda-container, so it is a soft cap (not a
 * guarantee), consistent with the best-effort posture of the feature.
 */

const MIN_GAP_MS = 10_000;
// Bound memory: when the tracked-key cap is hit, clear (best-effort reset)
// rather than track LRU — simplicity over precision for a soft limiter.
const MAX_TRACKED_KEYS = 1000;

const lastPostAt = new Map();

/**
 * @param {string} key - stable per-target key (e.g. `${owner}/${repo}#${pr}`)
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {boolean} true if the post should be SUPPRESSED (within the window)
 */
export function shouldRateLimitSlackPost(key, now = Date.now()) {
  const last = lastPostAt.get(key);
  if (last !== undefined && now - last < MIN_GAP_MS) {
    return true;
  }
  if (lastPostAt.size >= MAX_TRACKED_KEYS) {
    lastPostAt.clear();
  }
  lastPostAt.set(key, now);
  return false;
}

/** Test-only: reset the per-container state between tests. */
export function resetSlackRateLimit() {
  lastPostAt.clear();
}
