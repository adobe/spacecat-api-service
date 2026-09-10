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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import {
  isMarketConsumerReady,
  resetReadinessCache,
  READINESS_CACHE_TTL_MS,
} from '../../../src/support/serenity/market-worker-readiness.js';

use(chaiAsPromised);
use(sinonChai);

function ssmReturning(value) {
  return { send: sinon.stub().resolves({ Parameter: { Value: value } }) };
}

function makeCtx() {
  return { runtime: { region: 'us-east-1' }, log: { warn: sinon.stub() } };
}

describe('market-worker-readiness', () => {
  let ctx;
  beforeEach(() => {
    resetReadinessCache();
    ctx = makeCtx();
  });

  it('is ready ONLY when the SSM value is exactly "true"', async () => {
    expect(await isMarketConsumerReady(ctx, { ssmClient: ssmReturning('true') })).to.equal(true);
    resetReadinessCache();
    expect(await isMarketConsumerReady(ctx, { ssmClient: ssmReturning('false') })).to.equal(false);
    resetReadinessCache();
    expect(await isMarketConsumerReady(ctx, { ssmClient: ssmReturning('TRUE') })).to.equal(false);
  });

  it('fails closed (not ready) when the SSM read errors or the param is missing', async () => {
    const ssmClient = { send: sinon.stub().rejects(new Error('ParameterNotFound')) };
    expect(await isMarketConsumerReady(ctx, { ssmClient })).to.equal(false);
    expect(ctx.log.warn).to.have.been.called;
  });

  it('caches the result within the TTL and re-reads after it expires', async () => {
    const ssmClient = ssmReturning('true');
    const t0 = 1_000_000;
    expect(await isMarketConsumerReady(ctx, { ssmClient, now: t0 })).to.equal(true);
    // Within TTL: cached, no second SSM call.
    expect(await isMarketConsumerReady(ctx, { ssmClient, now: t0 + 1000 })).to.equal(true);
    expect(ssmClient.send).to.have.been.calledOnce;
    // After TTL: re-reads.
    await isMarketConsumerReady(ctx, { ssmClient, now: t0 + READINESS_CACHE_TTL_MS + 1 });
    expect(ssmClient.send).to.have.been.calledTwice;
  });
});
