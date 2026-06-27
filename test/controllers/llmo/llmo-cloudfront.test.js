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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const TEST_SITE_ID = 'test-site-id';

const mockHttpUtils = {
  ok: (data, headers = {}) => ({
    status: 200,
    headers: new Map(Object.entries(headers)),
    json: async () => data,
  }),
  badRequest: (message) => ({
    status: 400,
    json: async () => ({ message }),
  }),
  forbidden: (message) => ({
    status: 403,
    json: async () => ({ message }),
  }),
  notFound: (message) => ({
    status: 404,
    json: async () => ({ message }),
  }),
  createResponse: (data, status) => ({
    status,
    json: async () => data,
  }),
  internalServerError: (message) => ({
    status: 500,
    json: async () => ({ message }),
  }),
  unauthorized: (message) => ({
    status: 401,
    json: async () => ({ message }),
  }),
};

const createMockAccessControlUtil = (
  accessResult,
  hasAdminAccessResult = true,
  isLLMOAdministratorResult = true,
) => ({
  fromContext: (context) => ({
    log: context.log,
    hasAccess: async () => accessResult,
    hasAdminAccess: () => hasAdminAccessResult,
    isLLMOAdministrator: () => isLLMOAdministratorResult,
    isOwnerOfSite: async () => accessResult,
  }),
});

