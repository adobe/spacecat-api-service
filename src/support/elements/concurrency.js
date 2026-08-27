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

/**
 * Runs `mapper` over `items` with at most `limit` concurrent invocations,
 * preserving input order in the returned array. Bounds fan-out so a workspace
 * with many brands/projects can't spawn an unbounded number of parallel calls
 * (which risks upstream rate-limiting and connection-pool exhaustion).
 *
 * Shared by the Elements controller (per-brand DB fan-out) and service
 * (per-project element fan-out) — lives in the support layer so neither the
 * service nor other support code has to import controller code.
 *
 * @param {Array<T>} items - Items to map over.
 * @param {number} limit - Max concurrent invocations.
 * @param {(item: T, index: number) => Promise<R>} mapper - Async mapper.
 * @returns {Promise<Array<R>>} Results in input order.
 * @template T, R
 */
/* c8 ignore start -- LLMO-6086 POC endpoint; unit tests intentionally deferred */
export async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await mapper(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
/* c8 ignore stop */
