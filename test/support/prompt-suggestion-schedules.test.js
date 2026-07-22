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
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';

const SITE_ID = 'site-abc';

describe('prompt-suggestion-schedules support module', () => {
  let sandbox;
  let module;
  let tierClientStub;

  before(async () => {
    module = await esmock('../../src/support/prompt-suggestion-schedules.js', {
      '@adobe/spacecat-shared-tier-client': {
        default: { createForSite: async () => tierClientStub },
      },
    });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  const buildLog = () => ({
    info: sandbox.stub(), debug: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(),
  });

  const buildDrsClient = (overrides = {}) => ({
    isConfigured: sandbox.stub().returns(true),
    createSchedule: sandbox.stub().resolves({ scheduleId: 'sched-1', alreadyExisted: false }),
    submitJob: sandbox.stub().resolves({ job_id: 'job-1' }),
    ...overrides,
  });

  describe('PROMPT_SUGGESTION_PIPELINES', () => {
    it('declares each provider+cadence exactly once', () => {
      expect(module.PROMPT_SUGGESTION_PIPELINES.map(
        ({ providerId, cadence }) => [providerId, cadence],
      )).to.deep.equal([
        ['prompt_generation_semrush', 'twice_monthly'],
        ['prompt_generation_agentic_traffic', 'twice_monthly'],
        ['prompt_generation_synthetic_personas', 'quarterly'],
      ]);
    });
  });

  describe('ensurePromptSuggestionSchedules', () => {
    it('creates a recurring schedule per pipeline (paying) and reports created', async () => {
      const drsClient = buildDrsClient();
      const { results, allSucceeded } = await module.ensurePromptSuggestionSchedules({
        drsClient, siteId: SITE_ID, isPaying: true, log: buildLog(),
      });

      expect(allSucceeded).to.equal(true);
      expect(drsClient.createSchedule).to.have.been.calledThrice;
      expect(drsClient.submitJob).to.not.have.been.called;
      expect(results.map((r) => r.status)).to.deep.equal(['created', 'created', 'created']);
    });

    it('reports already-existed as success (idempotent)', async () => {
      const drsClient = buildDrsClient({
        createSchedule: sandbox.stub().resolves({ scheduleId: 's', alreadyExisted: true }),
      });
      const { results, allSucceeded } = await module.ensurePromptSuggestionSchedules({
        drsClient, siteId: SITE_ID, isPaying: true, log: buildLog(),
      });

      expect(allSucceeded).to.equal(true);
      expect(results.every((r) => r.status === 'already-existed')).to.equal(true);
    });

    it('submits a one-shot run per pipeline (trial) and reports submitted', async () => {
      const drsClient = buildDrsClient();
      const { results, allSucceeded } = await module.ensurePromptSuggestionSchedules({
        drsClient, siteId: SITE_ID, isPaying: false, log: buildLog(),
      });

      expect(allSucceeded).to.equal(true);
      expect(drsClient.submitJob).to.have.been.calledThrice;
      expect(drsClient.createSchedule).to.not.have.been.called;
      expect(results.map((r) => r.status)).to.deep.equal(['submitted', 'submitted', 'submitted']);
    });

    it('surfaces a single pipeline failure without masking the others (allSucceeded=false)', async () => {
      const err = new Error('DRS POST /schedules failed: 500');
      err.status = 500;
      const createSchedule = sandbox.stub();
      // First pipeline fails, the rest succeed.
      createSchedule.onCall(0).rejects(err);
      createSchedule.resolves({ scheduleId: 's', alreadyExisted: false });
      const drsClient = buildDrsClient({ createSchedule });
      const log = buildLog();

      const { results, allSucceeded } = await module.ensurePromptSuggestionSchedules({
        drsClient, siteId: SITE_ID, isPaying: true, log,
      });

      expect(allSucceeded).to.equal(false);
      const failed = results.filter((r) => r.status === 'failed');
      expect(failed).to.have.length(1);
      expect(failed[0].providerId).to.equal('prompt_generation_semrush');
      expect(failed[0].error).to.equal('DRS POST /schedules failed: 500');
      // The other two still succeeded.
      expect(results.filter((r) => r.status === 'created')).to.have.length(2);
      expect(log.error).to.have.been.calledWithMatch(/status=500/);
    });

    it('short-circuits to empty results when DRS is not configured', async () => {
      const drsClient = buildDrsClient({ isConfigured: sandbox.stub().returns(false) });
      const result = await module.ensurePromptSuggestionSchedules({
        drsClient, siteId: SITE_ID, isPaying: true, log: buildLog(),
      });
      expect(result).to.deep.equal({ results: [], allSucceeded: true });
      expect(drsClient.createSchedule).to.not.have.been.called;
    });
  });

  describe('isPayingLlmoSite', () => {
    const buildSite = () => ({ getId: sandbox.stub().returns(SITE_ID) });

    it('returns true when the current LLMO tier is PAID', async () => {
      tierClientStub = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getTier: () => EntitlementModel.TIERS.PAID },
        }),
      };
      const result = await module.isPayingLlmoSite(buildSite(), { log: buildLog() });
      expect(result).to.equal(true);
    });

    it('returns false for a non-PAID tier', async () => {
      tierClientStub = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getTier: () => EntitlementModel.TIERS.FREE_TRIAL },
        }),
      };
      const result = await module.isPayingLlmoSite(buildSite(), { log: buildLog() });
      expect(result).to.equal(false);
    });

    it('fails safe to false (with a warning) when no entitlement is found', async () => {
      tierClientStub = {
        checkValidEntitlement: sandbox.stub().resolves({ entitlement: null }),
      };
      const log = buildLog();
      const result = await module.isPayingLlmoSite(buildSite(), { log });
      expect(result).to.equal(false);
      expect(log.warn).to.have.been.calledWithMatch(/no entitlement found/);
    });

    it('fails safe to false (with a warning) when the lookup throws', async () => {
      tierClientStub = {
        checkValidEntitlement: sandbox.stub().rejects(new Error('tier service down')),
      };
      const log = buildLog();
      const result = await module.isPayingLlmoSite(buildSite(), { log });
      expect(result).to.equal(false);
      expect(log.warn).to.have.been.calledWithMatch(/tier service down/);
    });
  });
});
