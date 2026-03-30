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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('Insights Controller', () => {
  let InsightsController;
  let runInsightsBatchStub;
  let readBatchStatusStub;
  let accessControlStub;

  const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(async () => {
    runInsightsBatchStub = sinon.stub();
    readBatchStatusStub = sinon.stub();
    accessControlStub = {
      hasAdminAccess: sinon.stub().returns(true),
    };

    const mod = await esmock('../../src/controllers/insights.js', {
      '../../src/support/insights-run-service.js': {
        runInsightsBatch: runInsightsBatchStub,
        MAX_BATCH_SITES: 600,
        PRESETS: { 'plg-full': {} },
      },
      '../../src/support/insights-batch-store.js': {
        readBatchStatus: readBatchStatusStub,
      },
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => accessControlStub,
        },
      },
    });
    InsightsController = mod.default;
  });

  afterEach(() => {
    sinon.restore();
  });

  function createCtx(overrides = {}) {
    return {
      dataAccess: {
        Site: {},
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
      },
      s3: {},
      ...overrides,
    };
  }

  describe('constructor', () => {
    it('throws when dataAccess is missing', () => {
      expect(() => InsightsController({})).to.throw('Valid data access configuration required');
    });

    it('throws when dataAccess is null', () => {
      expect(() => InsightsController({ dataAccess: null })).to.throw();
    });
  });

  // -----------------------------------------------------------------------
  // batchRun()
  // -----------------------------------------------------------------------
  describe('batchRun()', () => {
    it('returns 400 when siteIds is missing', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: {} });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteIds is empty', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: [] } });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteIds is not an array', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: 'not-array' } });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when siteIds exceeds max', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);
      const ids = Array.from({ length: 601 }, () => VALID_UUID);

      const response = await batchRun({ data: { siteIds: ids } });
      expect(response.status).to.equal(400);
    });

    it('returns 400 for invalid UUIDs in siteIds', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: ['not-uuid', VALID_UUID] } });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Invalid siteIds');
    });

    it('returns 400 for invalid preset', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({
        data: { siteIds: [VALID_UUID], preset: 'bad-preset' },
      });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when not admin', async () => {
      const ctx = createCtx();
      accessControlStub.hasAdminAccess.returns(false);
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: [VALID_UUID] } });
      expect(response.status).to.equal(403);
    });

    it('returns 202 on success', async () => {
      const ctx = createCtx();
      runInsightsBatchStub.resolves({ batchId: 'b-1', total: 1 });
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: [VALID_UUID] } });
      expect(response.status).to.equal(202);
    });

    it('returns 500 on service error', async () => {
      const ctx = createCtx();
      runInsightsBatchStub.rejects(new Error('fail'));
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({ data: { siteIds: [VALID_UUID] } });
      expect(response.status).to.equal(500);
    });

    it('handles undefined context.data', async () => {
      const ctx = createCtx();
      const { batchRun } = InsightsController(ctx);

      const response = await batchRun({});
      expect(response.status).to.equal(400);
    });
  });

  // -----------------------------------------------------------------------
  // batchStatus()
  // -----------------------------------------------------------------------
  describe('batchStatus()', () => {
    it('returns 400 for invalid batchId', async () => {
      const ctx = createCtx();
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({ params: { batchId: 'bad' } });
      expect(response.status).to.equal(400);
    });

    it('returns 403 when not admin', async () => {
      const ctx = createCtx();
      accessControlStub.hasAdminAccess.returns(false);
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({ params: { batchId: VALID_UUID } });
      expect(response.status).to.equal(403);
    });

    it('returns 404 when batch not found', async () => {
      const ctx = createCtx();
      readBatchStatusStub.resolves(null);
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({ params: { batchId: VALID_UUID } });
      expect(response.status).to.equal(404);
    });

    it('returns 200 with status data', async () => {
      const ctx = createCtx();
      readBatchStatusStub.resolves({ batchId: VALID_UUID, status: 'completed' });
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({ params: { batchId: VALID_UUID } });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.status).to.equal('completed');
    });

    it('returns 500 on read error', async () => {
      const ctx = createCtx();
      readBatchStatusStub.rejects(new Error('S3 down'));
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({ params: { batchId: VALID_UUID } });
      expect(response.status).to.equal(500);
    });

    it('handles missing params', async () => {
      const ctx = createCtx();
      const { batchStatus } = InsightsController(ctx);

      const response = await batchStatus({});
      expect(response.status).to.equal(400);
    });
  });
});
