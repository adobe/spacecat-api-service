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
 */

/** @type {Map<string, Promise<void>>} tail of the in-flight chain per key. */
const chains = new Map();

/**
 * Runs `task` only after any previously-queued task for the same `key` has settled, serializing
 * same-key work into a chain. A rejected predecessor does NOT poison the queue (the next task runs
 * regardless), and the caller still receives `task`'s own result/rejection.
 *
 * @template T
 * @param {string} key - the serialization key (the child workspace id).
 * @param {() => Promise<T>} task - the critical section to run under the lock.
 * @returns {Promise<T>} resolves/rejects with `task`'s outcome.
 */
export function withResourceLock(key, task) {
  const prev = chains.get(key) ?? Promise.resolve();
  // Start `task` after the predecessor settles either way — a failed predecessor must not block the
  // queue, and its rejection is already owned by that call's own returned promise.
  const run = prev.then(() => task(), () => task());
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
