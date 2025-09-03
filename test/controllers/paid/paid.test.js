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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import PaidController from '../../../src/controllers/paid.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('PaidController', () => {
  const sandbox = sinon.createSandbox();
  const SITE_ID = '90e30aa6-10cf-40ce-a0dc-c345bdc8a404';

  let mockDataAccess;
  let Site;
  let LatestAudit;
  let authContextAdmin;

  beforeEach(() => {
    Site = {
      findById: sandbox.stub(),
    };
    LatestAudit = {
      allBySiteIdAndAuditType: sandbox.stub(),
    };
    mockDataAccess = { Site, LatestAudit };
    authContextAdmin = {
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => PaidController()).to.throw('Context and dataAccess required');
  });

  describe('getTopPaidPages', () => {
    it('returns 400 if siteId is invalid', async () => {
      const context = { params: { siteId: 'bad-id' } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(400);
    });

    it('returns 404 if site not found', async () => {
      Site.findById.resolves(null);
      const context = { params: { siteId: SITE_ID } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(404);
    });

    it('returns 404 if no audits found', async () => {
      Site.findById.resolves({ id: SITE_ID });
      LatestAudit.allBySiteIdAndAuditType.resolves([]);
      const context = { params: { siteId: SITE_ID } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(404);
    });

    it('returns 404 if no urlTrafficSource in audit', async () => {
      Site.findById.resolves({ id: SITE_ID });
      LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditResult: () => [{ key: 'other', value: [] }] },
      ]);
      const context = { params: { siteId: SITE_ID } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(404);
    });

    it('returns 404 if urlTrafficSource.value is empty', async () => {
      Site.findById.resolves({ id: SITE_ID });
      LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditResult: () => [{ key: 'urlTrafficSource', value: [] }] },
      ]);
      const context = { params: { siteId: SITE_ID } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(404);
    });

    it('returns 200 and top pages if urlTrafficSource is present', async () => {
      Site.findById.resolves({ id: SITE_ID });
      const urlTrafficSource = [
        {
          url: 'https://example.com',
          ctr: 0.1,
          avgClicksPerSession: 2.0,
          pageViews: 100,
          clickedSessions: 10,
          bounceRate: 0.5,
          totalNumClicks: 20,
          source: 'adwords',
        },
      ];
      LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditResult: () => [{ key: 'urlTrafficSource', value: urlTrafficSource }] },
      ]);
      const context = { params: { siteId: SITE_ID } };
      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(urlTrafficSource);
    });

    it('returns 403 if user does not have access to the site', async () => {
      const accessControlUtilStub = { hasAccess: sinon.stub().resolves(false) };
      const fromContextStub = sandbox.stub(AccessControlUtil, 'fromContext').returns(accessControlUtilStub);

      Site.findById.resolves({ id: SITE_ID });
      LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditResult: () => [{ key: 'urlTrafficSource', value: [{}] }] },
      ]);

      const paidController = PaidController({
        dataAccess: mockDataAccess,
        pathInfo: { headers: { 'x-product': 'llmo' } },
        ...authContextAdmin,
      });

      const context = { params: { siteId: SITE_ID } };
      const res = await paidController.getTopPaidPages(context);
      expect(res.status).to.equal(403);
      fromContextStub.restore();
    });
  });
});
