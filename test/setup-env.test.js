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

import { expect } from 'chai';
import sinon from 'sinon';
import { mochaHooks } from './setup-env.js';

// This hook is the safety net for tests that leak global mutations between
// files in parallel mode. The contract: after every test, any global tracked
// by NATIVE_GLOBALS is restored to its module-load value, AND sinon's
// internal state is left consistent (no orphaned clocks or stubs).
describe('setup-env root afterEach hook', () => {
  const trackedGlobals = [
    'fetch',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'Date',
    'queueMicrotask',
    'setImmediate',
    'clearImmediate',
  ];

  const snapshot = {};

  before(() => {
    for (const prop of trackedGlobals) {
      snapshot[prop] = globalThis[prop];
    }
  });

  // Belt and suspenders: if a test below leaks despite the hook, force a
  // hard reset here so we don't poison the rest of the worker. Uses sinon's
  // proper uninstall path when available.
  afterEach(() => {
    for (const prop of trackedGlobals) {
      const cur = globalThis[prop];
      if (cur !== snapshot[prop]) {
        if (cur && cur.clock && typeof cur.clock.uninstall === 'function') {
          try {
            cur.clock.uninstall();
          } catch {
            /* ignore */
          }
        } else if (cur && typeof cur.restore === 'function') {
          try {
            cur.restore();
          } catch {
            /* ignore */
          }
        }
        globalThis[prop] = snapshot[prop];
      }
    }
  });

  it('restores a raw assignment to global.fetch', () => {
    const stub = () => 'leaked';
    globalThis.fetch = stub;
    expect(globalThis.fetch).to.equal(stub);

    mochaHooks.afterEach();

    expect(globalThis.fetch).to.equal(snapshot.fetch);
  });

  it('restores a standalone sinon stub assigned to global.fetch', () => {
    globalThis.fetch = sinon.stub().resolves({ ok: true });
    expect(globalThis.fetch.isSinonProxy).to.be.true;

    mochaHooks.afterEach();

    expect(globalThis.fetch).to.equal(snapshot.fetch);
  });

  it('restores a sinon property stub on global.fetch', () => {
    sinon.stub(globalThis, 'fetch').resolves({ ok: true });
    expect(typeof globalThis.fetch.restore).to.equal('function');

    mochaHooks.afterEach();

    expect(globalThis.fetch).to.equal(snapshot.fetch);
  });

  it('uninstalls sinon.useFakeTimers via the .clock back-reference, restoring Date and timers together', () => {
    // Deliberately don't capture the clock — simulates a test that forgets
    // to call clock.restore(). The hook must still uninstall sinon's clock
    // properly via the .clock back-ref on the faked globals, or sinon's
    // internal clock registry is left dirty and the next test that installs
    // fake timers in the same worker hangs.
    sinon.useFakeTimers();
    expect(globalThis.Date).to.not.equal(snapshot.Date);
    expect(globalThis.setTimeout).to.not.equal(snapshot.setTimeout);

    mochaHooks.afterEach();

    expect(globalThis.Date).to.equal(snapshot.Date);
    expect(globalThis.setTimeout).to.equal(snapshot.setTimeout);
    expect(globalThis.setInterval).to.equal(snapshot.setInterval);
    expect(globalThis.clearTimeout).to.equal(snapshot.clearTimeout);
    expect(globalThis.clearInterval).to.equal(snapshot.clearInterval);
    expect(globalThis.queueMicrotask).to.equal(snapshot.queueMicrotask);
    expect(globalThis.setImmediate).to.equal(snapshot.setImmediate);
    expect(globalThis.clearImmediate).to.equal(snapshot.clearImmediate);
  });

  it('lets a subsequent useFakeTimers install cleanly after a prior leak', () => {
    // The contract this protects: if test A leaks fake timers and the hook
    // cleans them, test B in the same worker can still install its own.
    sinon.useFakeTimers();
    mochaHooks.afterEach();

    expect(() => {
      const clock = sinon.useFakeTimers();
      clock.restore();
    }).to.not.throw();
  });

  it('is a no-op when nothing has been mutated', () => {
    expect(() => mochaHooks.afterEach()).to.not.throw();
    for (const prop of trackedGlobals) {
      expect(globalThis[prop]).to.equal(snapshot[prop]);
    }
  });

  it('swallows errors thrown by a misbehaving restore()', () => {
    globalThis.fetch = Object.assign(() => {}, {
      restore() { throw new Error('boom'); },
    });

    expect(() => mochaHooks.afterEach()).to.not.throw();
    expect(globalThis.fetch).to.equal(snapshot.fetch);
  });
});
