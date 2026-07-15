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
const TEST_IMS_ORG_ID = '9E1005A551ED61CA0A490D45@AdobeOrg';

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
  let mockOrganization;
  let mockConfig;
  let mockDataAccess;
  let mockLog;
  let mockTokowakaClient;
  let assumeConnectorRoleStub;
  let listDistributionsStub;
  let getDistributionConfigStub;
  let createOriginStub;
  let createCloudFrontFunctionStub;
  let updateCacheSettingsStub;
  let createLambdaAtEdgeStub;
  let getLambdaAtEdgeStatusStub;
  let applyAssociationsStub;
  let verifyRoutingStub;
  let runDeployStepStub;
  let planDeployStub;
  let createCdnLogDeliveryStub;
  let buildDeliveryDestinationArnStub;

  // The control-plane functions are imported from '@adobe/spacecat-shared-tokowaka-client';
  // the wrappers read the mutable outer stubs so each test can reassign them in beforeEach.
  const getEdgeOptimizeStubs = () => {
    function CloudFrontEdgeClient({ credentials, region } = {}) {
      this.credentials = credentials;
      this.region = region;
    }
    CloudFrontEdgeClient.prototype.listDistributions = function listDistributions() {
      return listDistributionsStub(this.credentials, this.region);
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
      return createOriginStub(
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
      return createCloudFrontFunctionStub(
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
      return updateCacheSettingsStub(
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
      return createLambdaAtEdgeStub(this.credentials, accountId, opts);
    };
    CloudFrontEdgeClient.prototype.getLambdaAtEdgeStatus = function getLambdaStatus(
      distributionId,
    ) {
      return getLambdaAtEdgeStatusStub(this.credentials, distributionId, this.region);
    };
    CloudFrontEdgeClient.prototype.applyAssociations = function applyAssociations(
      distributionId,
      pathPattern,
      lambdaVersionArn,
    ) {
      return applyAssociationsStub(
        this.credentials,
        distributionId,
        pathPattern,
        lambdaVersionArn,
        this.region,
      );
    };
    CloudFrontEdgeClient.prototype.runDeployStep = function runDeployStep(params) {
      return runDeployStepStub(this.credentials, params, this.region);
    };
    CloudFrontEdgeClient.prototype.planDeploy = function planDeploy(params) {
      return planDeployStub(this.credentials, params, this.region);
    };

    return {
      assumeConnectorRole: (...args) => assumeConnectorRoleStub(...args),
      listDistributions: (...args) => listDistributionsStub(...args),
      getDistributionConfig: (...args) => getDistributionConfigStub(...args),
      createOrigin: (...args) => createOriginStub(...args),
      createCloudFrontFunction: (...args) => createCloudFrontFunctionStub(...args),
      updateCacheSettings: (...args) => updateCacheSettingsStub(...args),
      createLambdaAtEdge: (...args) => createLambdaAtEdgeStub(...args),
      getLambdaAtEdgeStatus: (...args) => getLambdaAtEdgeStatusStub(...args),
      applyAssociations: (...args) => applyAssociationsStub(...args),
      verifyRouting: (...args) => verifyRoutingStub(...args),
      runDeployStep: (...args) => runDeployStepStub(...args),
      planDeploy: (...args) => planDeployStub(...args),
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
    '../../../src/support/cdn-log-delivery.js': {
      createCdnLogDelivery: (...args) => createCdnLogDeliveryStub(...args),
      buildDeliveryDestinationArn: (...args) => buildDeliveryDestinationArnStub(...args),
    },
    '../../../src/support/access-control-util.js': accessControlMock,
  });

  before(async function beforeAll() {
    this.timeout(120000);
    assumeConnectorRoleStub = sinon.stub();
    listDistributionsStub = sinon.stub();
    getDistributionConfigStub = sinon.stub();
    createOriginStub = sinon.stub();
    createCloudFrontFunctionStub = sinon.stub();
    updateCacheSettingsStub = sinon.stub();
    createLambdaAtEdgeStub = sinon.stub();
    getLambdaAtEdgeStatusStub = sinon.stub();
    applyAssociationsStub = sinon.stub();
    verifyRoutingStub = sinon.stub();
    runDeployStepStub = sinon.stub();
    planDeployStub = sinon.stub();
    createCdnLogDeliveryStub = sinon.stub();
    buildDeliveryDestinationArnStub = sinon.stub();
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
    listDistributionsStub = sinon.stub();
    getDistributionConfigStub = sinon.stub();
    createOriginStub = sinon.stub();
    createCloudFrontFunctionStub = sinon.stub();
    updateCacheSettingsStub = sinon.stub();
    createLambdaAtEdgeStub = sinon.stub();
    getLambdaAtEdgeStatusStub = sinon.stub();
    applyAssociationsStub = sinon.stub();
    verifyRoutingStub = sinon.stub();
    runDeployStepStub = sinon.stub();
    planDeployStub = sinon.stub();
    createCdnLogDeliveryStub = sinon.stub();
    buildDeliveryDestinationArnStub = sinon.stub()
      .returns('arn:aws:logs:us-east-1:111122223333:delivery-destination:cdn-logs-org');

    mockLog = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };
    mockConfig = { getEdgeOptimizeConfig: sinon.stub().returns({}) };
    mockOrganization = {
      getId: sinon.stub().returns('test-org-id'),
      getImsOrgId: sinon.stub().returns(TEST_IMS_ORG_ID),
    };
    mockSite = {
      getId: sinon.stub().returns(TEST_SITE_ID),
      getConfig: sinon.stub().returns(mockConfig),
      getBaseURL: sinon.stub().returns('https://www.example.com'),
      getOrganization: sinon.stub().resolves(mockOrganization),
      getOrganizationId: sinon.stub().returns('test-org-id'),
    };
    mockDataAccess = {
      Site: { findById: sinon.stub().resolves(mockSite) },
      Organization: { findById: sinon.stub().resolves(mockOrganization) },
    };
    mockTokowakaClient.fetchMetaconfig = sinon.stub();

    // Default: the chosen distribution (E2EXAMPLE123) serves the test site host (www.example.com),
    // so the controller's distribution↔site guardrail passes. Endpoint-specific tests override.
    listDistributionsStub.resolves([{
      id: 'E2EXAMPLE123',
      domainName: 'd111111abcdef8.cloudfront.net',
      aliases: ['www.example.com'],
      status: 'Deployed',
      enabled: true,
    }]);

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
      expect(body.externalId).to.equal(TEST_IMS_ORG_ID);
      // The org id is baked into the quick-create URL as the connector-role external id.
      // URLSearchParams encodes '@' as %40 — matches encodeURIComponent.
      const encodedOrgId = encodeURIComponent(TEST_IMS_ORG_ID);
      expect(body.quickCreateUrl).to.include(`param_ExternalId=${encodedOrgId}`);
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
      expect(body.message).to.include('Failed to generate the CloudFront bootstrap URL');
    });

    it('returns 400 when the site organization has no IMS org ID', async () => {
      mockOrganization.getImsOrgId.returns(undefined);

      const result = await controller.createBootstrapUrl(bootstrapContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('IMS org');
      expect(getSignedUrlStub.called).to.equal(false);
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
        data: { accountId: '120569600543' },
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
      // The external ID reaching STS is the server-derived org id, not a client-supplied value.
      expect(assumeConnectorRoleStub.firstCall.args[0].externalId).to.equal(TEST_IMS_ORG_ID);
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
      const result = await controller.connect({ ...connectContext, data: { accountId: '123' } });

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('12-digit');
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
      expect(body.message).to.include('Failed to connect the CloudFront connector role');
    });

    it('returns 400 when the site organization has no IMS org ID (gate)', async () => {
      // No org (null) exercises the resolveConnectorExternalId `org?.` nullish branch.
      mockSite.getOrganization.resolves(null);

      const result = await controller.connect(connectContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('IMS org');
      expect(assumeConnectorRoleStub.called).to.equal(false);
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
      listDistributionsStub = sinon.stub().resolves([
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
        data: { accountId: '120569600543' },
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
      expect(listDistributionsStub.calledOnce).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.listDistributions({ ...distributionsContext, data: { accountId: '123' } });

      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      listDistributionsStub = sinon.stub().rejects(new Error('ListDistributions failed'));

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
      listDistributionsStub = sinon.stub().resolves([]);
      prereqContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543' },
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
      expect(listDistributionsStub.calledOnce).to.equal(true);
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
      listDistributionsStub = sinon.stub().rejects(new Error('AccessDenied: cloudfront:ListDistributions'));

      const result = await controller.checkPrerequisites(prereqContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.checks[0]).to.deep.equal({ name: 'connectorRole', ok: true });
      expect(body.checks[1]).to.include({ name: 'cloudFrontRead', ok: false });
      expect(body.checks[1].detail).to.include('ListDistributions');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.checkPrerequisites({ ...prereqContext, data: { accountId: '123' } });

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
      expect(body.message).to.include('Failed to check CloudFront prerequisites');
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

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.fetchOrigins({ ...originsContext, data: { accountId: '120569600543' } });

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

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.fetchBehaviors({ ...behaviorsContext, data: { accountId: '120569600543' } });

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
      createOriginStub = sinon.stub().resolves({
        created: true, alreadyExisted: false, updated: false, originId: 'EdgeOptimize_Origin',
      });
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
      originContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(createOriginStub.calledOnceWith(
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

      expect(createOriginStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', 'live.edgeoptimize.net')).to.equal(true);
    });

    it('returns 400 when the site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });

      const result = await controller.createOrigin(originContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(createOriginStub.called).to.equal(false);
    });

    it('is idempotent when the origin already exists', async () => {
      createOriginStub = sinon.stub().resolves({
        created: false, alreadyExisted: true, updated: false, originId: 'EdgeOptimize_Origin',
      });

      const result = await controller.createOrigin(originContext);
      const body = await result.json();
      expect(body.alreadyExisted).to.equal(true);
    });

    it('reports a header patch on an existing header-less origin', async () => {
      createOriginStub = sinon.stub().resolves({
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

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.createOrigin({ ...originContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createOriginStub = sinon.stub().rejects(new Error('UpdateDistribution failed'));
      const result = await controller.createOrigin(originContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('UpdateDistribution failed');
      expect(body.message).to.include('Failed to create the Edge Optimize origin');
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
      createCloudFrontFunctionStub = sinon.stub().resolves({
        name: 'edgeoptimize-routing', created: true, stage: 'LIVE',
      });
      functionContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(createCloudFrontFunctionStub.calledOnceWith(sinon.match.any, 'origin-aem', 'E2EXAMPLE123', null)).to.equal(true);
    });

    it('reports an updated (not created) routing function', async () => {
      createCloudFrontFunctionStub = sinon.stub().resolves({
        name: 'edgeoptimize-routing', created: false, stage: 'LIVE',
      });
      const result = await controller.createRoutingFunction(functionContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.created).to.equal(false);
    });

    it('forwards a valid targetedPaths array to the function builder', async () => {
      const result = await controller.createRoutingFunction({
        ...functionContext,
        data: { ...functionContext.data, targetedPaths: ['/products', '/blog'] },
      });
      expect(result.status).to.equal(200);
      expect(createCloudFrontFunctionStub.calledOnce).to.equal(true);
      const [, originId, distId, paths] = createCloudFrontFunctionStub.firstCall.args;
      expect(originId).to.equal('origin-aem');
      expect(distId).to.equal('E2EXAMPLE123');
      expect(paths).to.deep.equal(['/products', '/blog']);
    });

    it('returns 400 when a targetedPaths entry is malformed', async () => {
      const result = await controller.createRoutingFunction({
        ...functionContext,
        data: { ...functionContext.data, targetedPaths: ['/ok', 'bad path; rm -rf'] },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('targetedPaths entry');
      expect(createCloudFrontFunctionStub.called).to.equal(false);
    });

    it('returns 400 when there are too many targetedPaths', async () => {
      const result = await controller.createRoutingFunction({
        ...functionContext,
        data: { ...functionContext.data, targetedPaths: Array.from({ length: 21 }, (_, i) => `/p${i}`) },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('at most 20');
      expect(createCloudFrontFunctionStub.called).to.equal(false);
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

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.createRoutingFunction({ ...functionContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createCloudFrontFunctionStub = sinon.stub().rejects(new Error('CreateFunction failed'));
      const result = await controller.createRoutingFunction(functionContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('CreateFunction failed');
      expect(body.message).to.include('Failed to create the CloudFront routing function');
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
      updateCacheSettingsStub = sinon.stub().resolves({
        policyId: 'cp-1', updated: true, alreadyForwarded: false,
      });
      cacheContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(updateCacheSettingsStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', '/api/*')).to.equal(true);
    });

    it('defaults the behavior to "default" when pathPattern is omitted', async () => {
      await controller.applyCache({
        ...cacheContext,
        data: { ...cacheContext.data, pathPattern: undefined },
      });
      expect(updateCacheSettingsStub.calledOnceWith(sinon.match.any, 'E2EXAMPLE123', 'default')).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.applyCache({ ...cacheContext, data: { ...cacheContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.applyCache({ ...cacheContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      updateCacheSettingsStub = sinon.stub().rejects(new Error('UpdateCachePolicy failed'));
      const result = await controller.applyCache(cacheContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('UpdateCachePolicy failed');
      expect(body.message).to.include('Failed to apply CloudFront cache headers');
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
      createLambdaAtEdgeStub = sinon.stub().resolves({
        functionArn: 'arn:fn',
        versionArn: 'arn:fn:1',
        version: '1',
        roleArn: 'arn:role',
        created: true,
      });
      lambdaContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' },
        env: {},
      };
    });

    it('creates the Lambda@Edge function and returns the versioned ARN', async () => {
      const result = await controller.createLambda(lambdaContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.versionArn).to.equal('arn:fn:1');
      expect(body.version).to.equal('1');
      expect(createLambdaAtEdgeStub.calledOnceWith(sinon.match.any, '120569600543')).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.createLambda({ ...lambdaContext, data: { accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distribution id is missing', async () => {
      const result = await controller.createLambda({
        ...lambdaContext,
        data: { accountId: '120569600543' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId is required');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      createLambdaAtEdgeStub = sinon.stub().rejects(new Error('CreateRole failed'));
      const result = await controller.createLambda(lambdaContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('CreateRole failed');
      expect(body.message).to.include('Failed to create the CloudFront Lambda@Edge function');
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
      getLambdaAtEdgeStatusStub = sinon.stub().resolves({
        exists: true, state: 'Active', lastUpdateStatus: 'Successful', versionArn: 'arn:fn:2', version: '2',
      });
      statusContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' },
        env: {},
      };
    });

    it('returns the Lambda@Edge status with the versioned ARN', async () => {
      const result = await controller.fetchLambdaStatus(statusContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.exists).to.equal(true);
      expect(body.versionArn).to.equal('arn:fn:2');
      expect(getLambdaAtEdgeStatusStub.calledOnce).to.equal(true);
    });

    it('returns exists:false when the function is absent', async () => {
      getLambdaAtEdgeStatusStub = sinon.stub().resolves({ exists: false, versionArn: null });
      const result = await controller.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.exists).to.equal(false);
      expect(body.versionArn).to.equal(null);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.fetchLambdaStatus({ ...statusContext, data: { accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distribution id is missing', async () => {
      const result = await controller.fetchLambdaStatus({
        ...statusContext,
        data: { accountId: '120569600543' },
      });
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('distributionId is required');
    });

    it('returns 500 with a generic message when the AWS call fails', async () => {
      getLambdaAtEdgeStatusStub = sinon.stub().rejects(new Error('ListVersions failed'));
      const result = await controller.fetchLambdaStatus(statusContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('ListVersions failed');
      expect(body.message).to.include('Failed to read the CloudFront Lambda@Edge status');
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
      applyAssociationsStub = sinon.stub().resolves({
        cloudFrontFunctionArn: 'arn:cf-fn',
        lambdaArn: 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1',
      });
      associateContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(applyAssociationsStub.calledOnceWith(
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
      applyAssociationsStub = sinon.stub().rejects(new Error('already has a different viewer-request function'));
      const result = await controller.applyAssociations(associateContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('viewer-request');
      expect(body.message).to.include('Failed to associate CloudFront routing');
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
      listDistributionsStub = sinon.stub().resolves([
        {
          id: 'E2EXAMPLE123', domainName: 'd111111abcdef8.cloudfront.net', aliases: [], status: 'Deployed', enabled: true, comment: '',
        },
      ]);
      verifyRoutingStub = sinon.stub().resolves({
        passed: true,
        requestId: 'req-123',
        details: { bot: { status: 200, headers: {} }, human: { status: 200, headers: {} } },
      });
      verifyContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(verifyRoutingStub.calledOnceWith('https://www.example.com/')).to.equal(true);
      expect(listDistributionsStub.called).to.equal(false);
    });

    it('uses an explicit domain when provided (no distribution lookup)', async () => {
      await controller.verifyRouting({ ...verifyContext, data: { ...verifyContext.data, domain: 'www.example.com' } });
      expect(listDistributionsStub.called).to.equal(false);
      expect(verifyRoutingStub.calledOnceWith('https://www.example.com/')).to.equal(true);
    });

    it('falls back to the distribution domain when the site host is unavailable', async () => {
      mockSite.getBaseURL.returns('');
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(200);
      expect(verifyRoutingStub.calledOnceWith('https://d111111abcdef8.cloudfront.net/')).to.equal(true);
      expect(listDistributionsStub.calledOnce).to.equal(true);
    });

    it('returns 400 when no domain can be resolved (no site host, no distribution)', async () => {
      mockSite.getBaseURL.returns('');
      listDistributionsStub = sinon.stub().resolves([]);
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('domain');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.verifyRouting({ ...verifyContext, data: { ...verifyContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
    });

    it('returns 400 when the distributionId is missing', async () => {
      const result = await controller.verifyRouting({ ...verifyContext, data: { accountId: '120569600543' } });
      expect(result.status).to.equal(400);
    });

    it('returns 500 with a generic message when the verify call fails', async () => {
      verifyRoutingStub = sinon.stub().rejects(new Error('fetch failed'));
      const result = await controller.verifyRouting(verifyContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('fetch failed');
      expect(body.message).to.include('Failed to verify CloudFront routing');
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

  describe('distribution↔site guardrail (granular endpoints) + validation', () => {
    const creds = {
      accountId: '120569600543',
      distributionId: 'E2EXAMPLE123',
    };
    const ctxWith = (data) => ({
      ...mockContext, params: { siteId: TEST_SITE_ID }, data, env: {},
    });
    const nonMatching = () => listDistributionsStub.resolves([{
      id: 'E2EXAMPLE123',
      domainName: 'd1.cloudfront.net',
      aliases: ['other.example.org'],
      status: 'Deployed',
      enabled: true,
    }]);

    beforeEach(() => {
      // These endpoints run gate → (resolveEoTarget) → assume role → guardrail; stub the role +
      // metaconfig so execution reaches the guardrail (the global beforeEach leaves them bare).
      assumeConnectorRoleStub.resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
    });

    it('createOrigin blocks when the distribution does not serve the site', async () => {
      nonMatching();
      const result = await controller.createOrigin(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      expect(createOriginStub.called).to.equal(false);
    });

    it('createRoutingFunction blocks when the distribution does not serve the site', async () => {
      nonMatching();
      const result = await controller.createRoutingFunction(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      expect(createCloudFrontFunctionStub.called).to.equal(false);
    });

    it('applyCache blocks when the distribution does not serve the site', async () => {
      nonMatching();
      const result = await controller.applyCache(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      expect(updateCacheSettingsStub.called).to.equal(false);
    });

    it('createLambda blocks when the distribution does not serve the site', async () => {
      nonMatching();
      const result = await controller.createLambda(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      expect(createLambdaAtEdgeStub.called).to.equal(false);
    });

    it('applyAssociations blocks when the distribution does not serve the site', async () => {
      nonMatching();
      const result = await controller.applyAssociations(ctxWith({
        ...creds,
        pathPattern: 'default',
        lambdaVersionArn: 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1',
      }));
      expect(result.status).to.equal(400);
      expect(applyAssociationsStub.called).to.equal(false);
    });

    it('rejects a malformed distributionId before doing any work', async () => {
      const result = await controller.createOrigin(ctxWith({ ...creds, distributionId: 'bad id!' }));
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('valid CloudFront distribution ID');
      expect(createOriginStub.called).to.equal(false);
    });

    it('blocks when the site base URL is unparseable (no host to match)', async () => {
      mockSite.getBaseURL.returns('not-a-url');
      nonMatching();
      const result = await controller.createOrigin(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      expect(createOriginStub.called).to.equal(false);
    });

    it('emits an audit line with the resolved caller and request id', async () => {
      createOriginStub = sinon.stub().resolves({ created: true, originId: 'EdgeOptimize_Origin' });
      const auditCtx = {
        ...ctxWith({ ...creds }),
        attributes: { authInfo: { getProfile: () => ({ email: 'operator@adobe.com' }) } },
        invocation: { id: 'req-abc-123' },
      };
      const result = await controller.createOrigin(auditCtx);
      expect(result.status).to.equal(200);
      const line = mockLog.info.getCalls().map((c) => c.args[0]).find((m) => typeof m === 'string' && m.includes('action=create-origin'));
      expect(line).to.include('caller=operator@adobe.com');
      expect(line).to.include('requestId=req-abc-123');
    });

    it('surfaces a categorized AWS error (AccessDenied) as 400, not a generic 500', async () => {
      createOriginStub = sinon.stub().rejects(Object.assign(new Error('not allowed'), { name: 'AccessDenied' }));
      const result = await controller.createOrigin(ctxWith({ ...creds }));
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('AccessDenied');
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
      runDeployStepStub = sinon.stub().resolves({
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
      expect(runDeployStepStub.calledOnce).to.equal(true);
      const [, params] = runDeployStepStub.firstCall.args;
      expect(params).to.include({
        distributionId: 'E2EXAMPLE123',
        originId: 'origin-aem',
        behavior: 'default',
        originDomain: 'live.edgeoptimize.net',
        accountId: '120569600543',
      });
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('blocks when the distribution CNAMEs do not include the site host', async () => {
      listDistributionsStub.resolves([{
        id: 'E2EXAMPLE123', domainName: 'd1.cloudfront.net', aliases: ['other.example.org'], status: 'Deployed', enabled: true,
      }]);
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('does not serve www.example.com');
      expect(runDeployStepStub.called).to.equal(false);
    });

    it('blocks when the distribution has no custom domain (CNAME) to validate', async () => {
      listDistributionsStub.resolves([{
        id: 'E2EXAMPLE123', domainName: 'd1.cloudfront.net', aliases: [], status: 'Deployed', enabled: true,
      }]);
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      expect(runDeployStepStub.called).to.equal(false);
    });

    it('proceeds despite a domain mismatch when allowDomainMismatch is set (logged override)', async () => {
      listDistributionsStub.resolves([{
        id: 'E2EXAMPLE123', domainName: 'd1.cloudfront.net', aliases: [], status: 'Deployed', enabled: true,
      }]);
      const result = await controller.deploy({
        ...deployContext,
        data: { ...deployContext.data, allowDomainMismatch: true },
      });
      expect(result.status).to.equal(200);
      expect(runDeployStepStub.calledOnce).to.equal(true);
    });

    it('blocks when the distribution is not found in the account', async () => {
      listDistributionsStub.resolves([]);
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('not found in this account');
      expect(runDeployStepStub.called).to.equal(false);
    });

    it('passes the env-driven origin domain when set', async () => {
      await controller.deploy({
        ...deployContext,
        env: { EDGE_OPTIMIZE_EDGE_DOMAIN: 'live.edgeoptimize.net' },
      });
      const [, params] = runDeployStepStub.firstCall.args;
      expect(params.originDomain).to.equal('live.edgeoptimize.net');
    });

    it('returns 400 when the site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(runDeployStepStub.called).to.equal(false);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.deploy({ ...deployContext, data: { ...deployContext.data, accountId: '123' } });
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
      runDeployStepStub = sinon.stub().rejects(new Error('assume failed'));
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('assume failed');
      expect(body.message).to.include('Failed to deploy CloudFront routing');
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

    it('resolves the onboarded site apiKey + forwardedHost for the EO origin headers', async () => {
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(200);
      const [, params] = runDeployStepStub.firstCall.args;
      // Uses the called site's baseURL host (www.example.com) + its metaconfig key.
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('returns 400 when the onboarded site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig = sinon.stub().resolves({ apiKeys: [] });
      const result = await controller.deploy(deployContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('No LLMO API key found for this site');
      expect(runDeployStepStub.called).to.equal(false);
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
      planDeployStub = sinon.stub().resolves(samplePlan);
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: ['eo-key-123'] });
      planContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
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
      expect(planDeployStub.calledOnce).to.equal(true);
      const [, params] = planDeployStub.firstCall.args;
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
      planDeployStub = sinon.stub().resolves({
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

    it('returns canProceed:false + blocker when the distribution does not serve the site', async () => {
      listDistributionsStub.resolves([{
        id: 'E2EXAMPLE123', domainName: 'd1.cloudfront.net', aliases: ['other.example.org'], status: 'Deployed', enabled: true,
      }]);
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.canProceed).to.equal(false);
      expect(body.blocker).to.include('does not serve www.example.com');
      expect(planDeployStub.called).to.equal(false);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.plan({ ...planContext, data: { ...planContext.data, accountId: '123' } });
      expect(result.status).to.equal(400);
      expect(planDeployStub.called).to.equal(false);
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

    it('returns 400 when the site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig.resolves({ apiKeys: [] });
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('API key');
      expect(planDeployStub.called).to.equal(false);
    });

    it('returns 500 with a generic message when the planner throws', async () => {
      planDeployStub = sinon.stub().rejects(new Error('plan failed'));
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('plan failed');
      expect(body.message).to.include('Failed to preview CloudFront routing');
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

    it('returns targetDomain (site host) and the resolved EO origin headers', async () => {
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.targetDomain).to.equal('www.example.com');
      const [, params] = planDeployStub.firstCall.args;
      expect(params.originHeaders).to.deep.equal({ apiKey: 'eo-key-123', forwardedHost: 'www.example.com' });
    });

    it('returns 400 when the onboarded site has no LLMO API key', async () => {
      mockTokowakaClient.fetchMetaconfig = sinon.stub().resolves({ apiKeys: [] });
      const result = await controller.plan(planContext);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('No LLMO API key found for this site');
      expect(planDeployStub.called).to.equal(false);
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
      expect(body.message).to.include('Failed to read the CloudFront connector permissions');
    });

    it('returns 500 when the manifest read fails (server-side S3 failure)', async () => {
      s3SendStub.rejects(new Error('NoSuchKey'));
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.not.include('NoSuchKey');
      expect(body.message).to.include('Failed to read the CloudFront connector permissions');
    });

    it('returns 500 when the template has no permissions metadata', async () => {
      s3SendStub.resolves({ Body: { transformToString: async () => 'Resources:\n  Foo:\n    Type: AWS::IAM::Role\n' } });
      const result = await controller.getPermissions(permissionsContext);
      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.include('Failed to read the CloudFront connector permissions');
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

  describe('enableCdnLogDelivery', () => {
    let logDeliveryContext;

    beforeEach(() => {
      assumeConnectorRoleStub.resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      // assertDistributionServesSite calls listDistributions; return a distribution whose aliases
      // match the mock site's base URL (https://www.example.com → www.example.com).
      listDistributionsStub.resolves([
        { id: 'E2EXAMPLE123', aliases: ['www.example.com'] },
      ]);
      createCdnLogDeliveryStub.resolves({
        created: true,
        alreadyExisted: false,
        deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123',
        deliveryId: 'del-1',
      });
      logDeliveryContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
          distributionId: 'E2EXAMPLE123',
        },
        env: { CDN_LOG_DELIVERY_DEST_ACCOUNT_ID: '111122223333' },
      };
    });

    it('enables log forwarding and returns the delivery result', async () => {
      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.created).to.equal(true);
      expect(body.deliveryId).to.equal('del-1');
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      const callArgs = createCdnLogDeliveryStub.firstCall.args[1];
      expect(callArgs.provider).to.equal('cloudfront');
      expect(callArgs.resourceId).to.equal('E2EXAMPLE123');
    });

    it('is a no-op when forwarding is already enabled', async () => {
      createCdnLogDeliveryStub.resolves({
        created: false,
        alreadyExisted: true,
        deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE123',
        deliveryId: 'del-existing',
      });

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.alreadyExisted).to.equal(true);
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.enableCdnLogDelivery({
        ...logDeliveryContext,
        data: { ...logDeliveryContext.data, accountId: '123' },
      });

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('12-digit');
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.enableCdnLogDelivery({
        ...logDeliveryContext,
        data: { accountId: '120569600543', distributionId: 'E2EXAMPLE123' },
      });

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('externalId');
    });

    it('returns 400 when the distribution id is missing', async () => {
      const result = await controller.enableCdnLogDelivery({
        ...logDeliveryContext,
        data: { accountId: '120569600543', externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5' },
      });

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('distributionId');
    });

    it('returns 500 when the destination account is not configured (server misconfig)', async () => {
      const result = await controller.enableCdnLogDelivery({ ...logDeliveryContext, env: {} });

      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.include('not configured');
    });

    it('returns 400 when the site organization has no IMS org id', async () => {
      mockDataAccess.Organization.findById.resolves({ getImsOrgId: () => undefined });

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('IMS org');
    });

    it('returns a clear error when the Adobe destination is not provisioned', async () => {
      const notFoundErr = new Error('ResourceNotFoundException: delivery destination not found');
      notFoundErr.name = 'ResourceNotFoundException';
      createCdnLogDeliveryStub.rejects(notFoundErr);

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('not provisioned');
    });

    it('returns 400 when createCdnLogDelivery throws a categorized AWS error', async () => {
      const err = new Error('not authorized');
      err.name = 'AccessDeniedException';
      createCdnLogDeliveryStub.rejects(err);

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(400);
      // Only the error name should appear — not the raw message, which may contain ARNs.
      expect((await result.json()).message).to.equal('AccessDeniedException');
    });

    it('returns 500 when createCdnLogDelivery throws an uncategorized error', async () => {
      createCdnLogDeliveryStub.rejects(new Error('Something went wrong internally'));

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.equal('An unexpected error occurred');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const result = await controllerWithAccessDenied(mockContext)
        .enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(403);
    });

    it('returns 403 when the user is not an LLMO administrator', async () => {
      const noAdmin = await esmock('../../../src/controllers/llmo/llmo-cloudfront.js', cfClientMocks(createMockAccessControlUtil(true, true, false)));
      const result = await noAdmin(mockContext).enableCdnLogDelivery(logDeliveryContext);

      expect(result.status).to.equal(403);
    });
  });

  describe('rescanCdnLogDelivery', () => {
    let rescanContext;

    beforeEach(() => {
      assumeConnectorRoleStub.resolves({
        roleArn: 'arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole',
        accountId: '120569600543',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' },
      });
      listDistributionsStub.resolves([{ id: 'E2EXAMPLE001' }, { id: 'E2EXAMPLE002' }]);
      createCdnLogDeliveryStub.resolves({
        created: true,
        alreadyExisted: false,
        deliverySourceName: 'llmo-cf-abc123-E2EXAMPLE001',
        deliveryId: 'del-1',
      });
      rescanContext = {
        ...mockContext,
        params: { siteId: TEST_SITE_ID },
        data: {
          accountId: '120569600543',
          externalId: '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5',
        },
        env: { CDN_LOG_DELIVERY_DEST_ACCOUNT_ID: '111122223333' },
      };
    });

    it('scans all distributions and returns a summary', async () => {
      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.scanned).to.equal(2);
      expect(body.created).to.equal(2);
      expect(body.alreadyExisted).to.equal(0);
      expect(body.failed).to.equal(0);
      expect(body.distributions).to.have.length(2);
      expect(assumeConnectorRoleStub.calledOnce).to.equal(true);
      expect(listDistributionsStub.calledOnce).to.equal(true);
      expect(createCdnLogDeliveryStub.callCount).to.equal(2);
    });

    it('processes more distributions than the concurrency cap in order', async () => {
      // 7 > CDN_LOG_RESCAN_CONCURRENCY (5) → exercises the multi-batch loop; order is preserved.
      const ids = Array.from({ length: 7 }, (_, i) => `E2DIST${String(i).padStart(6, '0')}`);
      listDistributionsStub.resolves(ids.map((id) => ({ id })));
      createCdnLogDeliveryStub.resolves({ created: true, alreadyExisted: false });

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.scanned).to.equal(7);
      expect(body.created).to.equal(7);
      expect(createCdnLogDeliveryStub.callCount).to.equal(7);
      expect(body.distributions.map((d) => d.distributionId)).to.deep.equal(ids);
    });

    it('reports alreadyExisted when delivery already set up', async () => {
      createCdnLogDeliveryStub.resolves({ created: false, alreadyExisted: true, deliveryId: 'del-x' });

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.created).to.equal(0);
      expect(body.alreadyExisted).to.equal(2);
    });

    it('records failures per distribution (error category only) without aborting', async () => {
      createCdnLogDeliveryStub.onFirstCall().resolves({ created: true, alreadyExisted: false });
      // A real AWS error carries the category in .name; the raw .message (with ARNs) is NOT leaked.
      createCdnLogDeliveryStub.onSecondCall().rejects(
        Object.assign(new Error('not authorized for arn:aws:logs:...'), { name: 'AccessDeniedException' }),
      );

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.scanned).to.equal(2);
      expect(body.created).to.equal(1);
      expect(body.failed).to.equal(1);
      expect(body.distributions[1].error).to.equal('AccessDeniedException');
    });

    it('uses a custom role name when EDGE_OPTIMIZE_ROLE_NAME is set', async () => {
      const ctx = {
        ...rescanContext,
        env: { ...rescanContext.env, EDGE_OPTIMIZE_ROLE_NAME: 'CustomConnectorRole' },
      };

      const result = await controller.rescanCdnLogDelivery(ctx);

      expect(result.status).to.equal(200);
      const callArgs = assumeConnectorRoleStub.firstCall.args[0];
      expect(callArgs.roleName).to.equal('CustomConnectorRole');
    });

    it('falls back to "unknown error" when a rejection has no error name', async () => {
      createCdnLogDeliveryStub.onFirstCall().resolves({ created: true, alreadyExisted: false });
      // An error with an empty name exercises the `|| 'unknown error'` fallback. (Note: sinon's
      // .rejects('str') would set .name to that string, so we build the rejection explicitly.)
      createCdnLogDeliveryStub.onSecondCall().rejects(Object.assign(new Error('boom'), { name: '' }));

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.distributions[1].error).to.equal('unknown error');
    });

    it('returns 400 for an invalid account id', async () => {
      const result = await controller.rescanCdnLogDelivery({
        ...rescanContext,
        data: { ...rescanContext.data, accountId: '123' },
      });

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('12-digit');
    });

    it('returns 400 when the external id is missing', async () => {
      const result = await controller.rescanCdnLogDelivery({
        ...rescanContext,
        data: { accountId: '120569600543' },
      });

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('externalId');
    });

    it('returns 500 when the destination account is not configured (server misconfig)', async () => {
      const result = await controller.rescanCdnLogDelivery({ ...rescanContext, env: {} });

      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.include('not configured');
    });

    it('returns 400 when the site organization has no IMS org id', async () => {
      mockDataAccess.Organization.findById.resolves({ getImsOrgId: () => undefined });

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.include('IMS org');
    });

    it('returns 404 when the site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when the user lacks access to the site', async () => {
      const result = await controllerWithAccessDenied(mockContext)
        .rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(403);
    });

    it('returns 500 when an unexpected error is thrown', async () => {
      listDistributionsStub.rejects(new Error('NetworkError'));

      const result = await controller.rescanCdnLogDelivery(rescanContext);

      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.equal('An unexpected error occurred');
    });
  });
});
