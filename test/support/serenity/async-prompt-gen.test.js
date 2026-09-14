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
import esmock from 'esmock';

import {
  isAsyncPromptGenEnabled,
  resolveStableImsUserId,
  callerMayReauth,
  toGenerationJobDto,
} from '../../../src/support/serenity/async-prompt-gen.js';

use(chaiAsPromised);
use(sinonChai);

function ctxWithProfile(profile) {
  return { attributes: { authInfo: { getProfile: () => profile } } };
}

function jobStub({
  status, result, error, metadata = {},
} = {}) {
  return {
    getId: () => 'job-9',
    getStatus: () => status,
    getResult: () => result,
    getError: () => error,
    getMetadata: () => metadata,
    getCreatedAt: () => '2026-09-01T00:00:00.000Z',
    getUpdatedAt: () => '2026-09-02T00:00:00.000Z',
  };
}

describe('async-prompt-gen', () => {
  describe('isAsyncPromptGenEnabled', () => {
    it('is on only for the explicit "true" flag', () => {
      expect(isAsyncPromptGenEnabled({ SERENITY_ASYNC_PROMPT_GEN: 'true' })).to.equal(true);
      expect(isAsyncPromptGenEnabled({ SERENITY_ASYNC_PROMPT_GEN: 'TRUE' })).to.equal(true);
      expect(isAsyncPromptGenEnabled({ SERENITY_ASYNC_PROMPT_GEN: 'false' })).to.equal(false);
      expect(isAsyncPromptGenEnabled({})).to.equal(false);
      expect(isAsyncPromptGenEnabled(undefined)).to.equal(false);
    });
  });

  describe('resolveStableImsUserId (strict, single-claim)', () => {
    it('reads ONLY user_id — never sub/email', () => {
      expect(resolveStableImsUserId(ctxWithProfile({ user_id: 'U1' }))).to.equal('U1');
      expect(resolveStableImsUserId(ctxWithProfile({ sub: 'S1', email: 'e@x' }))).to.equal(null);
      expect(resolveStableImsUserId(ctxWithProfile({}))).to.equal(null);
      expect(resolveStableImsUserId({})).to.equal(null);
    });
  });

  describe('callerMayReauth (fail-closed strict equality)', () => {
    it('permits only a matching, resolvable pair of ids', () => {
      expect(callerMayReauth('U1', 'U1')).to.equal(true);
      expect(callerMayReauth('U1', 'U2')).to.equal(false);
      expect(callerMayReauth(null, 'U1')).to.equal(false);
      expect(callerMayReauth('U1', null)).to.equal(false);
      expect(callerMayReauth('', '')).to.equal(false);
    });
  });

  describe('toGenerationJobDto (token-safe projection)', () => {
    it('never leaks the promise token or raw metadata', () => {
      const dto = toGenerationJobDto(jobStub({
        status: 'IN_PROGRESS',
        metadata: { promiseToken: { promise_token: 'SECRET' }, seeds: [1, 2], jobType: 'x' },
      }));
      const serialized = JSON.stringify(dto);
      expect(serialized).to.not.contain('SECRET');
      expect(serialized).to.not.contain('promiseToken');
      expect(serialized).to.not.contain('seeds');
      expect(dto).to.have.keys(['jobId', 'jobType', 'status', 'result', 'error', 'createdAt', 'updatedAt']);
      expect(dto.jobType).to.equal('generateSemrushMarket');
    });

    it('projects a whitelisted result only when COMPLETED', () => {
      const dto = toGenerationJobDto(jobStub({
        status: 'COMPLETED',
        result: {
          promptCount: 5, projectId: 'p9', published: true, verdict: 'ship', secretField: 'x',
        },
      }));
      expect(dto.result).to.deep.equal({
        promptCount: 5, projectId: 'p9', published: true, verdict: 'ship',
      });
      expect(dto.error).to.equal(null);
    });

    it('surfaces a needsReauth flag on a NEEDS_REAUTH failure', () => {
      const dto = toGenerationJobDto(jobStub({
        status: 'FAILED',
        error: { code: 'NEEDS_REAUTH', message: 'dead token', retryable: false },
      }));
      expect(dto.result).to.equal(null);
      expect(dto.error).to.deep.equal({
        code: 'NEEDS_REAUTH', message: 'dead token', retryable: false, needsReauth: true,
      });
    });
  });

  describe('maybeEnqueueMarketGeneration', () => {
    let enqueueStub;
    let maybeEnqueueMarketGeneration;

    let getBrandBaseSiteIdStub;
    beforeEach(async () => {
      enqueueStub = sinon.stub();
      getBrandBaseSiteIdStub = sinon.stub().resolves(null);
      ({ maybeEnqueueMarketGeneration } = await esmock('../../../src/support/serenity/async-prompt-gen.js', {
        '../../../src/support/serenity/handlers/semrush-market-generation-job.js': {
          enqueueSemrushMarketGeneration: enqueueStub,
          SEMRUSH_MARKET_GENERATION_PUBLIC_JOB_TYPE: 'generateSemrushMarket',
        },
        '../../../src/support/brands-storage.js': {
          getBrandBaseSiteId: getBrandBaseSiteIdStub,
        },
      }));
    });

    function siteCtx() {
      return {
        params: { spaceCatId: 'org-1' },
        dataAccess: { services: { postgrestClient: { from: () => ({}) } } },
        attributes: { authInfo: { getProfile: () => ({ user_id: 'U1' }) } },
      };
    }

    it('resolves siteId from the brand base site when the entry point supplies none (SEC-5 scoping)', async () => {
      getBrandBaseSiteIdStub.resolves('site-xyz');
      enqueueStub.resolves({ enqueued: true, jobId: 'job-1', status: 'IN_PROGRESS' });
      await maybeEnqueueMarketGeneration(siteCtx(), {
        enabled: true, generateRequested: true, producerParams: { brandId: 'b' },
      });
      expect(getBrandBaseSiteIdStub).to.have.been.calledWith('org-1', 'b');
      expect(enqueueStub.firstCall.args[1].siteId).to.equal('site-xyz');
    });

    it('keeps a supplied siteId and does not resolve the brand base site', async () => {
      enqueueStub.resolves({ enqueued: true, jobId: 'job-1', status: 'IN_PROGRESS' });
      await maybeEnqueueMarketGeneration(siteCtx(), {
        enabled: true, generateRequested: true, producerParams: { brandId: 'b', siteId: 'supplied-site' },
      });
      expect(getBrandBaseSiteIdStub).to.not.have.been.called;
      expect(enqueueStub.firstCall.args[1].siteId).to.equal('supplied-site');
    });

    it('leaves siteId undefined (siteless job) when the brand base-site resolve throws', async () => {
      getBrandBaseSiteIdStub.rejects(new Error('unresolvable'));
      enqueueStub.resolves({ enqueued: true, jobId: 'job-1', status: 'IN_PROGRESS' });
      await maybeEnqueueMarketGeneration(siteCtx(), {
        enabled: true, generateRequested: true, producerParams: { brandId: 'b' },
      });
      expect(enqueueStub.firstCall.args[1].siteId).to.equal(undefined);
    });

    it('returns null (no enqueue) when the feature is off or not requested', async () => {
      const off = await maybeEnqueueMarketGeneration({}, {
        enabled: false, generateRequested: true, producerParams: {},
      });
      const notRequested = await maybeEnqueueMarketGeneration({}, {
        enabled: true, generateRequested: false, producerParams: {},
      });
      expect(off).to.equal(null);
      expect(notRequested).to.equal(null);
      expect(enqueueStub).to.not.have.been.called;
    });

    it('returns null on an empty catalogue (no-seeds)', async () => {
      enqueueStub.resolves({ enqueued: false, reason: 'no-seeds' });
      const out = await maybeEnqueueMarketGeneration(ctxWithProfile({ user_id: 'U1' }), {
        enabled: true, generateRequested: true, producerParams: { brandId: 'b' },
      });
      expect(out).to.equal(null);
    });

    it('passes the caller stable id and maps an enqueued job to a provisioning handle', async () => {
      enqueueStub.resolves({ enqueued: true, jobId: 'job-1', status: 'IN_PROGRESS' });
      const out = await maybeEnqueueMarketGeneration(ctxWithProfile({ user_id: 'U1' }), {
        enabled: true, generateRequested: true, producerParams: { brandId: 'b' },
      });
      expect(out).to.deep.equal({ jobId: 'job-1', status: 'provisioning', reused: false });
      expect(enqueueStub.firstCall.args[1].imsUserId).to.equal('U1');
    });

    it('maps a reused live job to a provisioning handle', async () => {
      enqueueStub.resolves({ enqueued: false, reused: true, jobId: 'job-1' });
      const out = await maybeEnqueueMarketGeneration(ctxWithProfile({ user_id: 'U1' }), {
        enabled: true, generateRequested: true, producerParams: {},
      });
      expect(out).to.deep.equal({ jobId: 'job-1', status: 'provisioning', reused: true });
    });
  });
});