describe('LlmoCloudFrontController', () => {
  let controller;
  let controllerWithAccessDenied;
  let LlmoCloudFrontController;
  let mockContext;
  let mockSite;
  let mockConfig;
  let mockDataAccess;
  let mockLog;
  let mockTokowakaClient;
  let assumeConnectorRoleStub;
  let listCloudFrontDistributionsStub;
  let getDistributionConfigStub;
  let createEdgeOptimizeOriginStub;
  let createEdgeOptimizeRoutingFunctionStub;
  let applyEdgeOptimizeCacheHeadersStub;
  let createEdgeOptimizeLambdaStub;
  let getEdgeOptimizeLambdaStatusStub;
  let applyEdgeOptimizeAssociationsStub;
  let verifyEdgeOptimizeRoutingStub;
  let runEdgeOptimizeDeployStepStub;
  let planEdgeOptimizeDeployStub;

  // The control-plane functions are imported from '@adobe/spacecat-shared-tokowaka-client';
  // the wrappers read the mutable outer stubs so each test can reassign them in beforeEach.
  const getEdgeOptimizeStubs = () => {
    function CloudFrontEdgeClient({ credentials, region } = {}) {
      this.credentials = credentials;
      this.region = region;
    }
    CloudFrontEdgeClient.prototype.listDistributions = function listDistributions() {
      return listCloudFrontDistributionsStub(this.credentials, this.region);
    };
    CloudFrontEdgeClient.prototype.getDistributionConfig = function getDistributionConfig(
      distributionId,
    ) {
      return getDistributionConfigStub(this.credentials, distributionId, this.region);
    };
    CloudFrontEdgeClient.prototype.createOrigin = function createOrigin(
      distributionId,
      originDomain,
      headers,
    ) {
      return createEdgeOptimizeOriginStub(
        this.credentials,
        distributionId,
        originDomain,
        headers,
        this.region,
      );
    };
    CloudFrontEdgeClient.prototype.createCloudFrontFunction = function createFunction(
      defaultOriginId,
      distributionId,
      targetedPaths,
    ) {
      return createEdgeOptimizeRoutingFunctionStub(
        this.credentials,
        defaultOriginId,
        distributionId,
        targetedPaths,
        this.region,
      );
    };
    CloudFrontEdgeClient.prototype.updateCacheSettings = function updateCacheSettings(
      distributionId,
      pathPattern,
      opts,
    ) {
      return applyEdgeOptimizeCacheHeadersStub(
        this.credentials,
        distributionId,
        pathPattern,
        opts,
      );
    };
    CloudFrontEdgeClient.prototype.createLambdaAtEdge = function createLambdaAtEdge(
      accountId,
      opts,
    ) {
      return createEdgeOptimizeLambdaStub(this.credentials, accountId, opts);
    };
    CloudFrontEdgeClient.prototype.getLambdaAtEdgeStatus = function getLambdaStatus(
      distributionId,
    ) {
      return getEdgeOptimizeLambdaStatusStub(this.credentials, distributionId, this.region);
    };
    CloudFrontEdgeClient.prototype.applyAssociations = function applyAssociations(
      distributionId,
      pathPattern,
      lambdaVersionArn,
    ) {
      return applyEdgeOptimizeAssociationsStub(
        this.credentials,
        distributionId,
        pathPattern,
        lambdaVersionArn,
        this.region,
      );
    };
    CloudFrontEdgeClient.prototype.runDeployStep = function runDeployStep(params) {
      return runEdgeOptimizeDeployStepStub(this.credentials, params, this.region);
    };
    CloudFrontEdgeClient.prototype.planDeploy = function planDeploy(params) {
      return planEdgeOptimizeDeployStub(this.credentials, params, this.region);
    };

    return {
      assumeConnectorRole: (...args) => assumeConnectorRoleStub(...args),
      listDistributions: (...args) => listCloudFrontDistributionsStub(...args),
      getDistributionConfig: (...args) => getDistributionConfigStub(...args),
      createOrigin: (...args) => createEdgeOptimizeOriginStub(...args),
      createCloudFrontFunction: (...args) => createEdgeOptimizeRoutingFunctionStub(...args),
      updateCacheSettings: (...args) => applyEdgeOptimizeCacheHeadersStub(...args),
      createLambdaAtEdge: (...args) => createEdgeOptimizeLambdaStub(...args),
      getLambdaAtEdgeStatus: (...args) => getEdgeOptimizeLambdaStatusStub(...args),
      applyAssociations: (...args) => applyEdgeOptimizeAssociationsStub(...args),
      verifyRouting: (...args) => verifyEdgeOptimizeRoutingStub(...args),
      runDeployStep: (...args) => runEdgeOptimizeDeployStepStub(...args),
      planDeploy: (...args) => planEdgeOptimizeDeployStub(...args),
      CloudFrontEdgeClient,
    };
  };

  const calculateForwardedHostMock = (url) => {
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      const h = u.hostname;
      const dots = (h.match(/\./g) || []).length;
      return dots === 1 ? `www.${h}` : h;
    } catch (e) {
      throw new Error(`Error calculating forwarded host from URL ${url}: ${e.message}`);
    }
  };

  const cfClientMocks = (accessControlMock) => ({
    '@adobe/spacecat-shared-http-utils': mockHttpUtils,
    '@adobe/spacecat-shared-utils': {
      hasText: (str) => typeof str === 'string' && str.trim().length > 0,
      composeBaseURL: (domain) => (domain.startsWith('http') ? domain : `https://${domain}`),
    },
    '@adobe/spacecat-shared-tokowaka-client': {
      default: { createFrom: () => mockTokowakaClient },
      calculateForwardedHost: calculateForwardedHostMock,
      ...getEdgeOptimizeStubs(),
    },
    '../../../src/support/access-control-util.js': accessControlMock,
  });

  before(async function beforeAll() {
    this.timeout(120000);
    assumeConnectorRoleStub = sinon.stub();
    listCloudFrontDistributionsStub = sinon.stub();
    getDistributionConfigStub = sinon.stub();
    createEdgeOptimizeOriginStub = sinon.stub();
    createEdgeOptimizeRoutingFunctionStub = sinon.stub();
    applyEdgeOptimizeCacheHeadersStub = sinon.stub();
    createEdgeOptimizeLambdaStub = sinon.stub();
    getEdgeOptimizeLambdaStatusStub = sinon.stub();
    applyEdgeOptimizeAssociationsStub = sinon.stub();
    verifyEdgeOptimizeRoutingStub = sinon.stub();
    runEdgeOptimizeDeployStepStub = sinon.stub();
    planEdgeOptimizeDeployStub = sinon.stub();
    mockTokowakaClient = { fetchMetaconfig: sinon.stub() };

    LlmoCloudFrontController = await esmock(
      '../../../src/controllers/llmo/llmo-cloudfront.js',
      cfClientMocks(createMockAccessControlUtil(true)),
    );
    controllerWithAccessDenied = await esmock(
      '../../../src/controllers/llmo/llmo-cloudfront.js',
      cfClientMocks(createMockAccessControlUtil(false)),
    );
  });

  beforeEach(() => {
    assumeConnectorRoleStub = sinon.stub();
    listCloudFrontDistributionsStub = sinon.stub();
    getDistributionConfigStub = sinon.stub();
    createEdgeOptimizeOriginStub = sinon.stub();
    createEdgeOptimizeRoutingFunctionStub = sinon.stub();
    applyEdgeOptimizeCacheHeadersStub = sinon.stub();
    createEdgeOptimizeLambdaStub = sinon.stub();
    getEdgeOptimizeLambdaStatusStub = sinon.stub();
    applyEdgeOptimizeAssociationsStub = sinon.stub();
    verifyEdgeOptimizeRoutingStub = sinon.stub();
    runEdgeOptimizeDeployStepStub = sinon.stub();
    planEdgeOptimizeDeployStub = sinon.stub();

    mockLog = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };
    mockConfig = { getEdgeOptimizeConfig: sinon.stub().returns({}) };
    mockSite = {
      getId: sinon.stub().returns(TEST_SITE_ID),
      getConfig: sinon.stub().returns(mockConfig),
      getBaseURL: sinon.stub().returns('https://www.example.com'),
    };
    mockDataAccess = { Site: { findById: sinon.stub().resolves(mockSite) } };
    mockTokowakaClient.fetchMetaconfig = sinon.stub();

    mockContext = {
      params: { siteId: TEST_SITE_ID },
      data: {},
      dataAccess: mockDataAccess,
      log: mockLog,
      env: {},
      s3: {},
    };

    controller = LlmoCloudFrontController(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createBootstrapUrl', () => {
    let bootstrapContext;
    let getSignedUrlStub;

    beforeEach(() => {
      getSignedUrlStub = sinon.stub().resolves('https://llmo-edgeoptimize-cf-template-stage.s3.us-east-1.amazonaws.com/customer-bootstrap-role.yaml?X-Amz-Signature=abc');
      bootstrapContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '682033462621' },
        env: {
          SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET: 'llmo-edgeoptimize-cf-template-stage',
          SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN: 'arn:aws:iam::682033462621:role/spacecat-role-lambda-generic',
        },
        s3: {
          s3Client: {},
          getSignedUrl: getSignedUrlStub,
          GetObjectCommand: class GetObjectCommand {},
        },
      };
    });

    it('returns a quick-create URL with a presigned template for a valid account', async () => {
      const result = await controller.createBootstrapUrl(bootstrapContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.quickCreateUrl).to.include('stacks/quickcreate');
      expect(body.quickCreateUrl).to.include('templateURL=');
      expect(body.quickCreateUrl).to.include('param_RoleName=AdobeLLMOptimizerCloudFrontConnectorRole');
      expect(body.roleArn).to.equal('arn:aws:iam::682033462621:role/AdobeLLMOptimizerCloudFrontConnectorRole');
      expect(body.externalId).to.be.a('string');
      expect(getSignedUrlStub.calledOnce).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.createBootstrapUrl({ ...bootstrapContext, data: { accountId: '123' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('12-digit');
    });

    it('returns 400 when template hosting is not configured (no S3 client)', async () => {
      // While the TEMPORARY hardcoded bucket default is in place the bucket is always
      // set, so the "not configured" guard is exercised via the missing S3 client.
      // TODO: restore the `env: {}` (empty-bucket) variant once the temp default is removed.
      const result = await controller.createBootstrapUrl({
        ...bootstrapContext,
        s3: {},
      });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('not configured');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.createBootstrapUrl(bootstrapContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.createBootstrapUrl(bootstrapContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .createBootstrapUrl(bootstrapContext);
      expect(result.status).to.equal(403);
    });

    it('returns 400 when the trusted principal is not configured', async () => {
      const result = await controller.createBootstrapUrl({
        ...bootstrapContext,
        env: { SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET: 'llmo-edgeoptimize-cf-template-stage' },
      });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('missing trusted principal');
    });

    it('returns 500 with a generic message when presigning the template fails', async () => {
      getSignedUrlStub.rejects(new Error('presign boom'));

      const result = await controller.createBootstrapUrl(bootstrapContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('presign boom');
      expect(body.message).to.include('Failed to generate the edge optimize bootstrap URL');
    });
  });

  describe('connect', () => {
    let connectContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      connectContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
        env: {},
      };
    });

    it('returns connected true when the connector role is assumable', async () => {
      const result = await controller.connect(connectContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.connected).to.equal(true);
      expect(body.accountId).to.equal('120569600543');
      expect(body.roleArn).to.include('AdobeLLMOptimizerCloudFrontConnectorRole');
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
    });

    it('returns connected false (not erroring) when the role is not yet assumable', async () => {
      assumeConnectorRoleStub = sinon.stub().rejects(new Error('AccessDenied: not authorized to assume'));

      const result = await controller.connect(connectContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.connected).to.equal(false);
      expect(body.reason).to.include('AccessDenied');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.connect({ ...connectContext, data: { accountId: '123', externalId: 'ext' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('12-digit');
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.connect({ ...connectContext, data: { accountId: '120569600543' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('externalId');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.connect(connectContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.connect(connectContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));

      const result = await LlmoControllerNoAdmin(mockContext).connect(connectContext);

      expect(result.status).to.equal(403);
    });

    it('returns 500 with a generic message when an unexpected error occurs', async () => {
      mockDataAccess.Site.findById.rejects(new Error('db boom'));

      const result = await controller.connect(connectContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('db boom');
      expect(body.message).to.include('Failed to connect the edge optimize role');
    });
  });

  describe('listDistributions', () => {
    let distributionsContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      listCloudFrontDistributionsStub = sinon.stub().resolves([
        {
          id: 'E2EXAMPLE123',
          domainName: 'd111111abcdef8.cloudfront.net',
          aliases: ['www.example.com'],
          status: 'Deployed',
          enabled: true,
          comment: '',
        },
      ]);
      distributionsContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
        env: {},
      };
    });

    it('returns the list of CloudFront distributions', async () => {
      const result = await controller.listDistributions(distributionsContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.distributions).to.have.length(1);
      expect(body.distributions[0].id).to.equal('E2EXAMPLE123');
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(listCloudFrontDistributionsStub.calledOnce).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.listDistributions({ ...distributionsContext, data: { accountId: '123', externalId: 'ext' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.listDistributions({ ...distributionsContext, data: { accountId: '120569600543' } });

      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      listCloudFrontDistributionsStub = sinon.stub().rejects(new Error('ListDistributions failed'));

      const result = await controller.listDistributions(distributionsContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('ListDistributions failed');
      expect(body.message).to.include('Failed to list CloudFront distributions');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.listDistributions(distributionsContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.listDistributions(distributionsContext);

      expect(result.status).to.equal(403);
    });
  });

  describe('checkPrerequisites', () => {
    let prereqContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      listCloudFrontDistributionsStub = sinon.stub().resolves([]);
      prereqContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
        env: {},
      };
    });

    it('returns all checks ok when the role assumes and CloudFront is readable', async () => {
      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.checks).to.deep.equal([
        { name: 'connectorRole', ok: true },
        { name: 'cloudFrontRead', ok: true },
      ]);
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(listCloudFrontDistributionsStub.calledOnce).to.equal(true);
    });

    it('reports connectorRole false (not erroring) when the role is not assumable', async () => {
      assumeConnectorRoleStub = sinon.stub().rejects(new Error('AccessDenied: cannot assume'));

      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.checks[0]).to.include({ name: 'connectorRole', ok: false });
      expect(body.checks[0].detail).to.include('AccessDenied');
      expect(body.checks[1]).to.include({ name: 'cloudFrontRead', ok: false });
    });

    it('reports cloudFrontRead false (not erroring) when the list call fails', async () => {
      listCloudFrontDistributionsStub = sinon.stub().rejects(new Error('AccessDenied: cloudfront:ListDistributions'));

      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.checks[0]).to.deep.equal({ name: 'connectorRole', ok: true });
      expect(body.checks[1]).to.include({ name: 'cloudFrontRead', ok: false });
      expect(body.checks[1].detail).to.include('ListDistributions');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.checkPrerequisites({ ...prereqContext, data: { accountId: '123', externalId: 'ext' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.checkPrerequisites({ ...prereqContext, data: { accountId: '120569600543' } });

      expect(result.status).to.equal(400);
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));

      const controllerNoAdmin = LlmoControllerNoAdmin(mockContext);
      const result = await controllerNoAdmin.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(403);
    });

    it('returns 500 with a generic message when an unexpected error occurs', async () => {
      mockDataAccess.Site.findById.rejects(new Error('db boom'));

      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('db boom');
      expect(body.message).to.include('Failed to check edge optimize prerequisites');
    });
  });

  describe('fetchOrigins', () => {
    let originsContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [
          { id: 'origin-aem', domainName: 'origin.example.com', originPath: '/content' },
        ],
        defaultCacheBehavior: { pathPattern: 'Default (*)', targetOriginId: 'origin-aem' },
        cacheBehaviors: [],
      });
      originsContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: {},
      };
    });

    it('returns the origins and hasEdgeOptimizeOrigin false when none match', async () => {
      const result = await controller.fetchOrigins(originsContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.origins).to.have.length(1);
      expect(body.origins[0].id).to.equal('origin-aem');
      expect(body.hasEdgeOptimizeOrigin).to.equal(false);
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(getDistributionConfigStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123')).to.equal(true);
    });

    it('detects an Edge Optimize origin by id', async () => {
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [
          { id: 'EdgeOptimizeOrigin', domainName: 'something.example.com', originPath: '' },
        ],
        defaultCacheBehavior: null,
        cacheBehaviors: [],
      });

      const result = await controller.fetchOrigins(originsContext);

      const body = await result.json();
      expect(body.hasEdgeOptimizeOrigin).to.equal(true);
    });

    it('detects an Edge Optimize origin by domain', async () => {
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [
          { id: 'custom', domainName: 'live.edgeoptimize.net', originPath: '' },
        ],
        defaultCacheBehavior: null,
        cacheBehaviors: [],
      });

      const result = await controller.fetchOrigins(originsContext);

      const body = await result.json();
      expect(body.hasEdgeOptimizeOrigin).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.fetchOrigins({ ...originsContext, data: { ...originsContext.data, accountId: '123' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.fetchOrigins({ ...originsContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.fetchOrigins({ ...originsContext, data: { accountId: '120569600543', externalId: 'ext' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      getDistributionConfigStub = sinon.stub().rejects(new Error('GetDistributionConfig failed'));

      const result = await controller.fetchOrigins(originsContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('GetDistributionConfig failed');
      expect(body.message).to.include('Failed to read CloudFront origins');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.fetchOrigins(originsContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.fetchOrigins(originsContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));

      const controllerNoAdmin = LlmoControllerNoAdmin(mockContext);
      const result = await controllerNoAdmin.fetchOrigins(originsContext);

      expect(result.status).to.equal(403);
    });
  });

  describe('fetchBehaviors', () => {
    let behaviorsContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [],
        defaultCacheBehavior: { pathPattern: 'Default (*)', targetOriginId: 'origin-aem' },
        cacheBehaviors: [
          { pathPattern: '/api/*', targetOriginId: 'origin-api' },
        ],
      });
      behaviorsContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: {},
      };
    });

    it('returns the default behavior plus ordered cache behaviors', async () => {
      const result = await controller.fetchBehaviors(behaviorsContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.behaviors).to.deep.equal([
        { pathPattern: 'Default (*)', targetOriginId: 'origin-aem', isDefault: true },
        { pathPattern: '/api/*', targetOriginId: 'origin-api', isDefault: false },
      ]);
      expect(getDistributionConfigStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123')).to.equal(true);
    });

    it('omits the default entry when the distribution has none', async () => {
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [],
        defaultCacheBehavior: null,
        cacheBehaviors: [{ pathPattern: '/api/*', targetOriginId: 'origin-api' }],
      });

      const result = await controller.fetchBehaviors(behaviorsContext);

      const body = await result.json();
      expect(body.behaviors).to.deep.equal([
        { pathPattern: '/api/*', targetOriginId: 'origin-api', isDefault: false },
      ]);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.fetchBehaviors({ ...behaviorsContext, data: { ...behaviorsContext.data, accountId: '123' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.fetchBehaviors({ ...behaviorsContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.fetchBehaviors({ ...behaviorsContext, data: { accountId: '120569600543', externalId: 'ext' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      getDistributionConfigStub = sinon.stub().rejects(new Error('GetDistributionConfig failed'));

      const result = await controller.fetchBehaviors(behaviorsContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('GetDistributionConfig failed');
      expect(body.message).to.include('Failed to read CloudFront behaviors');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.fetchBehaviors(behaviorsContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.fetchBehaviors(behaviorsContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));

      const controllerNoAdmin = LlmoControllerNoAdmin(mockContext);
      const result = await controllerNoAdmin.fetchBehaviors(behaviorsContext);

      expect(result.status).to.equal(403);
    });
  });

  describe('createOrigin', () => {
    let originContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      createEdgeOptimizeOriginStub = sinon.stub().resolves({
        created: true, alreadyExisted: false, updated: false, originId: 'EdgeOptimize_Origin',
      });
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
      originContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: {},
      };
    });

    it('creates the origin and returns the result', async () => {
      const result = await controller.createOrigin(originContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({
        created: true, alreadyExisted: false, updated: false, originId: 'EdgeOptimize_Origin',
      });
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(createEdgeOptimizeOriginStub.calledOnceWith(
        sinon.match.any,
        'E2EXAMPLE123',
        'live.edgeoptimize.net',
        sinon.match({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' }),
      )).to.equal(true);
    });

    it('passes the env-driven origin domain when set', async () => {
      await controller.createOrigin({
        ...originContext,
        env: { EDGE_OPTIMIZE_EDGE_DOMAIN: 'live.edgeoptimize.net' },
      });

      expect(createEdgeOptimizeOriginStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', 'live.edgeoptimize.net')).to.equal(true);
    });

    it('returns 400 when the site has no Edge Optimize API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });

      const result = await controller.createOrigin(originContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(createEdgeOptimizeOriginStub.called).to.equal(false);
    });

    it("returns 400 when environment is neither 'production' nor 'stage'", async () => {
      const result = await controller.createOrigin({
        ...originContext,
        data: { ...originContext.data, environment: 'staging' },
      });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include("'production' or 'stage'");
      expect(createEdgeOptimizeOriginStub.called).to.equal(false);
    });

    it('is idempotent when the origin already exists', async () => {
      createEdgeOptimizeOriginStub = sinon.stub().resolves({
        created: false, alreadyExisted: true, updated: false, originId: 'EdgeOptimize_Origin',
      });

      const result = await controller.createOrigin(originContext);
      const body = await result.json();
      expect(body.alreadyExisted).to.equal(true);
    });

    it('reports a header patch on an existing header-less origin', async () => {
      createEdgeOptimizeOriginStub = sinon.stub().resolves({
        created: false, alreadyExisted: true, updated: true, originId: 'EdgeOptimize_Origin',
      });

      const result = await controller.createOrigin(originContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.updated).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.createOrigin({ ...originContext, data: { ...originContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.createOrigin({ ...originContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.createOrigin({ ...originContext, data: { accountId: '120569600543', externalId: 'ext' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createEdgeOptimizeOriginStub = sinon.stub().rejects(new Error('UpdateDistribution failed'));
      const result = await controller.createOrigin(originContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('UpdateDistribution failed');
      expect(body.message).to.include('Failed to create the edge optimize origin');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.createOrigin(originContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.createOrigin(originContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .createOrigin(originContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('createRoutingFunction', () => {
    let functionContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [],
        defaultCacheBehavior: { pathPattern: 'Default (*)', targetOriginId: 'origin-aem' },
        cacheBehaviors: [],
      });
      createEdgeOptimizeRoutingFunctionStub = sinon.stub().resolves({
        name: 'edgeoptimize-routing', created: true, stage: 'LIVE',
      });
      functionContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: {},
      };
    });

    it('creates the routing function using the default origin id', async () => {
      const result = await controller.createRoutingFunction(functionContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({ name: 'edgeoptimize-routing', created: true, stage: 'LIVE' });
      expect(createEdgeOptimizeRoutingFunctionStub.calledOnceWith(sinon.match.any, 'origin-aem', 'E2EXAMPLE123', null)).to.equal(true);
    });

    it('returns 400 when the default cache behavior has no target origin', async () => {
      getDistributionConfigStub = sinon.stub().resolves({
        origins: [], defaultCacheBehavior: null, cacheBehaviors: [],
      });
      const result = await controller.createRoutingFunction(functionContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('default cache behavior');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.createRoutingFunction({ ...functionContext, data: { ...functionContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.createRoutingFunction({ ...functionContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.createRoutingFunction({ ...functionContext, data: { accountId: '120569600543', externalId: 'ext' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createEdgeOptimizeRoutingFunctionStub = sinon.stub().rejects(new Error('CreateFunction failed'));
      const result = await controller.createRoutingFunction(functionContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('CreateFunction failed');
      expect(body.message).to.include('Failed to create the edge optimize routing function');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.createRoutingFunction(functionContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.createRoutingFunction(functionContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .createRoutingFunction(functionContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('applyCache', () => {
    let cacheContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      applyEdgeOptimizeCacheHeadersStub = sinon.stub().resolves({
        policyId: 'cp-1', updated: true, alreadyForwarded: false,
      });
      cacheContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
          pathPattern: '/api/*',
        },
        env: {},
      };
    });

    it('applies the cache headers to the selected behavior', async () => {
      const result = await controller.applyCache(cacheContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.policyId).to.equal('cp-1');
      expect(applyEdgeOptimizeCacheHeadersStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', '/api/*')).to.equal(true);
    });

    it('defaults the behavior to "default" when pathPattern is omitted', async () => {
      await controller.applyCache({
        ...cacheContext,
        data: { ...cacheContext.data, pathPattern: undefined },
      });
      expect(applyEdgeOptimizeCacheHeadersStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', 'default')).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.applyCache({ ...cacheContext, data: { ...cacheContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.applyCache({ ...cacheContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.applyCache({ ...cacheContext, data: { accountId: '120569600543', externalId: 'ext' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      applyEdgeOptimizeCacheHeadersStub = sinon.stub().rejects(new Error('UpdateCachePolicy failed'));
      const result = await controller.applyCache(cacheContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('UpdateCachePolicy failed');
      expect(body.message).to.include('Failed to apply edge optimize cache headers');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.applyCache(cacheContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.applyCache(cacheContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext).applyCache(cacheContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('createLambda', () => {
    let lambdaContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      createEdgeOptimizeLambdaStub = sinon.stub().resolves({
        functionArn: 'arn:fn',
        versionArn: 'arn:fn:1',
        version: '1',
        roleArn: 'arn:role',
        created: true,
      });
      lambdaContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5', distributionId: 'E2EXAMPLE123' },
        env: {},
      };
    });

    it('creates the Lambda@Edge function and returns the versioned ARN', async () => {
      const result = await controller.createLambda(lambdaContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.versionArn).to.equal('arn:fn:1');
      expect(body.version).to.equal('1');
      expect(createEdgeOptimizeLambdaStub.calledOnceWith(sinon.match.any, '120569600543')).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.createLambda({ ...lambdaContext, data: { accountId: '123', externalId: 'ext' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.createLambda({ ...lambdaContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distribution id is missing', async () => {
      const result = await controller.createLambda({
        ...lambdaContext,
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId is required');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createEdgeOptimizeLambdaStub = sinon.stub().rejects(new Error('CreateRole failed'));
      const result = await controller.createLambda(lambdaContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('CreateRole failed');
      expect(body.message).to.include('Failed to create the edge optimize Lambda@Edge function');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.createLambda(lambdaContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.createLambda(lambdaContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .createLambda(lambdaContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('fetchLambdaStatus', () => {
    let statusContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      getEdgeOptimizeLambdaStatusStub = sinon.stub().resolves({
        exists: true, state: 'Active', lastUpdateStatus: 'Successful', versionArn: 'arn:fn:2', version: '2',
      });
      statusContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5', distributionId: 'E2EXAMPLE123' },
        env: {},
      };
    });

    it('returns the Lambda@Edge status with the versioned ARN', async () => {
      const result = await controller.fetchLambdaStatus(statusContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.exists).to.equal(true);
      expect(body.versionArn).to.equal('arn:fn:2');
      expect(getEdgeOptimizeLambdaStatusStub.calledOnce).to.equal(true);
    });

    it('returns exists:false when the function is absent', async () => {
      getEdgeOptimizeLambdaStatusStub = sinon.stub().resolves({ exists: false, versionArn: null });
      const result = await controller.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.exists).to.equal(false);
      expect(body.versionArn).to.equal(null);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.fetchLambdaStatus({ ...statusContext, data: { accountId: '123', externalId: 'ext' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.fetchLambdaStatus({ ...statusContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distribution id is missing', async () => {
      const result = await controller.fetchLambdaStatus({
        ...statusContext,
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId is required');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      getEdgeOptimizeLambdaStatusStub = sinon.stub().rejects(new Error('ListVersions failed'));
      const result = await controller.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('ListVersions failed');
      expect(body.message).to.include('Failed to read the edge optimize Lambda@Edge status');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('applyAssociations', () => {
    let associateContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      applyEdgeOptimizeAssociationsStub = sinon.stub().resolves({
        cloudFrontFunctionArn: 'arn:cf-fn',
        lambdaArn: 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1',
      });
      associateContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
          pathPattern: '/api/*',
          lambdaVersionArn: 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1',
        },
        env: {},
      };
    });

    it('associates the function and lambda onto the selected behavior', async () => {
      const result = await controller.applyAssociations(associateContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.cloudFrontFunctionArn).to.equal('arn:cf-fn');
      expect(applyEdgeOptimizeAssociationsStub.calledOnceWith(
        sinon.match.any,
        'E2EXAMPLE123',
        '/api/*',
        'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1',
      )).to.equal(true);
    });

    it('returns 400 when the lambdaVersionArn is missing', async () => {
      const result = await controller.applyAssociations({
        ...associateContext,
        data: { ...associateContext.data, lambdaVersionArn: undefined },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('lambdaVersionArn');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.applyAssociations({ ...associateContext, data: { ...associateContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.applyAssociations({ ...associateContext, data: { ...associateContext.data, externalId: '' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.applyAssociations({ ...associateContext, data: { ...associateContext.data, distributionId: '' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the lambdaVersionArn is not a versioned us-east-1 Lambda ARN', async () => {
      const result = await controller.applyAssociations({
        ...associateContext,
        data: { ...associateContext.data, lambdaVersionArn: 'arn:aws:lambda:us-west-2:120569600543:function:edgeoptimize-origin:1' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('lambdaVersionArn must be a versioned us-east-1 Lambda ARN');
    });

    it('returns 400 when the lambdaVersionArn is unversioned (no trailing version)', async () => {
      const result = await controller.applyAssociations({
        ...associateContext,
        data: { ...associateContext.data, lambdaVersionArn: 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('lambdaVersionArn must be a versioned us-east-1 Lambda ARN');
    });

    it('returns 400 when the lambdaVersionArn account segment does not match the request account', async () => {
      const result = await controller.applyAssociations({
        ...associateContext,
        data: { ...associateContext.data, lambdaVersionArn: 'arn:aws:lambda:us-east-1:999999999999:function:edgeoptimize-origin:1' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('lambdaVersionArn must be a versioned us-east-1 Lambda ARN');
    });

    it('returns 500 with a generic message when the AWS call fails (conflict)', async () => {
      applyEdgeOptimizeAssociationsStub = sinon.stub().rejects(new Error('already has a different viewer-request function'));
      const result = await controller.applyAssociations(associateContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('viewer-request');
      expect(body.message).to.include('Failed to associate edge optimize routing');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.applyAssociations(associateContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.applyAssociations(associateContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .applyAssociations(associateContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('verifyRouting', () => {
    let verifyContext;

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      listCloudFrontDistributionsStub = sinon.stub().resolves([
        {
          id: 'E2EXAMPLE123', domainName: 'd111111abcdef8.cloudfront.net', aliases: [], status: 'Deployed', enabled: true, comment: '',
        },
      ]);
      verifyEdgeOptimizeRoutingStub = sinon.stub().resolves({
        passed: true,
        requestId: 'req-123',
        details: { bot: { status: 200, headers: {} }, human: { status: 200, headers: {} } },
      });
      verifyContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: {},
      };
    });

    it('resolves the domain from the site and verifies routing (no distribution lookup)', async () => {
      const result = await controller.verifyRouting(verifyContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.passed).to.equal(true);
      expect(body.requestId).to.equal('req-123');
      expect(verifyEdgeOptimizeRoutingStub.calledOnceWith('https://www.example.com/')).to.equal(true);
      expect(listCloudFrontDistributionsStub.called).to.equal(false);
    });

    it('uses an explicit domain when provided (no distribution lookup)', async () => {
      await controller.verifyRouting({ ...verifyContext, data: { ...verifyContext.data, domain: 'www.example.com' } });
      expect(listCloudFrontDistributionsStub.called).to.equal(false);
      expect(verifyEdgeOptimizeRoutingStub.calledOnceWith('https://www.example.com/')).to.equal(true);
    });

    it('falls back to the distribution domain when the site host is unavailable', async () => {
      mockSite.getBaseURL.returns('');
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(200);
      expect(verifyEdgeOptimizeRoutingStub.calledOnceWith('https://d111111abcdef8.cloudfront.net/')).to.equal(true);
      expect(listCloudFrontDistributionsStub.calledOnce).to.equal(true);
    });

    it('returns 400 when no domain can be resolved (no site host, no distribution)', async () => {
      mockSite.getBaseURL.returns('');
      listCloudFrontDistributionsStub = sinon.stub().resolves([]);
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('domain');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.verifyRouting({ ...verifyContext, data: { ...verifyContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.verifyRouting({ ...verifyContext, data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.verifyRouting({ ...verifyContext, data: { accountId: '120569600543', externalId: 'ext' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the verify call fails', async () => {
      verifyEdgeOptimizeRoutingStub = sinon.stub().rejects(new Error('fetch failed'));
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('fetch failed');
      expect(body.message).to.include('Failed to verify edge optimize routing');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.verifyRouting(verifyContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .verifyRouting(verifyContext);
      expect(result.status).to.equal(403);
    });
  });

  describe('deploy', () => {
    let deployContext;

    const sampleSteps = [
      { key: 'origin', label: 'Edge Optimize origin', status: 'done' },
      { key: 'function', label: 'Routing function', status: 'done' },
      { key: 'cache', label: 'Cache policy', status: 'done' },
      { key: 'lambda', label: 'Lambda@Edge', status: 'in_progress' },
      { key: 'associate', label: 'Association', status: 'pending' },
      { key: 'verify', label: 'Verify routing', status: 'pending' },
    ];

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      runEdgeOptimizeDeployStepStub = sinon.stub().resolves({
        routingDeployed: false,
        verified: false,
        steps: sampleSteps,
      });
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
      deployContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
          originId: 'origin-aem',
          behavior: 'default',
        },
        env: {},
      };
    });

    it('runs the orchestrator and returns the per-step status', async () => {
      const result = await controller.deploy(deployContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.routingDeployed).to.equal(false);
      expect(body.verified).to.equal(false);
      expect(body.steps).to.deep.equal(sampleSteps);
      // assumeConnectorRole is called exactly once for the whole sequence.
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(runEdgeOptimizeDeployStepStub.calledOnce).to.equal(true);
      const [, params] = runEdgeOptimizeDeployStepStub.firstCall.args;
      expect(params).to.include({
        distributionId: 'E2EXAMPLE123',
        originId: 'origin-aem',
        behavior: 'default',
        originDomain: 'live.edgeoptimize.net',
        accountId: '120569600543',
      });
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('passes the env-driven origin domain when set', async () => {
      await controller.deploy({
        ...deployContext,
        env: { EDGE_OPTIMIZE_EDGE_DOMAIN: 'live.edgeoptimize.net' },
      });
      const [, params] = runEdgeOptimizeDeployStepStub.firstCall.args;
      expect(params.originDomain).to.equal('live.edgeoptimize.net');
    });

    it('returns 400 when the site has no Edge Optimize API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(runEdgeOptimizeDeployStepStub.called).to.equal(false);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, externalId: '' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, distributionId: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 400 when the originId is missing', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, originId: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('originId');
    });

    it('returns 400 when the behavior is missing', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, behavior: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('behavior');
    });

    it('returns 500 with a generic message when the orchestrator throws', async () => {
      runEdgeOptimizeDeployStepStub = sinon.stub().rejects(new Error('assume failed'));
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('assume failed');
      expect(body.message).to.include('Failed to deploy edge optimize routing');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.deploy(deployContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .deploy(deployContext);
      expect(result.status).to.equal(403);
    });

    it('defaults to production resolution when environment is omitted', async () => {
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(200);
      const [, params] = runEdgeOptimizeDeployStepStub.firstCall.args;
      // production path uses the prod baseURL host (www.example.com) + prod metaconfig key.
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it("uses the stage apiKey + forwardedHost when environment is 'stage'", async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({
        stagingDomains: [{ domain: 'staging.example.com', id: 'stage-site-id' }],
      });
      mockDataAccess.Site.findByBaseURL = sinon.stub()
        .withArgs('https://staging.example.com')
        .resolves({ getId: () => 'stage-site-id' });
      // prod metaconfig is the default stub; the stage one wins for the stage baseURL.
      mockTokowakaClient.fetchMetaconfig
        .withArgs('https://staging.example.com')
        .resolves({ apiKeys: ['stage-key-999'] });

      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, environment: 'stage' },
      });

      expect(result.status).to.equal(200);
      const [, params] = runEdgeOptimizeDeployStepStub.firstCall.args;
      expect(params.originHeaders).to.deep.equal({
        apiKey: 'stage-key-999',
        forwardedHost: 'staging.example.com',
      });
    });

    it('returns 400 for an unknown environment', async () => {
      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, environment: 'qa' },
      });
      expect(result.status).to.equal(400);
      expect(runEdgeOptimizeDeployStepStub.called).to.equal(false);
    });

    it('returns 400 for stage when no stage domain is configured', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({});
      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, environment: 'stage' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('No stage domain');
      expect(runEdgeOptimizeDeployStepStub.called).to.equal(false);
    });

    it('returns 400 for stage when the stage site is not found', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({
        stagingDomains: [{ domain: 'staging.example.com', id: 'stage-site-id' }],
      });
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves(null);
      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, environment: 'stage' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Stage site not found');
      expect(runEdgeOptimizeDeployStepStub.called).to.equal(false);
    });

    it('returns 400 for stage when the stage site has no Edge Optimize API key', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({
        stagingDomains: [{ domain: 'staging.example.com', id: 'stage-site-id' }],
      });
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves({ getId: () => 'stage-site-id' });
      mockTokowakaClient.fetchMetaconfig
        .withArgs('https://staging.example.com')
        .resolves({ apiKeys: [] });
      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, environment: 'stage' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Stage site has no Edge Optimize API key');
      expect(runEdgeOptimizeDeployStepStub.called).to.equal(false);
    });
  });

  describe('plan', () => {
    let planContext;

    const samplePlan = {
      canProceed: true,
      blocker: null,
      steps: [
        {
          key: 'origin', label: 'Edge Optimize origin', action: 'create', detail: 'add origin',
        },
        {
          key: 'function', label: 'Routing function', action: 'create', detail: 'create fn',
        },
        {
          key: 'cache', label: 'Cache policy', action: 'update', detail: 'legacy',
        },
        {
          key: 'lambda', label: 'Lambda@Edge', action: 'create', detail: 'create lambda',
        },
        {
          key: 'associate', label: 'Association', action: 'create', detail: 'will associate',
        },
      ],
    };

    beforeEach(() => {
      assumeConnectorRoleStub = sinon.stub().resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      planEdgeOptimizeDeployStub = sinon.stub().resolves(samplePlan);
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
      planContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
          originId: 'origin-aem',
          behavior: 'default',
        },
        env: {},
      };
    });

    it('runs the planner and returns the per-step plan', async () => {
      const result = await controller.plan(planContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      // plan response now carries an extra targetDomain (the resolved host) alongside the plan.
      expect(body).to.deep.equal({ ...samplePlan, targetDomain: 'www.example.com' });
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(planEdgeOptimizeDeployStub.calledOnce).to.equal(true);
      const [, params] = planEdgeOptimizeDeployStub.firstCall.args;
      expect(params).to.include({
        distributionId: 'E2EXAMPLE123',
        originId: 'origin-aem',
        behavior: 'default',
        originDomain: 'live.edgeoptimize.net',
        accountId: '120569600543',
      });
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('returns canProceed:false + blocker when the behavior is already associated', async () => {
      planEdgeOptimizeDeployStub = sinon.stub().resolves({
        canProceed: false,
        blocker: "This behaviour is already associated with routes, please recheck — can't proceed with this automation.",
        steps: samplePlan.steps,
      });

      const result = await controller.plan(planContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.canProceed).to.equal(false);
      expect(body.blocker).to.include("can't proceed with this automation");
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
      expect(planEdgeOptimizeDeployStub.called).to.equal(false);
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, externalId: '' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, distributionId: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 400 when the originId is missing', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, originId: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('originId');
    });

    it('returns 400 when the behavior is missing', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, behavior: '' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('behavior');
    });

    it('returns 400 when the site has no Edge Optimize API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(planEdgeOptimizeDeployStub.called).to.equal(false);
    });

    it('returns 500 with a generic message when the planner throws', async () => {
      planEdgeOptimizeDeployStub = sinon.stub().rejects(new Error('plan failed'));
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('plan failed');
      expect(body.message).to.include('Failed to preview edge optimize routing');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.plan(planContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .plan(planContext);
      expect(result.status).to.equal(403);
    });

    it('returns targetDomain (prod host) and defaults to production when env is omitted', async () => {
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.targetDomain).to.equal('www.example.com');
      const [, params] = planEdgeOptimizeDeployStub.firstCall.args;
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('uses the stage apiKey + forwardedHost and returns the stage targetDomain', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({
        stagingDomains: [{ domain: 'staging.example.com', id: 'stage-site-id' }],
      });
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves({ getId: () => 'stage-site-id' });
      mockTokowakaClient.fetchMetaconfig
        .withArgs('https://staging.example.com')
        .resolves({ apiKeys: ['stage-key-999'] });

      const result = await controller.plan({
        ...planContext,
        data: { ...planContext.data, environment: 'stage' },
      });

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.targetDomain).to.equal('staging.example.com');
      const [, params] = planEdgeOptimizeDeployStub.firstCall.args;
      expect(params.originHeaders).to.deep.equal({
        apiKey: 'stage-key-999',
        forwardedHost: 'staging.example.com',
      });
    });

    it('returns 400 for an unknown environment', async () => {
      const result = await controller.plan({
        ...planContext,
        data: { ...planContext.data, environment: 'qa' },
      });
      expect(result.status).to.equal(400);
      expect(planEdgeOptimizeDeployStub.called).to.equal(false);
    });

    it('returns 400 for stage when no stage domain is configured', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({});
      const result = await controller.plan({
        ...planContext,
        data: { ...planContext.data, environment: 'stage' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('No stage domain');
      expect(planEdgeOptimizeDeployStub.called).to.equal(false);
    });

    it('returns 400 for stage when the stage site is not found', async () => {
      mockConfig.getEdgeOptimizeConfig = sinon.stub().returns({
        stagingDomains: [{ domain: 'staging.example.com', id: 'stage-site-id' }],
      });
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves(null);
      const result = await controller.plan({
        ...planContext,
        data: { ...planContext.data, environment: 'stage' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Stage site not found');
      expect(planEdgeOptimizeDeployStub.called).to.equal(false);
    });
  });

  describe('getPermissions', () => {
    let permissionsContext;
    let s3SendStub;

    // The connector role template (with the Metadata block) the endpoint reads from S3 — including
    // a CloudFormation intrinsic tag (!Ref) to exercise the CFN-tolerant YAML schema.
    const sampleTemplate = [
      "AWSTemplateFormatVersion: '2010-09-09'",
      'Metadata:',
      '  AdobeLLMOptimizerPermissions:',
      '    appName: Adobe LLM Optimizer Deployer',
      '    groups:',
      '      - name: CloudFront',
      '        scope: All distributions',
      '        summary: Add the Edge Optimize origin and routing function.',
      '      - name: IAM',
      "        scope: 'role/edgeoptimize-* only'",
      '        summary: Create the execution role.',
      'Resources:',
      '  ConnectorRole:',
      '    Type: AWS::IAM::Role',
      '    Properties:',
      '      RoleName: !Ref RoleName',
    ].join('\n');

    // The endpoint maps the template's {name, scope, summary} groups to the UI's {name, items[]}.
    const expectedManifest = {
      appName: 'Adobe LLM Optimizer Deployer',
      groups: [
        { name: 'CloudFront', items: ['Scoped to All distributions', 'Add the Edge Optimize origin and routing function.'] },
        { name: 'IAM', items: ['Scoped to role/edgeoptimize-* only', 'Create the execution role.'] },
      ],
    };

    beforeEach(() => {
      s3SendStub = sinon.stub().resolves({
        Body: { transformToString: async () => sampleTemplate },
      });
      permissionsContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        env: {
          SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET: 'llmo-edgeoptimize-cf-template',
          SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN: 'arn:aws:iam::682033462621:role/spacecat-role-lambda-generic',
        },
        s3: {
          s3Client: { send: s3SendStub },
          GetObjectCommand: function MockGetObjectCommand(params) {
            Object.assign(this, params);
          },
        },
      };
    });

    it('returns the manifest + adobeAccount', async () => {
      const result = await controller.getPermissions(permissionsContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.manifest).to.deep.equal(expectedManifest);
      expect(body.adobeAccount).to.equal('arn:aws:iam::682033462621:role/spacecat-role-lambda-generic');
      expect(s3SendStub.calledOnce).to.equal(true);
      const [cmd] = s3SendStub.firstCall.args;
      expect(cmd.Key).to.equal('customer-bootstrap-role.yaml');
      expect(cmd.Bucket).to.equal('llmo-edgeoptimize-cf-template');
    });

    it('uses env-configured bucket + trusted principal when set', async () => {
      const result = await controller.getPermissions({
        ...permissionsContext,
        env: {
          SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET: 'custom-bucket',
          SPACECAT_CDN_CLOUDFRONT_TRUSTED_PRINCIPAL_ARN: 'arn:aws:iam::111111111111:role/prod-signer',
        },
      });
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.adobeAccount).to.equal('arn:aws:iam::111111111111:role/prod-signer');
      const [cmd] = s3SendStub.firstCall.args;
      expect(cmd.Bucket).to.equal('custom-bucket');
    });

    it('returns 400 when template hosting is not configured (no S3 client)', async () => {
      const result = await controller.getPermissions({ ...permissionsContext, s3: {} });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('not configured');
    });

    it('returns 400 when the trusted principal is not configured', async () => {
      const result = await controller.getPermissions({
        ...permissionsContext,
        env: { SPACECAT_CDN_CLOUDFRONT_TEMPLATE_BUCKET: 'llmo-edgeoptimize-cf-template' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('missing trusted principal');
    });

    it('returns 500 with a generic message when an unexpected error is thrown', async () => {
      mockDataAccess.Site.findById.rejects(new Error('db down'));
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('db down');
      expect(body.message).to.include('Failed to read edge optimize permissions');
    });

    it('returns 400 when the manifest read fails', async () => {
      s3SendStub.rejects(new Error('NoSuchKey'));
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('not available');
    });

    it('returns 400 when the template has no permissions metadata', async () => {
      s3SendStub.resolves({ Body: { transformToString: async () => 'Resources:\n  Foo:\n    Type: AWS::IAM::Role\n' } });
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('not available');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      const result = await deniedController.getPermissions(permissionsContext);
      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const LlmoControllerNoAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await LlmoControllerNoAdmin(mockContext)
        .getPermissions(permissionsContext);
      expect(result.status).to.equal(403);
    });
  });
});
