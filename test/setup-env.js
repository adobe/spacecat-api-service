/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { use } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import dotenv from 'dotenv';

use(sinonChai);
use(chaiAsPromised);

// eslint-disable-next-line no-console
console.log('Forcing HTTP/1.1 for Adobe Fetch');
process.env.HELIX_FETCH_FORCE_HTTP1 = 'true';
process.env.AWS_ACCESS_KEY_ID = 'fake-key-id';
process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
process.env.AWS_XRAY_SDK_ENABLED = 'false';
process.env.AWS_XRAY_CONTEXT_MISSING = 'IGNORE_ERROR';

dotenv.config({ override: true });

// Snapshot native globals at module load (before any test runs) so we can
// detect and undo leaks left behind by tests that mutate them. Required in
// parallel mode where multiple test files share a worker's globalThis and a
// leak in one file poisons the next (most commonly via `global.fetch = ...`).
//
// The set covers everything sinon can swap in via `useFakeTimers()` (Date,
// the timer family, queueMicrotask, setImmediate, clearImmediate). Tracking
// only timers would risk a partial restore — a state sinon itself never
// produces — if a future test forgets to call `clock.restore()`.
const NATIVE_GLOBALS = {
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  Date: globalThis.Date,
  queueMicrotask: globalThis.queueMicrotask,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
};

// Restore a swapped-in global to its native value. Returns true if anything
// was done. The order of attempts matters:
//   1. `.clock.uninstall()` — sinon `useFakeTimers()` attaches a back-ref to
//      the clock object on every faked global (Date, setTimeout, …). Calling
//      `uninstall()` is the only way to leave sinon's internal clock registry
//      consistent; raw reassignment leaves the registry pointing at a clock
//      that's no longer wired up, and the next `useFakeTimers()` call in the
//      same worker hangs or errors.
//   2. `.restore()` — sinon property stubs (`sandbox.stub(global, 'fetch')`).
//   3. Raw reassignment — handles standalone stubs and direct assignments
//      where neither helper is available.
function restoreGlobal(prop, native) {
  const current = globalThis[prop];
  if (current === native) {
    return false;
  }
  if (current && current.clock && typeof current.clock.uninstall === 'function') {
    try {
      current.clock.uninstall();
    } catch {
      /* fall through to manual reset */
    }
  } else if (current && typeof current.restore === 'function') {
    try {
      current.restore();
    } catch {
      /* fall through to manual reset */
    }
  }
  if (globalThis[prop] !== native) {
    globalThis[prop] = native;
  }
  return true;
}

export const mochaHooks = {
  afterEach() {
    for (const [prop, native] of Object.entries(NATIVE_GLOBALS)) {
      restoreGlobal(prop, native);
    }
  },
};
