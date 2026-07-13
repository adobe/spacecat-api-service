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
 * Per-key async serialization for same-child resource mutations (serenity-docs#22, item 5).
 *
 * The dynamic allocator's transfer is ABSOLUTE (it SETS `total`, not increments it). Two operations
 * that read the same child's `total` concurrently and then each write an absolute value clobber one
 * another — the later write wins with a value computed from a stale read, UNDER-provisioning the
 * child (e.g. a batch create-prompts fanning out with `mapLimit` across projects of the SAME child,
 * or two concurrent create-market calls). Serializing `ensureAiHeadroom` per child turns the
 * read-then-absolute-set into a critical section, so each op reads what the previous one wrote.
 *
 * SCOPE: this lock is IN-PROCESS only — it serializes contention WITHIN one warm Lambda container
 * (where the intra-request `mapLimit` fan-out and same-container concurrent requests race).
 * Cross-container serialization (two Lambda instances topping up one child at once) needs a
 * distributed lock or an async worker and is deferred to the PR-4 rollout hardening — the
 * fail-fast single-attempt transfer already shrinks that cross-instance window (fewer, faster
 * inline transfers, no multi-second settle hold).
 *
 * Queue depth is self-bounding: a key's chain is only as deep as the same-child ops in flight in
 * this container (the batch `mapLimit` fan-out is itself capped, e.g. `BULK_CREATE_CONCURRENCY`),
 * and the chain entry is evicted the moment it drains — so no explicit depth cap is needed.
 *
 * SAFETY VALVE (MysticatBot 2026-07-06 / 2026-07-09, Rainer 2026-07-13): the predecessor wait has
 * no timeout of its own. If a predecessor's `task` hangs (e.g. a transport call against a hung TCP
 * connection with no fetch-level timeout), every subsequent same-child op would otherwise queue
 * behind it FOREVER, until the warm container recycles — a single stuck write starves the whole
 * child. `LOCK_TIMEOUT_MS` bounds the wait: after it elapses, a waiter stops waiting on the
 * predecessor and runs anyway, trading a bounded, rare risk of racing the eventual absolute-set
 * from a hung predecessor for guaranteed forward progress. The predecessor's own `task` is NOT
 * cancelled by this — it keeps running and its result is still delivered to whoever originally
 * awaited it; only the QUEUE stops waiting on it.
 */

/** @type {Map<string, Promise<void>>} tail of the in-flight chain per key. */
const chains = new Map();

/** Default safety-valve wait (see the module doc above). Exported so a caller can reason about /
 * override it; `withResourceLock`'s own `timeoutMs` param is the per-call override point (tests use
 * a tiny value so the timeout path doesn't need a real multi-second wait). */
export const LOCK_TIMEOUT_MS = 10_000;

/**
 * Resolves once `promise` settles OR once `ms` elapses, whichever comes first. NEVER rejects — the
 * timeout is a safety valve, not a failure signal, so both branches resolve.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<void>}
 */
function settledOrTimedOut(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onSettled = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(onSettled, onSettled);
  });
}

/**
 * Runs `task` only after any previously-queued task for the same `key` has settled — OR after
 * `timeoutMs` elapses, whichever comes first (see the safety-valve note above) — serializing
 * same-key work into a chain. A rejected predecessor does NOT poison the queue (the next task runs
 * regardless), and the caller still receives `task`'s own result/rejection.
 *
 * @template T
 * @param {string} key - the serialization key (the child workspace id).
 * @param {() => Promise<T>} task - the critical section to run under the lock.
 * @param {number} [timeoutMs] - safety-valve wait cap (default {@link LOCK_TIMEOUT_MS}).
 * @returns {Promise<T>} resolves/rejects with `task`'s outcome.
 */
export function withResourceLock(key, task, timeoutMs = LOCK_TIMEOUT_MS) {
  const prev = chains.get(key) ?? Promise.resolve();
  // Wait for the predecessor to settle, but never longer than timeoutMs (the safety valve).
  const run = settledOrTimedOut(prev, timeoutMs).then(() => task());
  // The chain tail swallows settlement so (a) the next waiter starts regardless of this outcome and
  // (b) we never leave an unhandled rejection dangling on the stored tail.
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  // Evict once this is the last task in the chain so the Map can't grow unbounded over a warm
  // container's lifetime. If another task queued behind us, `chains.get(key)` is a newer tail, so
  // we leave it in place.
  tail.then(() => {
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  });
  return run;
}

/** Test-only: drop all in-flight chains. Production code never calls this. */
export function clearResourceLocks() {
  chains.clear();
}
