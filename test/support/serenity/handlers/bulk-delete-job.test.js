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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import {
  acceptBulkDelete,
  bulkDeleteHandler,
  BULK_DELETE_JOB_TYPE,
  BULK_DELETE_PUBLIC_JOB_TYPE,
} from '../../../../src/support/serenity/handlers/bulk-delete-job.js';

use(chaiAsPromised);

const fakeLog = () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

function makeJob(metadata) {
  return {
    statusVal: 'IN_PROGRESS',
    resultVal: null,
    errorVal: null,
    getId: () => 'job-1',
    getMetadata: () => metadata,
    getStatus: () => 'IN_PROGRESS',
    setResult(r) { this.resultVal = r; },
    setStatus(s) { this.statusVal = s; },
    setError(e) { this.errorVal = e; },
    save: sinon.stub().resolves(),
  };
}

describe('bulk-delete-job', () => {
  afterEach(() => sinon.restore());

  describe('acceptBulkDelete (producer validation)', () => {
    it('rejects an empty prompts array with 400', async () => {
      await expect(acceptBulkDelete({
        context: {}, brandId: 'b', orgId: 'o', workspaceId: 'w', body: { prompts: [] },
      })).to.be.rejected.then((e) => expect(e.status).to.equal(400));
    });

    it('rejects a prompts array over the max with 400', async () => {
      const prompts = Array.from({ length: 501 }, (_, i) => ({ semrushPromptId: `p${i}` }));
      await expect(acceptBulkDelete({
        context: {}, brandId: 'b', orgId: 'o', workspaceId: 'w', body: { prompts },
      })).to.be.rejected.then((e) => expect(e.status).to.equal(400));
    });
  });

  describe('bulkDeleteHandler (consumer)', () => {
    const metadata = {
      jobType: BULK_DELETE_JOB_TYPE,
      brandId: 'brand-1',
      orgId: 'org-1',
      workspaceId: 'ws-1',
      subworkspace: false,
      callerId: 'user@adobe.com',
      targets: [{ semrushPromptId: 'sp-1', geoTargetId: 2840, languageCode: 'en' }],
    };

    const context = () => ({
      env: {},
      log: fakeLog(),
      dataAccess: {
        BrandSemrushProject: {
          allByBrandId: sinon.stub().resolves([{
            getGeoTargetId: () => 2840,
            getLanguageCode: () => 'en',
            getSemrushProjectId: () => 'proj-1',
          }]),
        },
      },
    });

    it('runs the delete via the injected transport and completes the job with the result', async () => {
      const transport = {
        deletePromptsByIds: sinon.stub().resolves({}),
        publishProject: sinon.stub().resolves({}),
      };
      const job = makeJob(metadata);
      await bulkDeleteHandler(context(), job, 'access-token', transport);
      expect(transport.deletePromptsByIds).to.have.been.calledOnce;
      expect(job.statusVal).to.equal('COMPLETED');
      expect(job.resultVal).to.deep.include({ deleted: 1 });
      expect(job.save).to.have.been.called;
    });

    it('marks the job FAILED (non-retryable) on a deterministic error', async () => {
      const ctx = context();
      ctx.dataAccess.BrandSemrushProject.allByBrandId = sinon.stub().rejects(
        Object.assign(new Error('bad request'), { status: 400 }),
      );
      const job = makeJob(metadata);
      await bulkDeleteHandler(ctx, job, 'access-token', { deletePromptsByIds: sinon.stub() });
      expect(job.statusVal).to.equal('FAILED');
      expect(job.errorVal.retryable).to.equal(false);
    });

    it('rethrows a retryable job error on a transient 5xx (SQS redelivers)', async () => {
      const ctx = context();
      ctx.dataAccess.BrandSemrushProject.allByBrandId = sinon.stub().rejects(
        Object.assign(new Error('upstream 503'), { status: 503 }),
      );
      const job = makeJob(metadata);
      await expect(
        bulkDeleteHandler(ctx, job, 'access-token', { deletePromptsByIds: sinon.stub() }),
      ).to.be.rejected;
      expect(job.statusVal).to.not.equal('FAILED');
    });

    it('exposes the public job type constant for the poller', () => {
      expect(BULK_DELETE_PUBLIC_JOB_TYPE).to.equal('bulkDelete');
    });
  });
});
