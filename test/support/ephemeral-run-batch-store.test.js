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
/* eslint-disable max-classes-per-file */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  writeBatchManifest,
  writeSiteResult,
  readBatchStatus,
  BATCH_TTL_DAYS,
} from '../../src/support/ephemeral-run-batch-store.js';

use(sinonChai);

class MockPutObjectCommand {
  constructor(p) { this.input = p; }
}
class MockGetObjectCommand {
  constructor(p) { this.input = p; }
}
class MockListObjectsV2Command {
  constructor(p) { this.input = p; }
}

function createMockS3() {
  const sendStub = sinon.stub();
  return {
    s3Client: { send: sendStub },
    s3Bucket: 'test-bucket',
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
    sendStub,
  };
}

function makeBody(data) {
  return { Body: { transformToString: () => Promise.resolve(JSON.stringify(data)) } };
}

describe('ephemeral-run-batch-store', () => {
  let s3;

  beforeEach(() => {
    s3 = createMockS3();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('BATCH_TTL_DAYS', () => {
    it('exports a numeric TTL', () => {
      expect(BATCH_TTL_DAYS).to.equal(7);
    });
  });

  describe('writeBatchManifest()', () => {
    it('writes manifest to the correct S3 key', async () => {
      s3.sendStub.resolves();
      const manifest = { batchId: 'b-1', totalSites: 2 };

      await writeBatchManifest(s3, 'b-1', manifest);

      expect(s3.sendStub).to.have.been.calledOnce;
      const cmd = s3.sendStub.firstCall.args[0];
      expect(cmd.input.Bucket).to.equal('test-bucket');
      expect(cmd.input.Key).to.equal('ephemeral-runs/b-1/manifest.json');
      expect(cmd.input.ContentType).to.equal('application/json');
      expect(JSON.parse(cmd.input.Body)).to.deep.equal(manifest);
    });
  });

  describe('writeSiteResult()', () => {
    it('writes result to the correct S3 key', async () => {
      s3.sendStub.resolves();
      const result = { siteId: 's-1', status: 'completed' };

      await writeSiteResult(s3, 'b-1', 's-1', result);

      expect(s3.sendStub).to.have.been.calledOnce;
      const cmd = s3.sendStub.firstCall.args[0];
      expect(cmd.input.Key).to.equal('ephemeral-runs/b-1/results/s-1.json');
      expect(JSON.parse(cmd.input.Body)).to.deep.equal(result);
    });
  });

  describe('readBatchStatus()', () => {
    it('returns null when manifest does not exist (NoSuchKey)', async () => {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      s3.sendStub.rejects(err);

      const result = await readBatchStatus(s3, 'missing-batch');
      expect(result).to.be.null;
    });

    it('returns null when manifest returns 404', async () => {
      const err = new Error('Not Found');
      err.$metadata = { httpStatusCode: 404 };
      s3.sendStub.rejects(err);

      const result = await readBatchStatus(s3, 'missing-batch');
      expect(result).to.be.null;
    });

    it('throws for non-404 S3 errors', async () => {
      const err = new Error('Access Denied');
      err.name = 'AccessDenied';
      err.$metadata = { httpStatusCode: 403 };
      s3.sendStub.rejects(err);

      try {
        await readBatchStatus(s3, 'b-1');
        expect.fail('Expected error');
      } catch (e) {
        expect(e.message).to.equal('Access Denied');
      }
    });

    it('returns expired status when manifest is past expiry', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2025-01-08T00:00:00.000Z',
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
      };
      s3.sendStub.resolves(makeBody(manifest));

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('expired');
      expect(result.batchId).to.equal('b-1');
      expect(result.createdAt).to.equal('2025-01-01T00:00:00.000Z');
      expect(result.expiresAt).to.equal('2025-01-08T00:00:00.000Z');
    });

    it('returns in_progress when some sites are pending', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1', 's-2'],
        totalSites: 2,
        failedToEnqueue: [],
      };
      const siteResult = { siteId: 's-1', status: 'completed', completedAt: new Date().toISOString() };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(siteResult));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('in_progress');
      expect(result.progress.total).to.equal(2);
      expect(result.progress.completed).to.equal(1);
      expect(result.progress.pending).to.equal(1);
      expect(result.sites['s-1'].status).to.equal('completed');
      expect(result.sites['s-2'].status).to.equal('pending');
    });

    it('includes jobsPlan and per-site jobsEnqueued and jobsSkipped', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
        jobsPlan: {
          imports: { types: ['top-pages'], trafficAnalysisWeeks: 0 },
          audits: { types: ['lhs-mobile'] },
          teardownDelaySeconds: 14400,
        },
      };
      const siteResult = {
        siteId: 's-1',
        status: 'completed',
        completedAt: new Date().toISOString(),
        enqueued: {
          imports: [{ type: 'top-pages', status: 'queued' }],
          audits: [{ type: 'lhs-mobile', status: 'queued' }],
        },
        skipped: [{ type: 'cwv', kind: 'audit', reason: 'queue down' }],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(siteResult));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.jobsPlan).to.deep.equal(manifest.jobsPlan);
      expect(result.sites['s-1'].jobsEnqueued).to.deep.equal(siteResult.enqueued);
      expect(result.sites['s-1'].jobsSkipped).to.deep.equal(siteResult.skipped);
      expect(result.sites['s-1'].jobsFreshnessSkipped).to.be.undefined;
    });

    it('includes jobsFreshnessSkipped in site status when audits were skipped due to freshness', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
      };
      const siteResult = {
        siteId: 's-1',
        status: 'completed',
        completedAt: new Date().toISOString(),
        enqueued: { imports: [], audits: [{ type: 'meta-tags', status: 'queued' }] },
        skipped: [],
        freshnessSkipped: [
          { type: 'scrape-top-pages', reason: 'scrape-fresh' },
          { type: 'cwv', reason: 'opportunity-fresh' },
        ],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(siteResult));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.sites['s-1'].jobsFreshnessSkipped).to.deep.equal(siteResult.freshnessSkipped);
    });

    it('omits jobsFreshnessSkipped when freshnessSkipped array is empty', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
      };
      const siteResult = {
        siteId: 's-1',
        status: 'completed',
        completedAt: new Date().toISOString(),
        enqueued: { imports: [], audits: [] },
        skipped: [],
        freshnessSkipped: [],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(siteResult));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.sites['s-1'].jobsFreshnessSkipped).to.be.undefined;
    });

    it('returns completed when all sites have results', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1', 's-2'],
        totalSites: 2,
        failedToEnqueue: [],
      };
      const result1 = { siteId: 's-1', status: 'completed', completedAt: new Date().toISOString() };
      const result2 = {
        siteId: 's-2', status: 'failed', completedAt: new Date().toISOString(), error: { code: 'ERR', message: 'fail' },
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [
              { Key: 'ephemeral-runs/b-1/results/s-1.json' },
              { Key: 'ephemeral-runs/b-1/results/s-2.json' },
            ],
            IsTruncated: false,
          });
        }
        if (callCount === 3) return Promise.resolve(makeBody(result1));
        return Promise.resolve(makeBody(result2));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('completed');
      expect(result.progress.completed).to.equal(1);
      expect(result.progress.failed).to.equal(1);
      expect(result.progress.pending).to.equal(0);
      expect(result.failedSiteIds).to.deep.equal(['s-2']);
      expect(result.sites['s-2'].error).to.deep.equal({ code: 'ERR', message: 'fail' });
    });

    it('includes failedToEnqueue sites in failedSiteIds', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 2,
        failedToEnqueue: [{ siteId: 's-2', reason: 'SQS throttle' }],
      };
      const result1 = { siteId: 's-1', status: 'completed', completedAt: new Date().toISOString() };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(result1));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('completed');
      expect(result.failedSiteIds).to.deep.equal(['s-2']);
      expect(result.sites['s-2'].status).to.equal('enqueue_failed');
      expect(result.sites['s-2'].reason).to.equal('SQS throttle');
      expect(result.progress.failed).to.equal(1);
    });

    it('includes not_found sites in failedSiteIds', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
      };
      const result1 = { siteId: 's-1', status: 'not_found', completedAt: new Date().toISOString() };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(result1));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.failedSiteIds).to.deep.equal(['s-1']);
    });

    it('handles paginated ListObjectsV2 responses', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1', 's-2'],
        totalSites: 2,
        failedToEnqueue: [],
      };
      const result1 = { siteId: 's-1', status: 'completed', completedAt: new Date().toISOString() };
      const result2 = { siteId: 's-2', status: 'completed', completedAt: new Date().toISOString() };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: true,
            NextContinuationToken: 'token-1',
          });
        }
        if (callCount === 3) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-2.json' }],
            IsTruncated: false,
          });
        }
        if (callCount === 4) return Promise.resolve(makeBody(result1));
        return Promise.resolve(makeBody(result2));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.progress.completed).to.equal(2);
      expect(result.progress.pending).to.equal(0);
    });

    it('handles empty results gracefully', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        return Promise.resolve({ Contents: undefined, IsTruncated: false });
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('in_progress');
      expect(result.progress.pending).to.equal(1);
    });

    it('gracefully handles corrupted result files', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
        failedToEnqueue: [],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        // Simulate corrupted file
        return Promise.reject(new Error('corrupted'));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('in_progress');
      expect(result.sites['s-1'].status).to.equal('pending');
    });

    it('handles manifest without failedToEnqueue field', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        enqueuedSiteIds: ['s-1'],
        totalSites: 1,
      };
      const result1 = { siteId: 's-1', status: 'completed', completedAt: new Date().toISOString() };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        if (callCount === 2) {
          return Promise.resolve({
            Contents: [{ Key: 'ephemeral-runs/b-1/results/s-1.json' }],
            IsTruncated: false,
          });
        }
        return Promise.resolve(makeBody(result1));
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('completed');
      expect(result.failedToEnqueue).to.deep.equal([]);
    });

    it('handles manifest without expiresAt', async () => {
      const manifest = {
        batchId: 'b-1',
        createdAt: new Date().toISOString(),
        enqueuedSiteIds: [],
        totalSites: 0,
        failedToEnqueue: [],
      };

      let callCount = 0;
      s3.sendStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve(makeBody(manifest));
        return Promise.resolve({ Contents: undefined, IsTruncated: false });
      });

      const result = await readBatchStatus(s3, 'b-1');
      expect(result.status).to.equal('completed');
      expect(result.progress.total).to.equal(0);
    });
  });
});
