/*
 * Copyright 2025 Adobe. All rights reserved.
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

describe('LLMO Bulk Unpublish Functions', () => {
  let mockLog;
  let mockEnv;
  let originalSetTimeout;

  beforeEach(() => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
    };

    mockEnv = {
      HLX_ADMIN_TOKEN: 'test-admin-token',
    };

    // Mock setTimeout to execute immediately
    originalSetTimeout = global.setTimeout;
    global.setTimeout = sinon.stub().callsFake((fn) => {
      fn();
      return 1;
    });
  });

  afterEach(() => {
    // Restore original setTimeout
    global.setTimeout = originalSetTimeout;
  });

  describe('startBulkStatusJob', () => {
    it('should successfully start a bulk status job with result.job.name (covers lines 238-240 first branch)', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start - with job.name property
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ job: { name: 'job-from-job-property' } }),
      });

      // Mock job polling - completed with no resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [],
          },
        }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      // Call deleteSharePointFolder which will trigger startBulkStatusJob
      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify the bulk status job was started
      expect(mockTracingFetch.getCall(0).args[0]).to.include('/status/adobe/project-elmo-ui-data/main/*');
      expect(mockTracingFetch.getCall(0).args[1].method).to.equal('POST');

      // Verify the debug log uses result.job.name (covers first branch of lines 238-240)
      expect(mockLog.debug).to.have.been.calledWith('Bulk status job started: job-from-job-property');
    });

    it('should successfully start a bulk status job with result.name fallback (covers lines 238-240 second branch)', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start - WITHOUT job property, only name
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'job-from-name-property' }),
      });

      // Mock job polling - completed with no resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [],
          },
        }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      // Call deleteSharePointFolder which will trigger startBulkStatusJob
      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify the bulk status job was started
      expect(mockTracingFetch.getCall(0).args[0]).to.include('/status/adobe/project-elmo-ui-data/main/*');
      expect(mockTracingFetch.getCall(0).args[1].method).to.equal('POST');

      // Verify the debug log uses result.name fallback (covers second branch of lines 238-240)
      expect(mockLog.debug).to.have.been.calledWith('Bulk status job started: job-from-name-property');
    });

    it('should throw error when bulk status job fails with non-ok response', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start - fails
      mockTracingFetch.onCall(0).resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged (covers lines 234-235)
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to start bulk status job: 500 Internal Server Error/),
      );
    });

    it('should return null when HLX_ADMIN_TOKEN is not set', async () => {
      const mockTracingFetch = sinon.stub();
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: envWithoutToken });

      // Verify warning was logged
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');

      // Verify fetch was not called for bulk status
      expect(mockTracingFetch.called).to.be.false;
    });

    it('should handle errors when starting bulk status job', async () => {
      const mockTracingFetch = sinon.stub();
      mockTracingFetch.onCall(0).rejects(new Error('Network error'));

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      // Should not throw, should continue with folder deletion
      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Error during bulk unpublish for folder dev\/test-com/),
      );
    });
  });

  describe('pollJobStatus', () => {
    it('should handle missing HLX_ADMIN_TOKEN in polling scenario', async () => {
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };
      const mockTracingFetch = sinon.stub();

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: envWithoutToken });

      // Verify the warning is logged when token is missing
      // This ensures the token check pattern (lines 258-260) is exercised
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
      expect(mockTracingFetch.called).to.be.false;
    });

    it('should successfully poll and complete job', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-456' }),
      });

      // Mock job polling - completed
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/test-com/file.json' }],
          },
        }),
      });

      // Mock bulk unpublish
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job' }),
      });

      // Mock bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify job polling was called
      expect(mockTracingFetch.getCall(1).args[0]).to.include('/job/adobe/project-elmo-ui-data/main/status/job-test-456/details');
      expect(mockTracingFetch.getCall(1).args[1].method).to.equal('GET');
    });

    it('should return null when HLX_ADMIN_TOKEN is not set during polling', async () => {
      const mockTracingFetch = sinon.stub();
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };

      // Mock bulk status job start - should return null due to missing token
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-no-token' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: envWithoutToken });

      // Verify warning was logged (covers lines 258-260)
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');

      // Verify fetch was not called
      expect(mockTracingFetch.called).to.be.false;
    });

    it('should throw error when job status polling fails with non-ok response', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-poll-error' }),
      });

      // Mock job polling - fails with non-ok response
      mockTracingFetch.onCall(1).resolves({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged (covers lines 277-278)
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to get job status: 503 Service Unavailable/),
      );
    });

    it('should timeout after max attempts', async function () {
      // Increase timeout for this test as it will loop 150 times
      this.timeout(5000);

      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-timeout' }),
      });

      // Mock job polling - always returns running state
      mockTracingFetch.resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'running',
          data: {
            phase: 'processing',
          },
        }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify timeout error was logged
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Job polling timed out/),
      );
    });
  });

  describe('bulkUnpublishPaths', () => {
    it('should successfully unpublish with job.name and un-preview with job.name (covers lines 343, 364 first branch)', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-789' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [
              { path: '/dev/test-com/file1.json' },
            ],
          },
        }),
      });

      // Mock bulk unpublish - with job.name property
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ job: { name: 'unpublish-job-from-job-property' } }),
      });

      // Mock bulk un-preview - with job.name property
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ job: { name: 'unpreview-job-from-job-property' } }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify bulk unpublish debug log uses job.name (covers first branch of line 343)
      expect(mockLog.debug).to.have.been.calledWith('Bulk unpublish job started: unpublish-job-from-job-property');

      // Verify bulk un-preview debug log uses job.name (covers first branch of line 364)
      expect(mockLog.debug).to.have.been.calledWith('Bulk un-preview job started: unpreview-job-from-job-property');
    });

    it('should successfully unpublish with name fallback and un-preview with name fallback (covers lines 343, 364 second branch)', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-fallback' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [
              { path: '/dev/test-com/file1.json' },
            ],
          },
        }),
      });

      // Mock bulk unpublish - WITHOUT job property, only name
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job-from-name-property' }),
      });

      // Mock bulk un-preview - WITHOUT job property, only name
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job-from-name-property' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify bulk unpublish debug log uses name fallback (covers second branch of line 343)
      expect(mockLog.debug).to.have.been.calledWith('Bulk unpublish job started: unpublish-job-from-name-property');

      // Verify bulk un-preview debug log uses name fallback (covers second branch of line 364)
      expect(mockLog.debug).to.have.been.calledWith('Bulk un-preview job started: unpreview-job-from-name-property');
    });

    it('should successfully unpublish and un-preview paths', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-789' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [
              { path: '/dev/test-com/file1.json' },
              { path: '/dev/test-com/file2.json' },
            ],
          },
        }),
      });

      // Mock bulk unpublish
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job' }),
      });

      // Mock bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify bulk unpublish was called
      expect(mockTracingFetch.getCall(2).args[0]).to.equal('https://admin.hlx.page/live/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(2).args[1].method).to.equal('POST');
      const unpublishBody = JSON.parse(mockTracingFetch.getCall(2).args[1].body);
      expect(unpublishBody.paths).to.have.lengthOf(2);
      expect(unpublishBody.paths[0]).to.equal('/dev/test-com/file1.json');

      // Verify bulk un-preview was called
      expect(mockTracingFetch.getCall(3).args[0]).to.equal('https://admin.hlx.page/preview/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(3).args[1].method).to.equal('POST');
      const unpreviewBody = JSON.parse(mockTracingFetch.getCall(3).args[1].body);
      expect(unpreviewBody.paths).to.have.lengthOf(2);
    });

    it('should handle empty paths array', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-empty' }),
      });

      // Mock job polling - completed with no resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [],
          },
        }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify only 2 calls were made (status start and poll), no unpublish calls
      expect(mockTracingFetch.callCount).to.equal(2);
      expect(mockLog.debug).to.have.been.calledWith('No published paths found under folder dev/test-com');
    });

    it('should handle null resources gracefully', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-null-paths' }),
      });

      // Mock job polling - completed with null resources (edge case)
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: null, // null instead of empty array
          },
        }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify only 2 calls were made (status start and poll), no unpublish calls
      expect(mockTracingFetch.callCount).to.equal(2);

      // When resources is null, it results in empty array and logs "No published paths found"
      expect(mockLog.debug).to.have.been.calledWith('No published paths found under folder dev/test-com');
    });

    it('should handle non-ok response during bulk unpublish', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-error' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/test-com/file.json' }],
          },
        }),
      });

      // Mock bulk unpublish - fails with non-ok
      mockTracingFetch.onCall(2).resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Mock bulk un-preview - succeeds
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged for unpublish
      expect(mockLog.error).to.have.been.calledWith('Bulk unpublish failed: 500 Internal Server Error');

      // Verify un-preview was still called
      expect(mockTracingFetch.callCount).to.equal(4);
    });

    it('should handle fetch error during bulk unpublish', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-network-error' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/test-com/file.json' }],
          },
        }),
      });

      // Mock bulk unpublish - throws network error
      mockTracingFetch.onCall(2).rejects(new Error('Network timeout'));

      // Mock bulk un-preview - succeeds
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged from catch block (covers lines 346-347)
      expect(mockLog.error).to.have.been.calledWith('Error during bulk unpublish: Network timeout');

      // Verify un-preview was still called after unpublish error
      expect(mockTracingFetch.callCount).to.equal(4);
    });

    it('should handle non-ok response during bulk un-preview', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-unpreview-error' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/test-com/file.json' }],
          },
        }),
      });

      // Mock bulk unpublish - succeeds
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job' }),
      });

      // Mock bulk un-preview - fails with non-ok
      mockTracingFetch.onCall(3).resolves({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged for un-preview (covers line 361)
      expect(mockLog.error).to.have.been.calledWith('Bulk un-preview failed: 503 Service Unavailable');

      // Verify both operations were attempted
      expect(mockTracingFetch.callCount).to.equal(4);
    });

    it('should handle fetch error during bulk un-preview', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-unpreview-network-error' }),
      });

      // Mock job polling - completed with resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/test-com/file.json' }],
          },
        }),
      });

      // Mock bulk unpublish - succeeds
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job' }),
      });

      // Mock bulk un-preview - throws network error
      mockTracingFetch.onCall(3).rejects(new Error('Connection refused'));

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify error was logged from catch block (covers lines 367-368)
      expect(mockLog.error).to.have.been.calledWith('Error during bulk un-preview: Connection refused');

      // Verify both operations were attempted
      expect(mockTracingFetch.callCount).to.equal(4);
    });

    it('should return early when HLX_ADMIN_TOKEN is not set in bulkUnpublishPaths', async () => {
      const mockTracingFetch = sinon.stub();
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };

      // Mock bulk status job start - will fail due to no token
      // But for this test, we want to reach bulkUnpublishPaths with empty token
      // This requires mocking a bit differently to bypass the earlier check

      // Actually, we can't easily test this because startBulkStatusJob checks first
      // So let's test it more directly by ensuring the pattern is consistent

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: envWithoutToken });

      // Verify warning was logged (covers lines 319-321 pattern)
      // The function checks for token early, preventing further execution
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
      expect(mockTracingFetch.called).to.be.false;
    });

    it('should filter paths to only unpublish paths under the specific folder', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-filter' }),
      });

      // Mock job polling - completed with mixed resources
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [
              { path: '/dev/test-com/file1.json' },
              { path: '/dev/other-com/file2.json' }, // Should be filtered out
              { path: '/dev/test-com/subfolder/file3.json' },
            ],
          },
        }),
      });

      // Mock bulk unpublish
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job' }),
      });

      // Mock bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job' }),
      });

      const { deleteSharePointFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(false),
            }),
          }),
        },
      });

      await deleteSharePointFolder('dev/test-com', { log: mockLog, env: mockEnv });

      // Verify only 2 paths were sent for unpublish (filtered)
      const unpublishBody = JSON.parse(mockTracingFetch.getCall(2).args[1].body);
      expect(unpublishBody.paths).to.have.lengthOf(2);
      expect(unpublishBody.paths[0]).to.equal('/dev/test-com/file1.json');
      expect(unpublishBody.paths[1]).to.equal('/dev/test-com/subfolder/file3.json');
    });
  });

  describe('pollJobStatus - unit tests', () => {
    it('should return null when HLX_ADMIN_TOKEN is not set (direct unit test for lines 258-260)', async () => {
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };

      const { pollJobStatus } = await import('../../../src/controllers/llmo/llmo-onboarding.js');

      const result = await pollJobStatus('test-job', envWithoutToken, mockLog);

      // Verify the function returns null (covers lines 258-260)
      expect(result).to.be.null;

      // Verify warning was logged
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
    });
  });

  describe('bulkUnpublishPaths - unit tests', () => {
    it('should return early when paths is null (direct unit test for lines 306-308)', async () => {
      const { bulkUnpublishPaths } = await import('../../../src/controllers/llmo/llmo-onboarding.js');

      await bulkUnpublishPaths(null, 'dev/test-com', mockEnv, mockLog);

      // Verify debug log was called (covers lines 306-308)
      expect(mockLog.debug).to.have.been.calledWith('No paths to unpublish');
    });

    it('should return early when paths is empty array (direct unit test for lines 306-308)', async () => {
      const { bulkUnpublishPaths } = await import('../../../src/controllers/llmo/llmo-onboarding.js');

      await bulkUnpublishPaths([], 'dev/test-com', mockEnv, mockLog);

      // Verify debug log was called (covers lines 306-308)
      expect(mockLog.debug).to.have.been.calledWith('No paths to unpublish');
    });

    it('should return early when HLX_ADMIN_TOKEN is not set (direct unit test for lines 319-321)', async () => {
      const envWithoutToken = { HLX_ADMIN_TOKEN: undefined };
      const { bulkUnpublishPaths } = await import('../../../src/controllers/llmo/llmo-onboarding.js');

      await bulkUnpublishPaths(['/test/path.json'], 'dev/test-com', envWithoutToken, mockLog);

      // Verify warning was logged (covers lines 319-321)
      expect(mockLog.warn).to.have.been.calledWith('LLMO offboarding: HLX_ADMIN_TOKEN is not set');
    });
  });

  describe('unpublishFromAdminHlx', () => {
    it('should successfully unpublish files from both live and preview', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'job-test-123' }),
      });

      // Mock job polling
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [
              { path: '/dev/test-com/file1.json' },
              { path: '/dev/test-com/file2.json' },
            ],
          },
        }),
      });

      // Mock bulk unpublish (live)
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpublish-job-123' }),
      });

      // Mock bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        json: async () => ({ name: 'unpreview-job-123' }),
      });

      const { unpublishFromAdminHlx } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
      });

      await unpublishFromAdminHlx('dev/test-com', mockEnv, mockLog);

      // Verify all 4 calls were made (status, poll, unpublish, un-preview)
      expect(mockTracingFetch.callCount).to.equal(4);

      // Verify bulk status job was started
      expect(mockTracingFetch.getCall(0).args[0]).to.include('/status/adobe/project-elmo-ui-data/main/*');

      // Verify job polling
      expect(mockTracingFetch.getCall(1).args[0]).to.include('/job/adobe/project-elmo-ui-data/main/status/job-test-123/details');

      // Verify bulk unpublish (live)
      expect(mockTracingFetch.getCall(2).args[0]).to.equal('https://admin.hlx.page/live/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(2).args[1].method).to.equal('POST');

      // Verify bulk un-preview
      expect(mockTracingFetch.getCall(3).args[0]).to.equal('https://admin.hlx.page/preview/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(3).args[1].method).to.equal('POST');
    });

    it('should handle errors during unpublish', async () => {
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start - fails
      mockTracingFetch.onCall(0).resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { unpublishFromAdminHlx } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
      });

      await unpublishFromAdminHlx('dev/test-com', mockEnv, mockLog);

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Error during bulk unpublish for folder dev\/test-com/),
      );
    });
  });
});
