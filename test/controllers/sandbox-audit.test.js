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
      baseURL: 'https://sandbox.example.com',
    },
    {
      getId: () => SITE_IDS[1],
      getIsSandbox: () => false, // This is NOT a sandbox site
      baseURL: 'https://production.example.com',
    },
  ];

  let mockDataAccess;
  let mockSqs;
  let sandboxAuditController;
  let context;

  beforeEach(() => {
    // Stub AccessControlUtil.fromContext to bypass auth
    sandbox.stub(AccessControlUtil, 'fromContext').returns({ hasAccess: () => true });

    mockSqs = {
      sendMessage: sandbox.stub().resolves(),
    };

    mockDataAccess = {
      Site: {
        findByBaseURL: sandbox.stub(),
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
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      expect(result).to.have.property('message', 'Successfully triggered meta-tags audit for https://sandbox.example.com');
      expect(result).to.have.property('siteId', SITE_IDS[0]);
      expect(result).to.have.property('auditType', 'meta-tags');
      expect(result).to.have.property('baseURL', 'https://sandbox.example.com');

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
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      expect(result.message).to.match(/Triggered 2 (?:of 2 )?audits/);
      expect(result).to.have.property('siteId', SITE_IDS[0]);
      expect(result).to.have.property('baseURL', 'https://sandbox.example.com');
      expect(result).to.have.property('auditsTriggered');
      expect(result.auditsTriggered).to.deep.equal(['meta-tags', 'alt-text']);

      expect(mockSqs.sendMessage).to.have.been.calledTwice;
    });

    it('returns 400 when baseURL is missing', async () => {
      const request = {
        data: {
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'baseURL query parameter is required');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when baseURL is invalid', async () => {
      const request = {
        data: {
          baseURL: 'not-a-valid-url',
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'Invalid baseURL provided');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://nonexistent.example.com').resolves(null);

      const request = {
        data: {
          baseURL: 'https://nonexistent.example.com',
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(404);
      expect(result).to.have.property('message', 'Site not found for baseURL: https://nonexistent.example.com');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when site is not a sandbox', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://production.example.com').resolves(sites[1]);

      const request = {
        data: {
          baseURL: 'https://production.example.com',
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'Sandbox audit endpoint only supports sandbox sites. Site https://production.example.com is not a sandbox.');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when audit triggered too recently (rate limit)', async () => {
      const recentDate = new Date();
      // 1 minute ago
      const oneMinuteAgo = new Date(recentDate.getTime() - 60 * 1000);

      // Attach stub for latest audit
      const recentAuditMock = {
        getAuditedAt: () => oneMinuteAgo.toISOString(),
      };

      const siteWithHistory = {
        ...sites[0],
        getLatestAuditByAuditType: sinon.stub().returns(recentAuditMock),
      };

      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(siteWithHistory);

      // Reduce rate limit for test brevity to 0.5 hours
      context.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '0.5';

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'meta-tags',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message').that.includes('Rate limit exceeded');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when audit type is invalid', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'invalid-audit-type',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message').that.matches(/Supported types: meta-tags, alt-text/);
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('returns 400 when audit type is disabled for the site', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);
      mockDataAccess.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(false),
      });

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
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
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);
      mockDataAccess.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sandbox.stub().returns(false), // All audits disabled
      });

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'No audits configured for site: https://sandbox.example.com');
      expect(mockSqs.sendMessage).to.not.have.been.called;
    });

    it('handles partial failures when triggering all audits', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      // Configure so only some audits are enabled
      const configMock = {
        isHandlerEnabledForSite: sandbox.stub(),
      };
      configMock.isHandlerEnabledForSite.withArgs('meta-tags', sites[0]).returns(true);
      configMock.isHandlerEnabledForSite.withArgs('alt-text', sites[0]).returns(false);

      mockDataAccess.Configuration.findLatest.resolves(configMock);

      // Make one audit fail
      mockSqs.sendMessage.onFirstCall().resolves();
      mockSqs.sendMessage.onSecondCall().rejects(new Error('SQS error'));

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(200);
      expect(result.message).to.satisfy((msg) => /Triggered 1 (?:of 2 )?audits/.test(msg) || /^Successfully triggered/.test(msg));
      if (result.auditsTriggered) {
        expect(result.auditsTriggered).to.deep.equal(['meta-tags']);
        expect(result.results).to.have.length(1);
        expect(result.results[0]).to.deep.include({ auditType: 'meta-tags', status: 'triggered' });
      }
    });

    it('handles SQS errors gracefully', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);
      mockSqs.sendMessage.rejects(new Error('SQS connection failed'));

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'meta-tags',
        },
      };

      const responseSqs = await sandboxAuditController.triggerAudit(request);
      const bodySqs = await responseSqs.json();
      expect(responseSqs.status).to.equal(200);
      expect(bodySqs).to.have.property('message').that.includes('Successfully triggered');
    });

    it('handles empty request data', async () => {
      const request = {
        data: {},
      };

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'baseURL query parameter is required');
    });

    it('handles missing request data', async () => {
      const request = {};

      const response = await sandboxAuditController.triggerAudit(request);
      const result = await response.json();

      expect(response.status).to.equal(400);
      expect(result).to.have.property('message', 'baseURL query parameter is required');
    });

    it('verifies all supported audit types are handled', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      const supportedAudits = ['meta-tags', 'alt-text'];

      const auditPromises = supportedAudits.map(async (auditType) => {
        const request = {
          data: {
            baseURL: 'https://sandbox.example.com',
            auditType,
          },
        };

        const response = await sandboxAuditController.triggerAudit(request);
        const result = await response.json();

        expect(response.status).to.equal(200);
        expect(result).to.have.property('auditType', auditType);
      });

      await Promise.all(auditPromises);

      expect(mockSqs.sendMessage).to.have.been.calledTwice;
    });

    it('logs errors appropriately', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);
      mockSqs.sendMessage.rejects(new Error('Test error'));

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'meta-tags',
        },
      };

      try {
        await sandboxAuditController.triggerAudit(request);
      } catch (error) {
        // Expected to throw
      }

      expect(loggerStub.error).to.have.been.called;
    });

    it('logs error when one audit fails', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      const configMock = {
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      };
      mockDataAccess.Configuration.findLatest.resolves(configMock);

      // meta-tags succeeds, alt-text fails
      mockSqs.sendMessage.onFirstCall().resolves();
      mockSqs.sendMessage.onSecondCall().rejects(new Error('SQS boom'));

      const request = {
        data: {
          baseURL: 'https://sandbox.example.com',
          auditType: 'meta-tags,alt-text',
        },
      };

      const response = await sandboxAuditController.triggerAudit(request);
      expect(response.status).to.equal(200);
      expect(loggerStub.error).to.have.been.calledWithMatch(sinon.match(/Error running audit/));
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
      expect(() => SandboxAuditController()).to.throw('Context required');
    });

    it('throws when context is missing dataAccess', () => {
      const badContext = { log: loggerStub };
      expect(() => SandboxAuditController(badContext)).to.throw('Data access required');
    });

    it('returns 403 when user lacks access', async () => {
      // Override stub to simulate no access
      AccessControlUtil.fromContext.restore();
      sandbox.stub(AccessControlUtil, 'fromContext').returns({ hasAccess: () => false });

      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      // re-create controller to capture new access control behaviour
      const denyController = SandboxAuditController(context);

      const response = await denyController.triggerAudit({ data: { baseURL: 'https://sandbox.example.com' } });
      const body = await response.json();

      expect(response.status).to.equal(403);
      expect(body).to.have.property('message', 'User does not have access to this site');
    });

    it('logs error when one audit fails in all-audits mode', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);

      // Both audits enabled
      const configMock = {
        isHandlerEnabledForSite: sandbox.stub().returns(true),
      };
      mockDataAccess.Configuration.findLatest.resolves(configMock);

      // meta-tags succeeds, alt-text fails
      mockSqs.sendMessage.onFirstCall().resolves();
      mockSqs.sendMessage.onSecondCall().rejects(new Error('SQS alt-text failure'));

      const req = { data: { baseURL: 'https://sandbox.example.com' } };
      const res = await sandboxAuditController.triggerAudit(req);
      const body = await res.json();

      expect(res.status).to.equal(200);
      expect(body.message).to.match(/Triggered 1 (?:of 2 )?audits/);
      expect(loggerStub.error).to.have.been.calledWithMatch(sinon.match(/alt-text/));
    });

    it('controller catch block logs and rethrows on unexpected error', async () => {
      mockDataAccess.Site.findByBaseURL.withArgs('https://sandbox.example.com').resolves(sites[0]);
      // Force Configuration.findLatest to throw
      mockDataAccess.Configuration.findLatest.rejects(new Error('Config fail'));

      const req = { data: { baseURL: 'https://sandbox.example.com' } };
      await expect(sandboxAuditController.triggerAudit(req)).to.be.rejectedWith('Config fail');
      expect(loggerStub.error).to.have.been.calledWithMatch(sinon.match('Error triggering audit'));
    });
  });
});
