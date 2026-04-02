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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

describe('PreflightChecks Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockSite = {
    getId: () => siteId,
    getBaseURL: () => 'https://www.example.com',
    getOrganization: sandbox.stub().resolves({
      getId: () => 'org-123',
      getImsOrgId: () => 'imsOrg123@AdobeOrg',
    }),
    getDeliveryConfig: () => ({
      authorURL: 'https://author-p123-e456.adobeaemcloud.com',
    }),
  };

  const mockDataAccess = {
    Site: {
      findById: sandbox.stub().resolves(mockSite),
    },
  };

  const mockAccessControlUtil = {
    hasAccess: sandbox.stub().resolves(true),
    hasAdminAccess: sandbox.stub().returns(false),
  };

  let contentApiHandlerStub;
  let PreflightChecksController;

  before(async () => {
    contentApiHandlerStub = sandbox.stub();

    PreflightChecksController = await esmock('../../src/controllers/preflight-checks.js', {
      '../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
      '../../src/support/preflight-checks/registry.js': {
        default: {
          'content-api-access': contentApiHandlerStub,
        },
      },
    });
  });

  let controller;

  beforeEach(() => {
    controller = PreflightChecksController.default({
      dataAccess: mockDataAccess,
      log: loggerStub,
    });

    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockAccessControlUtil.hasAccess = sandbox.stub().resolves(true);
    contentApiHandlerStub.reset();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws if context has no dataAccess', () => {
    expect(() => PreflightChecksController.default({ dataAccess: null, log: loggerStub }))
      .to.throw('Valid data access configuration required');
  });

  it('throws if context is null', () => {
    expect(() => PreflightChecksController.default(null))
      .to.throw('Valid data access configuration required');
  });

  describe('runChecks', () => {
    it('returns 400 when params and data are undefined', async () => {
      const response = await controller.runChecks({});

      expect(response.status).to.equal(400);
    });

    it('returns 400 when checks array is missing', async () => {
      const response = await controller.runChecks({
        params: { siteId },
        data: {},
      });

      expect(response.status).to.equal(400);
    });

    it('returns 400 when checks array is empty', async () => {
      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [] },
      });

      expect(response.status).to.equal(400);
    });

    it('returns 400 for unknown check type', async () => {
      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'unknown-check' }] },
      });

      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.include('Unknown check type(s): unknown-check');
    });

    it('returns 404 when site not found', async () => {
      mockDataAccess.Site.findById = sandbox.stub().resolves(null);

      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'content-api-access' }] },
      });

      expect(response.status).to.equal(404);
    });

    it('returns 403 when user has no access', async () => {
      mockAccessControlUtil.hasAccess = sandbox.stub().resolves(false);

      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'content-api-access' }] },
      });

      expect(response.status).to.equal(403);
    });

    it('runs content-api-access check and returns result', async () => {
      contentApiHandlerStub.resolves({
        type: 'content-api-access',
        status: 'PASSED',
        message: 'Content API is accessible',
      });

      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'content-api-access' }] },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.siteId).to.equal(siteId);
      expect(body.checks).to.have.length(1);
      expect(body.checks[0].status).to.equal('PASSED');
      expect(contentApiHandlerStub).to.have.been.calledOnce;
    });

    it('runs multiple checks in parallel', async () => {
      contentApiHandlerStub.resolves({
        type: 'content-api-access',
        status: 'PASSED',
        message: 'Content API is accessible',
      });

      const response = await controller.runChecks({
        params: { siteId },
        data: {
          checks: [
            { type: 'content-api-access' },
            { type: 'content-api-access' },
          ],
        },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.checks).to.have.length(2);
      expect(contentApiHandlerStub).to.have.been.calledTwice;
    });

    it('returns ERROR when handler throws', async () => {
      contentApiHandlerStub.rejects(new Error('Unexpected failure'));

      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'content-api-access' }] },
        pathInfo: { headers: { authorization: 'Bearer test-token' } },
      });

      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.checks[0].status).to.equal('ERROR');
      expect(body.checks[0].message).to.equal('Check failed unexpectedly');
    });

    it('returns 500 when site lookup throws', async () => {
      mockDataAccess.Site.findById = sandbox.stub().rejects(new Error('DB connection lost'));

      const response = await controller.runChecks({
        params: { siteId },
        data: { checks: [{ type: 'content-api-access' }] },
      });

      expect(response.status).to.equal(500);
    });
  });
});
