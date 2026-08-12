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
import esmock from 'esmock';

const SITE_ID = '48656b02-62cb-46c0-b3fe-4a1a0f0c3b2f';

describe('PromptSuggestionSchedulesController', () => {
  let sandbox;
  let Controller;
  let mockAccessControlUtil;
  let mockDrsClient;
  let ensurePromptSuggestionSchedules;
  let isPayingLlmoSite;
  let mockContext;
  let mockSite;

  before(async () => {
    Controller = (await esmock('../../../src/controllers/llmo/prompt-suggestion-schedules.js', {
      '../../../src/support/access-control-util.js': {
        default: { fromContext: () => mockAccessControlUtil },
      },
      '@adobe/spacecat-shared-drs-client': {
        default: { createFrom: () => mockDrsClient },
      },
      '../../../src/support/prompt-suggestion-schedules.js': {
        ensurePromptSuggestionSchedules: (...args) => ensurePromptSuggestionSchedules(...args),
        isPayingLlmoSite: (...args) => isPayingLlmoSite(...args),
      },
    })).default;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockSite = { getId: sandbox.stub().returns(SITE_ID) };

    mockAccessControlUtil = {
      hasAdminAccess: sandbox.stub().returns(true),
      hasS2SCapability: sandbox.stub().resolves({ allowed: false, reason: 'no-capability' }),
    };

    mockDrsClient = { isConfigured: sandbox.stub().returns(true) };

    isPayingLlmoSite = sandbox.stub().resolves(true);
    ensurePromptSuggestionSchedules = sandbox.stub().resolves({
      results: [
        { providerId: 'prompt_generation_semrush', status: 'created' },
        { providerId: 'prompt_generation_agentic_traffic', status: 'already-existed' },
        { providerId: 'prompt_generation_synthetic_personas', status: 'created' },
      ],
      allSucceeded: true,
    });

    mockContext = {
      log: {
        info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
      },
      params: { siteId: SITE_ID },
      invocation: { id: 'req-1' },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(mockSite) },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  const build = () => Controller(mockContext);

  it('throws without a context', () => {
    expect(() => Controller(undefined)).to.throw('Context required');
  });

  it('throws without dataAccess', () => {
    expect(() => Controller({ log: {} })).to.throw('Data access required');
  });

  describe('authorization', () => {
    it('denies a non-admin caller without the S2S capability (403)', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);
      mockAccessControlUtil.hasS2SCapability.resolves({ allowed: false, reason: 'no-capability' });

      const res = await build().createSchedules(mockContext);

      expect(res.status).to.equal(403);
      expect(ensurePromptSuggestionSchedules).to.not.have.been.called;
    });

    it('allows an admin caller (bypasses the S2S capability check)', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(true);

      const res = await build().createSchedules(mockContext);

      expect(res.status).to.equal(200);
      expect(mockAccessControlUtil.hasS2SCapability).to.not.have.been.called;
    });

    it('allows a non-admin S2S consumer holding the capability', async () => {
      mockAccessControlUtil.hasAdminAccess.returns(false);
      mockAccessControlUtil.hasS2SCapability.resolves({ allowed: true, clientId: 'client-9' });

      const res = await build().createSchedules(mockContext);

      expect(res.status).to.equal(200);
      expect(mockAccessControlUtil.hasS2SCapability).to.have.been.calledOnce;
    });
  });

  describe('validation', () => {
    it('returns 400 for an invalid siteId', async () => {
      mockContext.params.siteId = 'not-a-uuid';
      const res = await build().createSchedules(mockContext);
      expect(res.status).to.equal(400);
      expect(mockContext.dataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 404 for an unknown site', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const res = await build().createSchedules(mockContext);
      expect(res.status).to.equal(404);
      expect(ensurePromptSuggestionSchedules).to.not.have.been.called;
    });
  });

  describe('tier gate', () => {
    it('provisions recurring schedules for a paying site and returns per-pipeline results', async () => {
      const res = await build().createSchedules(mockContext);
      const body = await res.json();

      expect(res.status).to.equal(200);
      expect(ensurePromptSuggestionSchedules).to.have.been.calledOnce;
      expect(ensurePromptSuggestionSchedules.firstCall.args[0]).to.include({
        siteId: SITE_ID,
        isPaying: true,
      });
      expect(body.isPaying).to.equal(true);
      expect(body.skipped).to.equal(false);
      expect(body.allSucceeded).to.equal(true);
      expect(body.results).to.have.length(3);
    });

    it('skips a non-paying site without creating any schedule', async () => {
      isPayingLlmoSite.resolves(false);
      const res = await build().createSchedules(mockContext);
      const body = await res.json();

      expect(res.status).to.equal(200);
      expect(body.skipped).to.equal(true);
      expect(body.isPaying).to.equal(false);
      expect(body.reason).to.equal('not-paying');
      expect(ensurePromptSuggestionSchedules).to.not.have.been.called;
    });

    it('ignores a caller-supplied isPaying=true on a trial site (tier re-derived server-side)', async () => {
      // Server says trial; body says paying → must skip (no recurring schedule).
      isPayingLlmoSite.resolves(false);
      mockContext.data = { isPaying: true, tier: 'paid' };

      const res = await build().createSchedules(mockContext);
      const body = await res.json();

      expect(body.skipped).to.equal(true);
      expect(body.isPaying).to.equal(false);
      expect(ensurePromptSuggestionSchedules).to.not.have.been.called;
    });

    it('surfaces a per-pipeline failure (allSucceeded=false) with the failed provider', async () => {
      ensurePromptSuggestionSchedules.resolves({
        results: [
          { providerId: 'prompt_generation_semrush', status: 'created' },
          { providerId: 'prompt_generation_agentic_traffic', status: 'failed', error: 'DRS 500' },
          { providerId: 'prompt_generation_synthetic_personas', status: 'already-existed' },
        ],
        allSucceeded: false,
      });

      const res = await build().createSchedules(mockContext);
      const body = await res.json();

      expect(res.status).to.equal(200);
      expect(body.allSucceeded).to.equal(false);
      const failed = body.results.find((r) => r.status === 'failed');
      expect(failed.providerId).to.equal('prompt_generation_agentic_traffic');
      expect(failed.error).to.equal('DRS 500');
    });
  });

  describe('DRS availability', () => {
    it('returns 500 when the DRS client is not configured', async () => {
      mockDrsClient.isConfigured.returns(false);
      const res = await build().createSchedules(mockContext);
      expect(res.status).to.equal(500);
      expect(ensurePromptSuggestionSchedules).to.not.have.been.called;
    });
  });

  it('returns 500 when Site lookup throws', async () => {
    mockContext.dataAccess.Site.findById.rejects(new Error('db down'));
    const res = await build().createSchedules(mockContext);
    expect(res.status).to.equal(500);
  });
});
