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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import SandboxAuditController from '../../src/controllers/sandbox-audit.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Sandbox Audit Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const SITE_IDS = ['0b4dcf79-fe5f-410b-b11f-641f0bf56da3', 'c4420c67-b4e8-443d-b7ab-0099cfd5da20'];

  // Create test sites - one sandbox, one non-sandbox
  const sites = [
    {
      getId: () => SITE_IDS[0],
      getIsSandbox: () => true, // This is a sandbox site
      getBaseURL: () => 'https://sandbox.example.com',
    },
    {
      getId: () => SITE_IDS[1],
      getIsSandbox: () => false, // This is NOT a sandbox site
      getBaseURL: () => 'https://production.example.com',
    },
  ];

  let mockDataAccess;
  let mockSqs;
  let sandboxAuditController;
  let context;

  beforeEach(() => {
    // Reset all stubs
    sandbox.reset();
    // Stub AccessControlUtil.fromContext to bypass auth
    sandbox.stub(AccessControlUtil, 'fromContext').returns({ hasAccess: () => true });

    mockSqs = {
      sendMessage: sandbox.stub().resolves({ MessageId: 'test-message-id' }),
    };

    mockDataAccess = {
      Site: {
        findById: sandbox.stub(),
      },
      Configuration: {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().returns(true),
        }),
      },
    };

    context = {
      runtime: { name: 'aws-lambda', region: 'us-east-1' },
      func: { package: 'spacecat-services', version: 'ci', name: 'test' },
      log: loggerStub,
      env: {
        AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789/audit-jobs',
        SANDBOX_AUDIT_RATE_LIMIT_HOURS: '1', // Default rate limit
      },
      dataAccess: mockDataAccess,
      sqs: mockSqs,
      attributes: { authInfo: { profile: {} } },
    };

    sandboxAuditController = SandboxAuditController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('triggerAudit', () => {
    it('successfully triggers a single audit for a sandbox site', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      expect(result).to.have.property('message', 'Triggered 1 of 1 audits for https://sandbox.example.com');
      expect(result).to.have.property('siteId', SITE_IDS[0]);
      expect(result).to.have.property('baseURL', 'https://sandbox.example.com');
      const triggeredAudits = result.results.filter((r) => r.status === 'triggered').map((r) => r.auditType);
      expect(triggeredAudits).to.deep.equal(['meta-tags']);
      expect(result).to.have.property('results').that.is.an('array').with.lengthOf(1);

      expect(mockSqs.sendMessage).to.have.been.calledOnceWith(
        'https://sqs.us-east-1.amazonaws.com/123456789/audit-jobs',
        {
          type: 'meta-tags',
          siteId: SITE_IDS[0],
          auditContext: {},
        },
      );
    });

    it('successfully triggers all audits for a sandbox site when no auditType specified', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {},
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      expect(result.message).to.match(/Triggered 2 (?:of 2 )?audits/);
      expect(result).to.have.property('siteId', SITE_IDS[0]);
      expect(result).to.have.property('baseURL', 'https://sandbox.example.com');
      const triggeredAudits = result.results.filter((r) => r.status === 'triggered').map((r) => r.auditType);
      expect(triggeredAudits).to.have.members(['meta-tags', 'alt-text']);

      expect(mockSqs.sendMessage).to.have.been.calledTwice;
    });

    it('returns 400 when siteId is missing', async () => {
      const request = {
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'siteId path parameter is required');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when siteId is invalid', async () => {
      const request = {
        params: {
          siteId: 'not-a-valid-uuid',
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'Invalid siteId provided');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 404 when site is not found', async () => {
      // Use a valid UUID format that doesn't exist in our mock data
      const nonexistentSiteId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      mockDataAccess.Site.findById.withArgs(nonexistentSiteId).resolves(null);

      const request = {
        params: {
          siteId: nonexistentSiteId,
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(404);
      expect(result).to.have.property('message', `Site not found for siteId: ${nonexistentSiteId}`);
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when site is not a sandbox', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[1]).resolves(sites[1]);

      const request = {
        params: {
          siteId: SITE_IDS[1],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', `Sandbox audit endpoint only supports sandbox sites. Site ${SITE_IDS[1]} is not a sandbox.`);
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when audit triggered too recently (rate limit)', async () => {
      const recentDate = new Date();
      // 30 minutes ago (should be blocked with 1 hour rate limit)
      const thirtyMinsAgo = new Date(recentDate.getTime() - 30 * 60 * 1000);

      // Attach stub for latest audit
      const recentAuditMock = {
        getAuditedAt: () => thirtyMinsAgo.toISOString(),
      };

      const siteWithHistory = {
        ...sites[0],
        getLatestAuditByAuditType: sinon.stub().returns(recentAuditMock),
      };

      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(siteWithHistory);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(429);
      expect(result).to.have.property('message').that.includes('Rate limit exceeded');
      expect(result.results[0]).to.have.property('nextAllowedAt');
      expect(result.results[0]).to.have.property('minutesRemaining');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 with minutes format when next audit under an hour', async () => {
      const now = new Date();
      const twentyNineMinsAgo = new Date(now.getTime() - 29 * 60 * 1000);

      const recentAuditMock = {
        getAuditedAt: () => twentyNineMinsAgo.toISOString(),
      };

      const siteWithHistory = {
        ...sites[0],
        getLatestAuditByAuditType: sinon.stub().returns(recentAuditMock),
      };

      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(siteWithHistory);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(429);
      expect(result.results[0].minutesRemaining).to.be.a('number');
    });

    it('returns 400 with hours+minutes format when next audit over an hour', async () => {
      const now = new Date();
      const eightyNineMinsAgo = new Date(now.getTime() - 89 * 60 * 1000);

      const recentAuditMock = {
        getAuditedAt: () => eightyNineMinsAgo.toISOString(),
      };

      const siteWithHistory = {
        ...sites[0],
        getLatestAuditByAuditType: sinon.stub().returns(recentAuditMock),
      };

      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(siteWithHistory);
      context.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '3';

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(429);
      expect(result.results[0].minutesRemaining).to.be.a('number').and.be.above(60);
    });

    it('returns 400 when audit type is invalid', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'invalid-audit-type',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result.message).to.include('Invalid audit types: invalid-audit-type. Supported types: meta-tags, alt-text');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when audit type is disabled for the site', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);
      mockDataAccess.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(false),
      });

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message').that.includes('disabled for this site');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when no audits are configured for the site (all audits case)', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);
      mockDataAccess.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(false), // All audits disabled
      });

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {},
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result.message).to.match(/disabled for this site|No audits configured/);
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('handles partial failures when triggering all audits', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      // Configure so only some audits are enabled
      const configMock = {
        isHandlerEnabledForSite: sandbox.stub(),
      };
      configMock.isHandlerEnabledForSite.withArgs('meta-tags', sites[0]).returns(true);
      configMock.isHandlerEnabledForSite.withArgs('alt-text', sites[0]).returns(false);

      mockDataAccess.Configuration.findLatest.resolves(configMock);

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {},
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      const triggeredAudits = result.results.filter((r) => r.status === 'triggered').map((r) => r.auditType);
      expect(triggeredAudits).to.deep.equal(['meta-tags']);
      // Should have one result (only enabled audit)
      expect(result.results).to.have.length(1);
      const triggered = result.results.find((r) => r.status === 'triggered');
      expect(triggered).to.deep.include({ auditType: 'meta-tags', status: 'triggered' });
    });

    it('handles SQS errors gracefully', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);
      mockSqs.sendMessage.rejects(new Error('SQS connection failed'));

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.have.property('message').that.includes('Triggered');
    });

    it('handles empty request data', async () => {
      const request = {
        data: {},
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'siteId path parameter is required');
    });

    it('handles missing request data', async () => {
      const request = {};

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'siteId path parameter is required');
    });

    it('verifies all supported audit types are handled', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const supportedAudits = ['meta-tags', 'alt-text'];

      const responses = await Promise.all(supportedAudits.map(async (auditType) => {
        mockSqs.sendMessage.resetHistory();
        const request = {
          params: {
            siteId: SITE_IDS[0],
          },
          data: {
            auditType,
          },
        };
        return sandboxAuditController.triggerAudit(request);
      }));

      const results = await Promise.all(responses.map((response) => response.json()));
      results.forEach((result, i) => {
        const auditType = supportedAudits[i];
        expect(responses[i].status).to.equal(200);
        const triggeredAudits = result.results.filter((r) => r.status === 'triggered').map((r) => r.auditType);
        expect(triggeredAudits).to.include(auditType);
      });
      expect(mockSqs.sendMessage.callCount).to.equal(supportedAudits.length);
    });

    it('logs errors appropriately', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);
      mockSqs.sendMessage.rejects(new Error('Test error'));

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags',
        },
      };

      await sandboxAuditController.triggerAudit(request);
      // Should log error but not throw
      expect(loggerStub.error).to.have.been.calledWith(sinon.match('Error running audit'));
    });

    it('logs error when one audit fails', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const configMock = {
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      };
      mockDataAccess.Configuration.findLatest.resolves(configMock);

      // meta-tags succeeds, alt-text fails
      mockSqs.sendMessage.onFirstCall().resolves({ MessageId: 'success' });
      mockSqs.sendMessage.onSecondCall().rejects(new Error('SQS boom'));

      const request = {
        params: {
          siteId: SITE_IDS[0],
        },
        data: {
          auditType: 'meta-tags,alt-text',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(200);
      expect(loggerStub.error).to.have.been.calledWith(sinon.match(/Error running audit.*alt-text/));
    });
  });

  describe('controller interface', () => {
    it('exports triggerAudit function', () => {
      expect(sandboxAuditController).to.have.property('triggerAudit');
      expect(sandboxAuditController.triggerAudit).to.be.a('function');
    });

    it('does not export any unexpected functions', () => {
      const expectedFunctions = ['triggerAudit'];
      Object.keys(sandboxAuditController).forEach((funcName) => {
        expect(expectedFunctions).to.include(funcName);
      });
    });
  });

  describe('additional coverage', () => {
    it('throws when context is missing', () => {
      expect(() => SandboxAuditController()).to.throw('Valid data access configuration required');
    });

    it('throws when context is missing dataAccess', () => {
      const badContext = { log: loggerStub };
      expect(() => SandboxAuditController(badContext)).to.throw('Valid data access configuration required');
    });

    it('returns 403 when user lacks access', async () => {
      // Override stub to simulate no access
      AccessControlUtil.fromContext.restore();
      sandbox.stub(AccessControlUtil, 'fromContext').returns({ hasAccess: () => false });

      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      // re-create controller to capture new access control behaviour
      const denyController = SandboxAuditController(context);

      const response = await denyController.triggerAudit({
        params: { siteId: SITE_IDS[0] },
        data: { auditType: 'meta-tags' },
      });
      const body = await response.json();

      expect(response.status).to.equal(403);
      expect(body).to.have.property('message', 'User does not have access to this site');
    });

    it('logs error when one audit fails in all-audits mode', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      // Both audits enabled
      const configMock = {
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      };
      mockDataAccess.Configuration.findLatest.resolves(configMock);

      // meta-tags succeeds, alt-text fails
      mockSqs.sendMessage.onFirstCall().resolves({ MessageId: 'success' });
      mockSqs.sendMessage.onSecondCall().rejects(new Error('SQS alt-text failure'));

      const req = {
        params: { siteId: SITE_IDS[0] },
        data: {},
      };
      const res = await sandboxAuditController.triggerAudit(req);
      const body = await res.json();

      expect(res.status).to.equal(200);
      expect(body.message).to.match(/Triggered 1 (?:of 2 )?audits/);
      expect(loggerStub.error).to.have.been.calledWith(sinon.match(/alt-text/));
    });

    it('controller catch block logs and rethrows on unexpected error', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);
      // Force Configuration.findLatest to throw
      mockDataAccess.Configuration.findLatest.rejects(new Error('Config fail'));

      const req = {
        params: { siteId: SITE_IDS[0] },
        data: { auditType: 'meta-tags' },
      };
      const response = await sandboxAuditController.triggerAudit(req);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.message).to.equal('Failed to trigger sandbox audit');
      expect(response.headers.get('x-error')).to.equal('Config fail');
      expect(loggerStub.error).to.have.been.calledWith(sinon.match('Error triggering audit'));
    });

    it('handles comma-separated audit types in request', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const request = {
        params: { siteId: SITE_IDS[0] },
        data: { auditType: 'meta-tags,alt-text' },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.results).to.have.length(2);
      expect(body.results.map((r) => r.auditType)).to.include.members(['meta-tags', 'alt-text']);
    });

    it('handles array of audit types in request', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).resolves(sites[0]);

      const request = {
        params: { siteId: SITE_IDS[0] },
        data: { auditType: ['meta-tags', 'alt-text'] },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.results).to.have.length(2);
    });

    it('covers edge case when site findById throws error', async () => {
      mockDataAccess.Site.findById.withArgs(SITE_IDS[0]).rejects(new Error('Database error'));

      const request = {
        params: { siteId: SITE_IDS[0] },
        data: { auditType: 'meta-tags' },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(500);
      expect(loggerStub.error).to.have.been.called;
    });
  });
});
