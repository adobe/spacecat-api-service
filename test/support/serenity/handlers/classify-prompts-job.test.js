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

import { TAG_IDS, makeListProjectTagsStub } from '../fixtures/tag-tree.js';

const WORKSPACE = 'workspace-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function makeJob(metadata) {
  return { getId: () => 'job-1', getMetadata: () => metadata };
}

async function load({ intentByTextMap, createAndEnqueueJobStub, transport }) {
  return esmock('../../../../src/support/serenity/handlers/classify-prompts-job.js', {
    '../../../../src/support/serenity/rest-transport.js': {
      createSerenityTransport: sinon.stub().returns(transport),
    },
    '../../../../src/support/serenity/async-job-runner.js': {
      createAndEnqueueJob: createAndEnqueueJobStub,
    },
    '../../../../src/support/serenity/branded-classifier.js': {
      brandNeedles: sinon.stub().returns([]),
      classifyBrandedTag: sinon.stub().returns('non-branded'),
    },
    '../../../../src/support/serenity/locations.js': {
      marketForGeoTargetId: sinon.stub().returns('US'),
    },
    '../../../../src/support/brands-storage.js': {
      getBrandAliases: sinon.stub().resolves([]),
    },
    '../../../../src/support/serenity/async-intent-classification.js': {
      classifyPromptIntentsUnbounded: sinon.stub().resolves(intentByTextMap),
    },
  });
}

