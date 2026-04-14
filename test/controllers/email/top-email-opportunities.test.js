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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = 'test-site-id';

function createMockOpportunity(overrides = {}) {
  const defaults = {
    id: `opp-${Math.random().toString(36).substr(2, 9)}`,
    type: 'cwv',
    title: 'Test Opportunity',
    description: 'A test opportunity',
    tags: ['email traffic'],
    data: { projectedTrafficValue: 100 },
    guidance: null,
    status: 'NEW',
  };
  const merged = { ...defaults, ...overrides };
  return {
    getId: () => merged.id,
    getType: () => merged.type,
    getTitle: () => merged.title,
    getDescription: () => merged.description,
    getTags: () => merged.tags,
    getData: () => merged.data,
    getGuidance: () => merged.guidance,
    getStatus: () => merged.status,
  };
}

describe('TopEmailOpportunitiesController', () => {
  let sandbox;
  let mockLog;
  let mockSite;
  let mockAccessControlUtil;
  let mockContext;
  let mockEnv;
  let TopEmailOpportunitiesController;
  let mockFetchEmailTrafficData;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: sandbox.stub().resolves('https://www.test.com'),
    };
    mockAccessControlUtil = { hasAccess: sandbox.stub().resolves(true) };
    mockFetchEmailTrafficData = sandbox.stub().resolves([]);

    const AccessControlUtilMock = {
      default: { fromContext: () => mockAccessControlUtil },
    };

    TopEmailOpportunitiesController = (await esmock(
      '../../../src/controllers/email/top-email-opportunities.js',
      {
        '../../../src/support/access-control-util.js': AccessControlUtilMock,
        '../../../src/controllers/email/email-traffic-data.js': {
          fetchEmailTrafficData: mockFetchEmailTrafficData,
        },
      },
    )).default;

    mockEnv = {
      EMAIL_DATA_THRESHOLD: 500,
    };
    mockContext = {
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(mockSite) },
        Opportunity: {
          allBySiteIdAndStatus: sandbox.stub().resolves([]),
        },
        Suggestion: {
          allByOpportunityIdAndStatus: sandbox.stub().resolves([]),
          allByOpportunityId: sandbox.stub().resolves([]),
        },
      },
      log: mockLog,
      params: { siteId: SITE_ID },
      s3: { s3Client: sandbox.stub() },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns 404 if site not found', async () => {
    mockContext.dataAccess.Site.findById.resolves(null);
    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    const res = await controller.getTopEmailOpportunities(
      { params: { siteId: SITE_ID }, data: {} },
    );
    expect(res.status).to.equal(404);
  });

  it('returns 403 if access denied', async () => {
    mockAccessControlUtil.hasAccess.resolves(false);
    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    const res = await controller.getTopEmailOpportunities(
      { params: { siteId: SITE_ID }, data: {} },
    );
    expect(res.status).to.equal(403);
  });

  it('returns 200 with empty array when no opportunities', async () => {
    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    const res = await controller.getTopEmailOpportunities(
      { params: { siteId: SITE_ID }, data: {} },
    );
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal([]);
  });

  it('returns opportunities with email traffic tag', async () => {
    const emailOpp = createMockOpportunity({
      id: 'opp-email-1',
      type: 'email-traffic-issue',
      tags: ['email traffic'],
      description: 'Email traffic issue',
      data: { projectedTrafficValue: 500 },
    });

    mockContext.dataAccess.Opportunity.allBySiteIdAndStatus
      .withArgs(SITE_ID, 'NEW').resolves([emailOpp])
      .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    const res = await controller.getTopEmailOpportunities(
      { params: { siteId: SITE_ID }, data: {} },
    );
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.have.length(1);
    expect(body[0].opportunityId).to.equal('opp-email-1');
  });

  it('fetches email traffic data when CWV opportunities exist', async () => {
    const cwvOpp = createMockOpportunity({
      id: 'opp-cwv-1',
      type: 'cwv',
      tags: [],
      description: 'CWV issue',
      data: { projectedTrafficValue: 100 },
    });

    mockContext.dataAccess.Opportunity.allBySiteIdAndStatus
      .withArgs(SITE_ID, 'NEW').resolves([cwvOpp])
      .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

    mockFetchEmailTrafficData.resolves([]);

    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    await controller.getTopEmailOpportunities({ params: { siteId: SITE_ID }, data: {} });
    expect(mockFetchEmailTrafficData).to.have.been.calledOnce;
  });

  it('skips Athena query when no CWV or forms opportunities', async () => {
    const emailOpp = createMockOpportunity({
      id: 'opp-email-1',
      type: 'email-traffic-issue',
      tags: ['email traffic'],
      description: 'Email traffic issue',
      data: { projectedTrafficValue: 500 },
    });

    mockContext.dataAccess.Opportunity.allBySiteIdAndStatus
      .withArgs(SITE_ID, 'NEW').resolves([emailOpp])
      .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

    const controller = TopEmailOpportunitiesController(mockContext, mockEnv);
    await controller.getTopEmailOpportunities({ params: { siteId: SITE_ID }, data: {} });
    expect(mockFetchEmailTrafficData).to.not.have.been.called;
  });
});
