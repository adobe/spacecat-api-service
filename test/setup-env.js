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
// The set must cover everything sinon can swap out. `sinon.useFakeTimers()`
// in particular replaces `Date`, the timer family, `queueMicrotask`, and
// `setImmediate`/`clearImmediate`. Tracking only timers would risk a partial
// restore (timers reset to native while `Date` stays faked) — a state sinon
// itself never produces.
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

export const mochaHooks = {
  afterEach() {
    for (const [prop, native] of Object.entries(NATIVE_GLOBALS)) {
      const current = globalThis[prop];
      if (current !== native) {
        if (current && typeof current.restore === 'function') {
          try {
            current.restore();
          } catch {
            // Ignore any restore failure - the manual reset below is the
            // source of truth and runs regardless.
          }
        }
        if (globalThis[prop] !== native) {
          globalThis[prop] = native;
        }
      }
    }
  },
};
