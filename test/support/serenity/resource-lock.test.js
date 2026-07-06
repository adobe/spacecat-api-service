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
import { withResourceLock, clearResourceLocks } from '../../../src/support/serenity/resource-lock.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('resource-lock — withResourceLock', () => {
  afterEach(() => clearResourceLocks());

  it('serializes same-key tasks: the second does not start until the first settles', async () => {
    const order = [];
    const first = deferred();
    const p1 = withResourceLock('child-a', async () => {
      order.push('start-1');
      await first.promise;
      order.push('end-1');
      return 1;
    });
    const p2 = withResourceLock('child-a', async () => {
      order.push('start-2');
      return 2;
    });
    // p2 must NOT have started while p1 is in flight.
    await Promise.resolve();
    expect(order).to.deep.equal(['start-1']);
    first.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).to.equal(1);
    expect(r2).to.equal(2);
    expect(order).to.deep.equal(['start-1', 'end-1', 'start-2']);
  });

  it('runs different keys concurrently', async () => {
    const order = [];
    const a = deferred();
    const p1 = withResourceLock('child-a', async () => {
      order.push('start-a');
      await a.promise;
      order.push('end-a');
    });
    const p2 = withResourceLock('child-b', async () => {
      order.push('start-b');
    });
    await p2;
    // b started and finished while a is still blocked → keys are independent.
    expect(order).to.deep.equal(['start-a', 'start-b']);
    a.resolve();
    await p1;
    expect(order).to.deep.equal(['start-a', 'start-b', 'end-a']);
  });

  it('a rejected predecessor does not poison the queue, and the caller still sees its rejection', async () => {
    const p1 = withResourceLock('child-a', async () => {
      throw new Error('boom');
    });
    const p2 = withResourceLock('child-a', async () => 'ok');
    const e = await p1.catch((x) => x);
    expect(e).to.be.instanceOf(Error);
    expect(e.message).to.equal('boom');
    expect(await p2).to.equal('ok');
  });

  it('evicts the chain once idle so the map does not grow unbounded', async () => {
    await withResourceLock('child-a', async () => 'done');
    // A fresh call after the chain drained still works (new chain, no stale tail).
    expect(await withResourceLock('child-a', async () => 'again')).to.equal('again');
  });
});
