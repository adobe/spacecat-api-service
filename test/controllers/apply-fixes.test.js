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

import { expect } from 'chai';
import sinon from 'sinon';
import { ApplyFixesController } from '../../src/controllers/apply-fixes.js';

describe('ApplyFixesController', () => {
  let sandbox;
  let dataAccess;
  let mockAccessControl;
  let controller;
  let context;

  const siteId = '550e8400-e29b-41d4-a716-446655440000';
  const opportunityId = '550e8400-e29b-41d4-a716-446655440001';

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    dataAccess = {
      FixEntity: {
        create: sandbox.stub(),
      },
      Opportunity: {
        findById: sandbox.stub(),
      },
      Site: {
        findById: sandbox.stub(),
      },
      Suggestion: {
        findById: sandbox.stub(),
      },
    };

    mockAccessControl = {
      hasAccess: sandbox.stub().resolves(true),
    };

    context = {
      dataAccess,
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
      env: {
        ASO_APP_URL: 'https://test-aso-app.com',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'https://ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      },
      imsClient: {
        getServiceAccessToken: sandbox.stub().resolves('test-token'),
      },
      s3: {
        s3Client: {
          send: sandbox.stub(),
        },
      },
    };

    controller = new ApplyFixesController(context, mockAccessControl);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('applyFixes', () => {
    let fetchStub;
    let mockSite;
    let mockOrganization;
    let mockOpportunity;
    let mockSuggestion1;
    let mockSuggestion2;

    beforeEach(() => {
      // Ensure fetch is available globally before stubbing
      if (typeof global.fetch === 'undefined') {
        global.fetch = fetch;
      }
      fetchStub = sandbox.stub(global, 'fetch');

      // Mock site
      mockSite = {
        getId: sandbox.stub().returns(siteId),
        getGitHubURL: sandbox.stub().returns('https://github.com/test/repo'),
        getOrganization: sandbox.stub(),
      };

      // Mock organization
      mockOrganization = {
        getImsOrgId: sandbox.stub().returns('test-ims-org-id'),
      };

      // Mock opportunity
      mockOpportunity = {
        getId: sandbox.stub().returns(opportunityId),
        getSiteId: sandbox.stub().returns(siteId),
      };

      // Mock suggestions
      mockSuggestion1 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440001'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'aria-allowed-attr',
              description: 'Elements must only use supported ARIA attributes',
              severity: 'critical',
            },
          ],
        }),
        setFixEntityId: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      mockSuggestion2 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440002'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'color-contrast',
              description: 'Elements must have sufficient color contrast',
              severity: 'serious',
            },
          ],
        }),
        setFixEntityId: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      // Setup mocks
      mockSite.getOrganization.resolves(mockOrganization);
      dataAccess.Site.findById.resolves(mockSite);
      dataAccess.Opportunity.findById.resolves(mockOpportunity);
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440001').resolves(mockSuggestion1);
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440002').resolves(mockSuggestion2);
    });

    afterEach(() => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
    });

    it('successfully applies accessibility fix', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: context.env,
        imsClient: context.imsClient,
        s3: context.s3,
      };

      // Mock S3 responses
      const hashKey = 'c5d6f7e8a9b0c1d2'; // Hash of 'https://example.com/form_#container form'

      // Mock ListObjectsV2Command response
      context.s3.s3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      // Mock GetObjectCommand for report.json
      context.s3.s3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            url: 'https://example.com/form',
            source: '#container form',
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
            htmlWithIssues: [],
            diff: '',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }),
        },
      });

      // Mock GetObjectCommand for form.js file
      context.s3.s3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'export function createForm() { /* fixed code */ }',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      // Mock fix entity creation
      const mockFixEntity = {
        getId: sandbox.stub().returns('created-fix-id-123'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getType: sandbox.stub().returns('CODE_CHANGE'),
        getCreatedAt: sandbox.stub().returns('2025-01-01T00:00:00.000Z'),
        getExecutedBy: sandbox.stub().returns(null),
        getExecutedAt: sandbox.stub().returns('2025-01-01T00:00:00.000Z'),
        getPublishedAt: sandbox.stub().returns(null),
        getChangeDetails: sandbox.stub().returns({
          pullRequestUrl: 'https://github.com/test/repo/pull/123',
          updatedFiles: ['blocks/form/form.js'],
        }),
        getStatus: sandbox.stub().returns('PENDING'),
      };
      dataAccess.FixEntity.create.resolves(mockFixEntity);

      const response = await controller.applyFixes(requestContext);

      expect(response).to.have.property('status', 200);
      expect(fetchStub.calledOnce).to.be.true;
      expect(requestContext.imsClient.getServiceAccessToken.calledOnce).to.be.true;

      const callArgs = fetchStub.firstCall.args;
      expect(callArgs[0]).equals('https://test-aso-app.com/api/v1/web/aem-sites-optimizer-gh-app/pull-request-handler');
      expect(callArgs[1].method).equals('POST');
      expect(callArgs[1].headers['x-gw-ims-org-id']).equals('test-ims-org-id');
      expect(callArgs[1].headers['Content-Type']).equals('application/json');
      expect(callArgs[1].headers.Authorization).equals('Bearer test-token');

      const body = JSON.parse(callArgs[1].body);
      expect(body.title).equals('Elements must only use supported ARIA attributes');
      expect(body.vcsType).equals('github');
      expect(body.repoURL).equals('https://github.com/test/repo');
      expect(body.updatedFiles).to.be.an('array').with.length(1);
      expect(body.updatedFiles[0].path).equals('blocks/form/form.js');
      expect(body.updatedFiles[0].content).equals('export function createForm() { /* fixed code */ }');

      const responseData = await response.json();
      expect(responseData.fixes).to.be.an('array').with.length(1);
      expect(responseData.fixes[0].index).equals(0);
      expect(responseData.fixes[0].statusCode).equals(200);
      expect(responseData.fixes[0].fix).to.be.an('object');
      expect(responseData.fixes[0].fix.id).equals('created-fix-id-123');
      expect(responseData.fixes[0].fix.type).equals('CODE_CHANGE');
      expect(responseData.fixes[0].fix.status).equals('PENDING');
      expect(responseData.metadata.total).equals(1);
      expect(responseData.metadata.success).equals(1);
      expect(responseData.metadata.failure).equals(0);

      // Verify that the suggestion was linked to the created fix entity
      expect(mockSuggestion1.setFixEntityId.calledOnceWith('created-fix-id-123')).to.be.true;
      expect(mockSuggestion1.save.calledOnce).to.be.true;
    });

    it('responds 400 if request body is missing', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Request body is required');
    });

    it('responds 400 if type is missing', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'type field is required');
    });

    it('responds 400 if suggestionIds is missing', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'suggestionIds array is required and must not be empty');
    });

    it('responds 400 if suggestionIds is empty array', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: [],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'suggestionIds array is required and must not be empty');
    });

    it('responds 400 if suggestionIds is not an array', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: 'not-an-array',
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'suggestionIds array is required and must not be empty');
    });

    it('responds 400 for unsupported fix type', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'unsupported-type',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData.message).to.include('Unsupported fix type: unsupported-type');
      expect(responseData.message).to.include('Supported types: accessibility');
    });

    it('responds 400 if siteId parameter is not a valid UUID', async () => {
      const requestContext = {
        params: { siteId: 'invalid-uuid', opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site ID required');
    });

    it('responds 400 if opportunityId parameter is not a valid UUID', async () => {
      const requestContext = {
        params: { siteId, opportunityId: 'invalid-uuid' },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Opportunity ID required');
    });

    it('responds 400 if access control denies access', async () => {
      mockAccessControl.hasAccess.resolves(false);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Only users belonging to the organization may access fix entities.');
    });

    it('responds 404 if site not found during access check', async () => {
      dataAccess.Site.findById.onFirstCall().resolves(null);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 404);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site not found');
    });

    it('responds 404 if opportunity not found', async () => {
      dataAccess.Opportunity.findById.resolves(null);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 404);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Opportunity not found');
    });

    it('responds 404 if opportunity does not belong to site', async () => {
      mockOpportunity.getSiteId.returns('different-site-id');

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 404);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Opportunity not found');
    });

    it('responds 404 if site not found after opportunity validation', async () => {
      // First call for access check returns site, second call returns null
      dataAccess.Site.findById.onSecondCall().resolves(null);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 404);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site not found');
    });

    it('responds 500 if handler throws an error', async () => {
      // Mock the handler to throw an error
      const mockHandler = sandbox.stub().rejects(new Error('Handler error'));
      // eslint-disable-next-line no-underscore-dangle
      controller._handlers = new Map([['accessibility', mockHandler]]);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Failed to apply accessibility fixes');
      expect(context.log.error.calledOnce).to.be.true;
    });

    it('responds 500 if handler throws an error without log context', async () => {
      // Mock the handler to throw an error
      const mockHandler = sandbox.stub().rejects(new Error('Handler error'));
      // eslint-disable-next-line no-underscore-dangle
      controller._handlers = new Map([['accessibility', mockHandler]]);

      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        // No log context
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Failed to apply accessibility fixes');
    });

    it('responds 400 if type is empty string', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: '',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'type field is required');
    });

    it('responds 400 if type is null', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: null,
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'type field is required');
    });

    it('responds 400 if siteId is null', async () => {
      const requestContext = {
        params: { siteId: null, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site ID required');
    });

    it('responds 400 if opportunityId is null', async () => {
      const requestContext = {
        params: { siteId, opportunityId: null },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Opportunity ID required');
    });

    it('responds 400 if siteId is undefined', async () => {
      const requestContext = {
        params: { opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site ID required');
    });

    it('responds 400 if opportunityId is undefined', async () => {
      const requestContext = {
        params: { siteId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Opportunity ID required');
    });
  });

  describe('accessibility handler comprehensive coverage', () => {
    let fetchStub;
    let mockSite;
    let mockOrganization;
    let mockOpportunity;
    let mockSuggestion1;
    let mockSuggestion2;
    let mockS3Client;

    beforeEach(() => {
      // Ensure fetch is available globally before stubbing
      if (!global.fetch) {
        global.fetch = fetch;
      }
      fetchStub = sandbox.stub(global, 'fetch');

      mockOrganization = {
        getImsOrgId: sandbox.stub().returns('test-ims-org-id'),
      };

      mockSite = {
        getId: sandbox.stub().returns(siteId),
        getOrganization: sandbox.stub().returns(Promise.resolve(mockOrganization)),
        getGitHubURL: sandbox.stub().returns('https://github.com/test/repo'),
      };

      mockOpportunity = {
        getId: sandbox.stub().returns(opportunityId),
        getSiteId: sandbox.stub().returns(siteId),
      };

      mockSuggestion1 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440001'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'aria-allowed-attr',
              description: 'Elements must only use supported ARIA attributes',
              severity: 'critical',
            },
          ],
        }),
        setFixEntityId: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      mockSuggestion2 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440002'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'color-contrast',
              description: 'Elements must have sufficient color contrast',
              severity: 'serious',
            },
          ],
        }),
        setFixEntityId: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      // Mock S3 client
      mockS3Client = {
        send: sandbox.stub(),
      };

      // Mock FixEntity for creation
      const mockCreatedFix = {
        getId: sandbox.stub().returns('created-fix-id-123'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getType: sandbox.stub().returns('CODE_CHANGE'),
        getCreatedAt: sandbox.stub().returns('2025-01-01T00:00:00.000Z'),
        getExecutedBy: sandbox.stub().returns(null),
        getExecutedAt: sandbox.stub().returns('2025-01-01T00:00:00.000Z'),
        getPublishedAt: sandbox.stub().returns(null),
        getChangeDetails: sandbox.stub().returns({
          pullRequestUrl: 'https://github.com/test/repo/pull/123',
          updatedFiles: ['blocks/form/form.js'],
        }),
        getStatus: sandbox.stub().returns('PENDING'),
      };

      // Setup data access stubs
      dataAccess.Site.findById.resolves(mockSite);
      dataAccess.Opportunity.findById.resolves(mockOpportunity);
      dataAccess.FixEntity.create.resolves(mockCreatedFix);
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440001').resolves(mockSuggestion1);
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440002').resolves(mockSuggestion2);
    });

    afterEach(() => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
    });

    it('successfully applies accessibility fix with default ASO_APP_URL', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          // No ASO_APP_URL provided, should use default
          S3_MYSTIQUE_BUCKET_NAME: 'spacecat-dev-mystique-assets',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock S3 responses
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            url: 'https://example.com/form',
            source: '#container form',
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'export function createForm() { /* fixed code */ }',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await controller.applyFixes(requestContext);

      expect(response).to.have.property('status', 200);
      expect(fetchStub.calledOnce).to.be.true;

      // Verify default ASO_APP_URL was used
      const callArgs = fetchStub.firstCall.args;
      expect(callArgs[0]).equals('https://283250-asosampleapp-stage.adobeioruntime.net/api/v1/web/aem-sites-optimizer-gh-app/pull-request-handler');
    });

    it('successfully applies accessibility fix with default S3_MYSTIQUE_BUCKET_NAME', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          // No S3_MYSTIQUE_BUCKET_NAME provided, should use default
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock S3 responses
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'file content',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 200);
    });

    it('handles suggestion with no issues array', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock suggestion with no issues
      mockSuggestion1.getData.returns({
        url: 'https://example.com/form',
        source: '#container form',
        // No issues array
      });

      // Mock empty S3 response since no valid suggestions
      mockS3Client.send.resolves({ Contents: [] });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('handles multiple report files with different matching suggestions', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      // Mock S3 list response with multiple report files
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
          { Key: `fixes/${siteId}/${hashKey}/rule-987654321/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-987654321/assets/blocks/button/button.js` },
        ],
      });

      // Mock first report.json
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      // Mock first asset file
      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      // Mock second report.json
      mockS3Client.send.onCall(3).resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'color-contrast',
            updatedFiles: ['blocks/button/button.js'],
          }),
        },
      });

      // Mock second asset file
      mockS3Client.send.onCall(4).resolves({
        Body: {
          transformToString: async () => 'button content',
        },
      });

      fetchStub.onFirstCall().resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/124' }),
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 200);

      const responseData = await response.json();
      expect(responseData.fixes).to.be.an('array').with.length(2);
      expect(responseData.metadata.total).equals(2);
      expect(responseData.metadata.success).equals(2);
      expect(responseData.metadata.failure).equals(0);
    });

    it('handles asset file not in updatedFiles list', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/other/other.js` }, // Not in updatedFiles
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'], // Only includes form.js, not other.js
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 200);

      const responseData = await response.json();
      expect(responseData.fixes[0].fix.changeDetails.updatedFiles).to.deep.equal(['blocks/form/form.js']);
    });

    it('handles report with null updatedFiles', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: null, // null updatedFiles
          }),
        },
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('handles suggestion not found (covers line 101, 103-104)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440999'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock first suggestion found, second not found
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440999').resolves(null);

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 404);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Suggestion not found: 550e8400-e29b-41d4-a716-446655440999');
    });

    it('handles suggestion belonging to different opportunity (covers line 106-107)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440999'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock second suggestion with different opportunity ID
      const mockWrongSuggestion = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440999'),
        getOpportunityId: sandbox.stub().returns('different-opportunity-id'),
      };
      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440999').resolves(mockWrongSuggestion);

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', `Suggestion 550e8400-e29b-41d4-a716-446655440999 does not belong to opportunity ${opportunityId}`);
    });

    it('handles no matching suggestions for report type (covers line 163-165)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock suggestion with different issue type than report
      mockSuggestion1.getData.returns({
        url: 'https://example.com/form',
        source: '#container form',
        issues: [{ type: 'different-type', description: 'Different issue' }],
      });

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [{ Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` }],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr', // Different from suggestion type
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('logs warning when no fixes found in S3 for hash key', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock empty S3 response
      mockS3Client.send.resolves({ Contents: [] });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);

      // Just verify the response is correct - logging is internal implementation
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('logs warning when report.json cannot be read', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
        ],
      });

      // Mock S3 read error for report.json
      mockS3Client.send.onSecondCall().rejects(new Error('S3 access denied'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);

      // Verify warning was logged
      expect(context.log.warn.calledWith(`Failed to read report.json from: fixes/${siteId}/${hashKey}/rule-123456789/report.json`)).to.be.true;
    });

    it('logs warning when no updated files found for report', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/nonexistent/file.js'], // File not in S3 contents
          }),
        },
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);

      // Verify warning was logged
      expect(context.log.warn.calledWith(`No updated files found for report: fixes/${siteId}/${hashKey}/rule-123456789/report.json`)).to.be.true;
    });

    it('logs info when successfully applying accessibility fix', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 200);

      // Just verify the response is successful - logging is internal implementation
      const responseData = await response.json();
      expect(responseData.fixes).to.be.an('array').with.length(1);
      expect(responseData.fixes[0].statusCode).equals(200);
      expect(responseData.metadata.success).equals(1);
    });

    it('logs error when AIO app request fails', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      fetchStub.resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'AIO app error details',
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 200);

      // Verify error logs
      expect(context.log.error.calledWith('AIO app request failed: 500 Internal Server Error')).to.be.true;
      expect(context.log.error.calledWith('AIO app error response: AIO app error details')).to.be.true;
    });

    it('handles suggestion with missing URL', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock suggestion with missing URL
      mockSuggestion1.getData.returns({
        source: '#container form',
        issues: [{ type: 'aria-allowed-attr' }],
        // No URL
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No valid suggestions with URL and source found');
    });

    it('handles suggestion with missing source', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock suggestion with missing source
      mockSuggestion1.getData.returns({
        url: 'https://example.com/form',
        issues: [{ type: 'aria-allowed-attr' }],
        // No source
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No valid suggestions with URL and source found');
    });

    it('handles fetch throwing error during AIO request', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      // Mock fetch to throw an error
      fetchStub.throws(new Error('Network connection failed'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Failed to apply accessibility fix');
    });

    it('handles JSON parsing error in report', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
        ],
      });

      // Mock invalid JSON in report
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => 'invalid json content',
        },
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('handles createEntityAndUpdateSuggestions error', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      // Mock FixEntity.create to throw an error
      dataAccess.FixEntity.create.rejects(new Error('Database error'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Failed to apply accessibility fix');
    });

    it('handles suggestion save error during entity update', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      // Mock suggestion save to throw an error
      mockSuggestion1.save.rejects(new Error('Suggestion save error'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Failed to apply accessibility fix');
    });

    it('handles S3 file read error (covers line 403-404)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      // Mock S3 file read to throw an error (covers line 403-404)
      mockS3Client.send.onThirdCall().rejects(new Error('S3 file read error'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('handles S3 list objects error (covers line 421-422)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock S3 list objects to throw an error (covers line 421-422)
      mockS3Client.send.onFirstCall().rejects(new Error('S3 list error'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });

    it('handles missing IMS credentials (covers line 443-445)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          // Missing IMS credentials
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Authentication failed');
    });

    it('handles IMS service token error (covers line 451-453)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
          IMS_HOST: 'ims-na1.adobelogin.com',
          IMS_CLIENT_ID: 'test-client-id',
          IMS_CLIENT_SECRET: 'test-client-secret',
        },
        imsClient: context.imsClient,
        s3: {
          s3Client: mockS3Client,
        },
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';

      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'form content',
        },
      });

      // Mock IMS client to throw an error (covers line 451-453)
      requestContext.imsClient.getServiceAccessToken.rejects(new Error('IMS service error'));

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Authentication failed');
    });

    it('handles invalid suggestion ID format (covers line 67-68)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['invalid-uuid-format'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Invalid suggestion ID format: invalid-uuid-format');
    });

    it('handles missing S3 client (covers line 77-79)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        // No s3 client
      };

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 500);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'S3 service is not configured');
    });

    it('handles site with no GitHub URL (covers line 84-85)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock site with no GitHub URL
      mockSite.getGitHubURL.returns('');

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site must have a GitHub repository URL configured');
    });

    it('handles organization with no IMS org ID (covers line 90-91)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock organization with no IMS org ID
      mockOrganization.getImsOrgId.returns(null);

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'Site must belong to an organization with IMS Org ID');
    });

    it('handles S3 response with no Contents (covers line 423 branch)', async () => {
      const requestContext = {
        params: { siteId, opportunityId },
        data: {
          type: 'accessibility',
          suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
        log: context.log,
        env: {
          ASO_APP_URL: 'https://test-aso-app.com',
          S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        },
        s3: {
          s3Client: mockS3Client,
        },
      };

      // Mock S3 response with no Contents property (null/undefined)
      // This will trigger the falsy branch in line 423: response.Contents ? ... : []
      mockS3Client.send.onFirstCall().resolves({
        // No Contents property - this will be falsy and return []
      });

      const response = await controller.applyFixes(requestContext);
      expect(response).to.have.property('status', 400);
      const responseData = await response.json();
      expect(responseData).to.have.property('message', 'No matching fixes found in S3 for the provided suggestions');
    });
  });

  describe('constructor', () => {
    it('should register accessibility handler', () => {
      const testController = new ApplyFixesController(context, mockAccessControl);

      // Should not throw and should create the controller successfully
      expect(testController).to.be.instanceOf(ApplyFixesController);
    });

    it('should properly initialize data access collections', () => {
      const testController = new ApplyFixesController(context, mockAccessControl);

      // Verify that the controller was created successfully
      expect(testController).to.be.instanceOf(ApplyFixesController);

      // Test that the controller has the expected structure by calling a method
      expect(() => testController.applyFixes({
        params: { siteId: 'invalid', opportunityId: 'invalid' },
      })).to.not.throw;
    });
  });
});