describe('handlers/classify-prompts-job.js (serenity-docs#33)', () => {
  let transport;

  beforeEach(() => {
    transport = {
      listProjectTags: makeListProjectTagsStub(),
      createProjectTags: sinon.stub(),
      createPromptsWithMetadata: sinon.stub().resolves({ items: [{ id: 'created-prompt' }] }),
      publishProject: sinon.stub().resolves(),
      updatePromptTagsByIds: sinon.stub().resolves(),
      listProjects: sinon.stub().resolves({ items: [] }),
    };
  });

  function dataAccessFor(projects) {
    return {
      Brand: { findById: sinon.stub().resolves({ getName: () => 'Acme' }) },
      services: { postgrestClient: {} },
      BrandSemrushProject: { allByBrandId: sinon.stub().resolves(projects) },
    };
  }

  describe('mode: create (default) — CSV-import path', () => {
    it('creates every prompt WITH its classified intent and publishes once per affected project', async () => {
      const intentByTextMap = new Map([['great product', 'Task']]);
      const createAndEnqueueJobStub = sinon.stub();
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const project = { getGeoTargetId: () => 2840, getLanguageCode: () => 'en', getSemrushProjectId: () => 'proj-1' };
      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([project]),
      };
      const job = makeJob({
        brandId: 'brand-1',
        semrushWorkspaceId: WORKSPACE,
        prompts: [{
          text: 'great product', geoTargetId: 2840, languageCode: 'en', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');
      expect(result.created).to.have.lengthOf(1);
      expect(result.created[0].tagIds).to.include(TAG_IDS.intentTask);
      expect(result.published).to.equal(true);
      expect(result.pendingClassificationCount).to.equal(0);
      expect(result.requeuedJobId).to.equal(null);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('creates a prompt with NO intent value and requeues a reclassify job when classification is exhausted', async () => {
      const intentByTextMap = new Map([['ambiguous text', null]]);
      const requeuedJob = { getId: () => 'job-followup' };
      const createAndEnqueueJobStub = sinon.stub().resolves(requeuedJob);
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const project = { getGeoTargetId: () => 2840, getLanguageCode: () => 'en', getSemrushProjectId: () => 'proj-1' };
      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([project]),
      };
      const job = makeJob({
        brandId: 'brand-1',
        semrushWorkspaceId: WORKSPACE,
        promiseToken: { promise_token: 'ptok-current' },
        prompts: [{
          text: 'ambiguous text', geoTargetId: 2840, languageCode: 'en', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.created).to.have.lengthOf(1);
      // No `intent` value present under the root at all.
      expect(result.created[0].tagIds).to.not.include.members([
        TAG_IDS.intentInformational,
        TAG_IDS.intentTask,
        TAG_IDS.intentCommercial,
        TAG_IDS.intentTransactional,
        TAG_IDS.intentNavigational,
      ]);
      expect(result.pendingClassificationCount).to.equal(1);
      expect(result.requeuedJobId).to.equal('job-followup');
      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.jobType).to.equal('serenity-classify-prompts');
      expect(enqueueArgs.metadata.mode).to.equal('reclassify');
      expect(enqueueArgs.metadata.items).to.have.lengthOf(1);
      expect(enqueueArgs.metadata.items[0].promptId).to.equal('created-prompt');
      // Forwards the CURRENT job's already-exchanged promise token — never
      // mints a fresh one (the worker has no HTTP context to mint from).
      expect(enqueueArgs.promiseToken).to.deep.equal({ promise_token: 'ptok-current' });
      expect(enqueueArgs.metadata.requeueDepth).to.equal(1);
    });

    it('stops requeuing once the depth cap is reached, leaving the rest permanently pending', async () => {
      const intentByTextMap = new Map([['ambiguous text', null]]);
      const createAndEnqueueJobStub = sinon.stub();
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const project = { getGeoTargetId: () => 2840, getLanguageCode: () => 'en', getSemrushProjectId: () => 'proj-1' };
      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([project]),
      };
      const job = makeJob({
        brandId: 'brand-1',
        semrushWorkspaceId: WORKSPACE,
        requeueDepth: 5,
        prompts: [{
          text: 'ambiguous text', geoTargetId: 2840, languageCode: 'en', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.pendingClassificationCount).to.equal(1);
      expect(result.requeuedJobId).to.equal(null);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('subworkspace mode: resolves the slice from a live project listing, not the DB mapping', async () => {
      const intentByTextMap = new Map([['great product', 'Task']]);
      const createAndEnqueueJobStub = sinon.stub();
      transport.listProjects = sinon.stub().resolves({
        items: [{
          id: 'proj-live-1',
          settings: { ai: { location: { id: 2840 }, language: { name: 'en' } } },
        }],
      });
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const dataAccess = dataAccessFor([]);
      const context = { env: {}, log: fakeLog(), dataAccess };
      const job = makeJob({
        brandId: 'brand-1',
        semrushWorkspaceId: WORKSPACE,
        subworkspace: true,
        prompts: [{
          text: 'great product', geoTargetId: 2840, languageCode: 'en', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.created).to.have.lengthOf(1);
      expect(result.created[0].tagIds).to.include(TAG_IDS.intentTask);
      // The DB mapping is never consulted in subworkspace mode.
      expect(dataAccess.BrandSemrushProject.allByBrandId).to.not.have.been.called;
      expect(transport.listProjects).to.have.been.calledOnceWith(WORKSPACE);
    });

    it('skips a prompt whose slice has no matching project', async () => {
      const intentByTextMap = new Map([['x', 'Task']]);
      const createAndEnqueueJobStub = sinon.stub();
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([]),
      };
      const job = makeJob({
        brandId: 'brand-1',
        semrushWorkspaceId: WORKSPACE,
        prompts: [{
          text: 'x', geoTargetId: 2840, languageCode: 'en', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.created).to.have.lengthOf(0);
      expect(result.skipped).to.have.lengthOf(1);
    });
  });

  describe('mode: reclassify — patches existing prompts in place', () => {
    it('patches the resolved prompt via updatePromptTagsByIds (replace) and publishes', async () => {
      const intentByTextMap = new Map([['great product', 'Commercial']]);
      const createAndEnqueueJobStub = sinon.stub();
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([]),
      };
      const job = makeJob({
        mode: 'reclassify',
        semrushWorkspaceId: WORKSPACE,
        items: [{
          projectId: 'proj-1', promptId: 'prompt-1', text: 'great product', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.patched).to.have.lengthOf(1);
      expect(result.patched[0].intent).to.equal('Commercial');
      expect(result.pendingClassificationCount).to.equal(0);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('requeues whatever is still pending after a reclassify attempt, without patching it', async () => {
      const intentByTextMap = new Map([['still ambiguous', null]]);
      const requeuedJob = { getId: () => 'job-followup-2' };
      const createAndEnqueueJobStub = sinon.stub().resolves(requeuedJob);
      const { classifyPromptsHandler } = await load({
        intentByTextMap, createAndEnqueueJobStub, transport,
      });

      const context = {
        env: {}, log: fakeLog(), dataAccess: dataAccessFor([]),
      };
      const job = makeJob({
        mode: 'reclassify',
        semrushWorkspaceId: WORKSPACE,
        items: [{
          projectId: 'proj-1', promptId: 'prompt-1', text: 'still ambiguous', tagIds: [TAG_IDS.categoryRunningShoes],
        }],
      });

      const result = await classifyPromptsHandler(context, job, 'token');

      expect(result.patched).to.have.lengthOf(0);
      expect(result.pendingClassificationCount).to.equal(1);
      expect(result.requeuedJobId).to.equal('job-followup-2');
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.metadata.mode).to.equal('reclassify');
      expect(enqueueArgs.metadata.items[0].promptId).to.equal('prompt-1');
    });
  });
});
