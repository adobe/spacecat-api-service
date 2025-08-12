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
      expect(result).to.have.property('message', 'Triggered 3 audits for https://sandbox.example.com');
      expect(result).to.have.property('siteId', SITE_IDS[0]);
      expect(result).to.have.property('baseURL', 'https://sandbox.example.com');
      expect(result).to.have.property('auditsTriggered');
      expect(result.auditsTriggered).to.deep.equal(['broken-internal-links', 'meta-tags', 'alt-text']);

      expect(mockSqs.sendMessage).to.have.been.calledThrice;
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

    it('returns 400 when auditType is invalid', async () => {
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
      expect(result).to.have.property('message', 'Invalid auditType. Supported types: broken-internal-links, meta-tags, alt-text');
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
      expect(result).to.have.property('message', "Audits of type 'meta-tags' are disabled for this site");
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
      configMock.isHandlerEnabledForSite.withArgs('broken-internal-links', sites[0]).returns(true);
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
      expect(result).to.have.property('message', 'Triggered 1 audits for https://sandbox.example.com');
      expect(result.auditsTriggered).to.deep.equal(['broken-internal-links']);
      expect(result.results).to.have.length(2);
      expect(result.results[0]).to.deep.include({ auditType: 'broken-internal-links', status: 'triggered' });
      expect(result.results[1]).to.deep.include({ auditType: 'meta-tags', status: 'failed' });
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

      try {
        await sandboxAuditController.triggerAudit(request);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('SQS connection failed');
      }
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

      const supportedAudits = ['broken-internal-links', 'meta-tags', 'alt-text'];

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

      expect(mockSqs.sendMessage).to.have.been.calledThrice;
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

      expect(loggerStub.error).to.have.been.calledWith(
        sinon.match(/Error triggering audit/),
        sinon.match.instanceOf(Error),
      );
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
});
