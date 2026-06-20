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

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('edge-optimize support', () => {
  let stsSendStub;
  let cfSendStub;
  let iamSendStub;
  let lambdaSendStub;
  let edgeOptimize;

  beforeEach(async function setup() {
    this.timeout(30000);
    stsSendStub = sinon.stub();
    cfSendStub = sinon.stub();
    iamSendStub = sinon.stub();
    lambdaSendStub = sinon.stub();
    // Each command in a mocked module is a constructor FUNCTION (not a class) — eslint forbids
    // multiple class declarations in one file, so we capture the command name + input on `this`.
    const cfCommand = (Name) => function CloudFrontCommand(input) {
      this.input = input;
      this.commandName = Name;
    };
    const iamCommand = (Name) => function IamCommand(input) {
      this.input = input;
      this.commandName = Name;
    };
    const lambdaCommand = (Name) => function LambdaCommand(input) {
      this.input = input;
      this.commandName = Name;
    };
    edgeOptimize = await esmock('../../src/support/edge-optimize.js', {
      '@aws-sdk/client-sts': {
        STSClient: function STSClient() {
          this.send = (cmd) => stsSendStub(cmd);
        },
        AssumeRoleCommand: function AssumeRoleCommand(input) {
          this.input = input;
        },
      },
      '@aws-sdk/client-cloudfront': {
        CloudFrontClient: function CloudFrontClient(config) {
          this.config = config;
          this.send = (cmd) => cfSendStub(cmd);
        },
        ListDistributionsCommand: cfCommand('ListDistributions'),
        GetDistributionConfigCommand: cfCommand('GetDistributionConfig'),
        GetCachePolicyConfigCommand: cfCommand('GetCachePolicyConfig'),
        UpdateCachePolicyCommand: cfCommand('UpdateCachePolicy'),
        CreateFunctionCommand: cfCommand('CreateFunction'),
        UpdateFunctionCommand: cfCommand('UpdateFunction'),
        DescribeFunctionCommand: cfCommand('DescribeFunction'),
        PublishFunctionCommand: cfCommand('PublishFunction'),
        UpdateDistributionCommand: cfCommand('UpdateDistribution'),
      },
      '@aws-sdk/client-iam': {
        IAMClient: function IAMClient(config) {
          this.config = config;
          this.send = (cmd) => iamSendStub(cmd);
        },
        CreateRoleCommand: iamCommand('CreateRole'),
        GetRoleCommand: iamCommand('GetRole'),
        PutRolePolicyCommand: iamCommand('PutRolePolicy'),
        UpdateAssumeRolePolicyCommand: iamCommand('UpdateAssumeRolePolicy'),
      },
      '@aws-sdk/client-lambda': {
        LambdaClient: function LambdaClient(config) {
          this.config = config;
          this.send = (cmd) => lambdaSendStub(cmd);
        },
        CreateFunctionCommand: lambdaCommand('CreateFunction'),
        UpdateFunctionCodeCommand: lambdaCommand('UpdateFunctionCode'),
        GetFunctionCommand: lambdaCommand('GetFunction'),
        GetFunctionConfigurationCommand: lambdaCommand('GetFunctionConfiguration'),
        PublishVersionCommand: lambdaCommand('PublishVersion'),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('assumeConnectorRole', () => {
    it('assumes the role and returns mapped credentials', async () => {
      stsSendStub.resolves({
        Credentials: {
          AccessKeyId: 'AKIA',
          SecretAccessKey: 'secret',
          SessionToken: 'token',
          Expiration: new Date('2030-01-01T00:00:00Z'),
        },
      });

      const result = await edgeOptimize.assumeConnectorRole({
        accountId: '120569600543',
        externalId: 'ext-123',
      });

      expect(result.roleArn).to.equal('arn:aws:iam::120569600543:role/AdobeLLMOptimizerCloudFrontConnectorRole');
      expect(result.accountId).to.equal('120569600543');
      expect(result.credentials.accessKeyId).to.equal('AKIA');
      expect(result.credentials.secretAccessKey).to.equal('secret');
      expect(result.credentials.sessionToken).to.equal('token');
      expect(stsSendStub.calledOnce).to.equal(true);
    });

    it('uses a custom role name when provided', async () => {
      stsSendStub.resolves({
        Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S', SessionToken: 'T' },
      });

      const result = await edgeOptimize.assumeConnectorRole({
        accountId: '120569600543',
        externalId: 'ext',
        roleName: 'CustomRole',
      });

      expect(result.roleArn).to.equal('arn:aws:iam::120569600543:role/CustomRole');
    });

    it('throws for an invalid account id', async () => {
      let error;
      try {
        await edgeOptimize.assumeConnectorRole({ accountId: '123', externalId: 'ext' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
      expect(error.message).to.include('12-digit');
      expect(stsSendStub.called).to.equal(false);
    });

    it('throws when the external id is missing', async () => {
      let error;
      try {
        await edgeOptimize.assumeConnectorRole({ accountId: '120569600543', externalId: '' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
      expect(error.message).to.include('externalId');
    });

    it('throws when STS returns no credentials', async () => {
      stsSendStub.resolves({});
      let error;
      try {
        await edgeOptimize.assumeConnectorRole({ accountId: '120569600543', externalId: 'ext' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
      expect(error.message).to.include('no credentials');
    });
  });

  describe('listCloudFrontDistributions', () => {
    it('maps the distribution list to the wizard projection', async () => {
      cfSendStub.resolves({
        DistributionList: {
          Items: [
            {
              Id: 'E123',
              DomainName: 'd.cloudfront.net',
              Aliases: { Items: ['www.example.com'] },
              Status: 'Deployed',
              Enabled: true,
              Comment: 'prod',
            },
          ],
        },
      });

      const result = await edgeOptimize.listCloudFrontDistributions({
        accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T',
      });

      expect(result).to.have.length(1);
      expect(result[0]).to.deep.equal({
        id: 'E123',
        domainName: 'd.cloudfront.net',
        aliases: ['www.example.com'],
        status: 'Deployed',
        enabled: true,
        comment: 'prod',
      });
    });

    it('returns an empty array when there are no distributions', async () => {
      cfSendStub.resolves({ DistributionList: {} });

      const result = await edgeOptimize.listCloudFrontDistributions({});

      expect(result).to.deep.equal([]);
    });

    it('defaults aliases and comment when absent and reflects disabled state', async () => {
      cfSendStub.resolves({
        DistributionList: {
          Items: [{
            Id: 'E2', DomainName: 'd2.cloudfront.net', Status: 'InProgress', Enabled: false,
          }],
        },
      });

      const result = await edgeOptimize.listCloudFrontDistributions({});

      expect(result[0].aliases).to.deep.equal([]);
      expect(result[0].comment).to.equal('');
      expect(result[0].enabled).to.equal(false);
    });
  });

  describe('getDistributionConfig', () => {
    it('maps origins, default cache behavior, and ordered cache behaviors', async () => {
      cfSendStub.resolves({
        DistributionConfig: {
          Origins: {
            Items: [
              { Id: 'origin-aem', DomainName: 'origin.example.com', OriginPath: '/content' },
              { Id: 'EdgeOptimizeOrigin', DomainName: 'live.edgeoptimize.net' },
            ],
          },
          DefaultCacheBehavior: { TargetOriginId: 'origin-aem' },
          CacheBehaviors: {
            Items: [
              { PathPattern: '/api/*', TargetOriginId: 'origin-aem' },
            ],
          },
        },
      });

      const result = await edgeOptimize.getDistributionConfig({}, 'E2EXAMPLE');

      expect(cfSendStub.calledOnce).to.equal(true);
      expect(cfSendStub.firstCall.args[0].input).to.deep.equal({ Id: 'E2EXAMPLE' });
      expect(result.origins).to.deep.equal([
        { id: 'origin-aem', domainName: 'origin.example.com', originPath: '/content' },
        { id: 'EdgeOptimizeOrigin', domainName: 'live.edgeoptimize.net', originPath: '' },
      ]);
      expect(result.defaultCacheBehavior).to.deep.equal({
        pathPattern: 'Default (*)',
        targetOriginId: 'origin-aem',
      });
      expect(result.cacheBehaviors).to.deep.equal([
        { pathPattern: '/api/*', targetOriginId: 'origin-aem' },
      ]);
    });

    it('defaults to empty collections when the config is sparse', async () => {
      cfSendStub.resolves({ DistributionConfig: {} });

      const result = await edgeOptimize.getDistributionConfig({}, 'E2EXAMPLE');

      expect(result.origins).to.deep.equal([]);
      expect(result.defaultCacheBehavior).to.equal(null);
      expect(result.cacheBehaviors).to.deep.equal([]);
    });

    it('throws when the distribution id is missing', async () => {
      let error;
      try {
        await edgeOptimize.getDistributionConfig({}, '');
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
      expect(error.message).to.include('distributionId');
      expect(cfSendStub.called).to.equal(false);
    });
  });

  describe('createEdgeOptimizeOrigin', () => {
    it('adds the Edge Optimize origin when it does not exist', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: 'origin-aem', DomainName: 'origin.example.com' }] } },
        ETag: 'etag-1',
      });
      cfSendStub.onSecondCall().resolves({});

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE', 'dev.edgeoptimize.net');

      expect(result).to.deep.equal({ created: true, alreadyExisted: false, originId: 'EdgeOptimize_Origin' });
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('UpdateDistribution');
      const update = cfSendStub.secondCall.args[0].input;
      expect(update.IfMatch).to.equal('etag-1');
      const added = update.DistributionConfig.Origins.Items.find((o) => o.Id === 'EdgeOptimize_Origin');
      expect(added.DomainName).to.equal('dev.edgeoptimize.net');
      expect(added.CustomOriginConfig.OriginProtocolPolicy).to.equal('https-only');
    });

    it('is idempotent when the origin already exists by id', async () => {
      cfSendStub.resolves({
        DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: 'EdgeOptimize_Origin', DomainName: 'x' }] } },
        ETag: 'etag-1',
      });

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE');

      expect(result).to.deep.equal({ created: false, alreadyExisted: true, originId: 'EdgeOptimize_Origin' });
      expect(cfSendStub.calledOnce).to.equal(true); // never updated
    });

    it('is idempotent when an origin already uses the EO domain', async () => {
      cfSendStub.resolves({
        DistributionConfig: { Origins: { Items: [{ Id: 'custom', DomainName: 'dev.edgeoptimize.net' }] } },
        ETag: 'etag-1',
      });

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE', 'dev.edgeoptimize.net');

      expect(result.alreadyExisted).to.equal(true);
      expect(cfSendStub.calledOnce).to.equal(true);
    });

    it('throws when the distribution id is missing', async () => {
      let error;
      try {
        await edgeOptimize.createEdgeOptimizeOrigin({}, '');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('distributionId');
      expect(cfSendStub.called).to.equal(false);
    });
  });

  describe('buildRoutingFunctionCode', () => {
    it('embeds the default origin id and null targeted paths', () => {
      const code = edgeOptimize.buildRoutingFunctionCode('origin-aem');
      expect(code).to.include('{ "originId": "origin-aem" }');
      expect(code).to.include('var TARGETED_PATHS = null;');
      expect(code).to.include("import cf from 'cloudfront';");
    });

    it('embeds explicit targeted paths as JSON', () => {
      const code = edgeOptimize.buildRoutingFunctionCode('origin-aem', ['/a', '/b']);
      expect(code).to.include('var TARGETED_PATHS = ["/a","/b"];');
    });
  });

  describe('createEdgeOptimizeRoutingFunction', () => {
    it('creates and publishes a new function when none exists', async () => {
      cfSendStub.onFirstCall().rejects(Object.assign(new Error('not found'), { name: 'NoSuchFunctionExists' }));
      cfSendStub.onSecondCall().resolves({ ETag: 'fn-etag' }); // CreateFunction
      cfSendStub.onThirdCall().resolves({}); // PublishFunction

      const result = await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem');

      expect(result).to.deep.equal({ name: 'edgeoptimize-routing', created: true, stage: 'LIVE' });
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('CreateFunction');
      expect(cfSendStub.thirdCall.args[0].commandName).to.equal('PublishFunction');
      expect(cfSendStub.thirdCall.args[0].input.IfMatch).to.equal('fn-etag');
    });

    it('updates and publishes when the function already exists', async () => {
      cfSendStub.onFirstCall().resolves({ ETag: 'dev-etag' }); // DescribeFunction DEVELOPMENT
      cfSendStub.onSecondCall().resolves({ ETag: 'updated-etag' }); // UpdateFunction
      cfSendStub.onThirdCall().resolves({}); // PublishFunction

      const result = await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem');

      expect(result.created).to.equal(false);
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('UpdateFunction');
      expect(cfSendStub.thirdCall.args[0].input.IfMatch).to.equal('updated-etag');
    });

    it('throws when defaultOriginId is missing', async () => {
      let error;
      try {
        await edgeOptimize.createEdgeOptimizeRoutingFunction({}, '');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('defaultOriginId');
      expect(cfSendStub.called).to.equal(false);
    });

    it('rethrows unexpected describe errors', async () => {
      cfSendStub.onFirstCall().rejects(new Error('boom'));
      let error;
      try {
        await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.equal('boom');
    });
  });

  describe('applyEdgeOptimizeCacheHeaders', () => {
    it('adds the EO headers to the behavior cache policy whitelist', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'cp-1' } },
      });
      cfSendStub.onSecondCall().resolves({
        CachePolicyConfig: {
          Name: 'my-policy',
          MinTTL: 60,
          ParametersInCacheKeyAndForwardedToOrigin: {
            HeadersConfig: { HeaderBehavior: 'whitelist', Headers: { Quantity: 1, Items: ['accept'] } },
          },
        },
        ETag: 'cp-etag',
      });
      cfSendStub.onThirdCall().resolves({});

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result.policyId).to.equal('cp-1');
      expect(result.updated).to.equal(true);
      expect(cfSendStub.thirdCall.args[0].commandName).to.equal('UpdateCachePolicy');
      const updated = cfSendStub.thirdCall.args[0].input.CachePolicyConfig;
      expect(updated.MinTTL).to.equal(0);
      const items = updated.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.Items;
      expect(items).to.include('x-edgeoptimize-config');
      expect(items).to.include('x-edgeoptimize-url');
    });

    it('is a no-op when headers are already forwarded and MinTTL is 0', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'cp-1' } },
      });
      cfSendStub.onSecondCall().resolves({
        CachePolicyConfig: {
          Name: 'my-policy',
          MinTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: {
            HeadersConfig: {
              HeaderBehavior: 'whitelist',
              Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
            },
          },
        },
        ETag: 'cp-etag',
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result).to.deep.equal({ policyId: 'cp-1', updated: false, alreadyForwarded: true });
      expect(cfSendStub.calledTwice).to.equal(true); // never updated
    });

    it('treats an allViewer header policy as already forwarded', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'cp-1' } },
      });
      cfSendStub.onSecondCall().resolves({
        CachePolicyConfig: {
          Name: 'p',
          MinTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'allViewer' } },
        },
        ETag: 'cp-etag',
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');
      expect(result.updated).to.equal(false);
      expect(result.alreadyForwarded).to.equal(true);
    });

    it('throws when the behavior has no cache policy (legacy/managed)', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { DefaultCacheBehavior: { ForwardedValues: {} } },
      });
      let error;
      try {
        await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('custom cache policy');
    });

    it('targets a named (non-default) behavior', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: {
          DefaultCacheBehavior: { CachePolicyId: 'cp-default' },
          CacheBehaviors: { Items: [{ PathPattern: '/api/*', CachePolicyId: 'cp-api' }] },
        },
      });
      cfSendStub.onSecondCall().resolves({
        CachePolicyConfig: {
          Name: 'api',
          MinTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'none' } },
        },
        ETag: 'cp-etag',
      });
      cfSendStub.onThirdCall().resolves({});

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', '/api/*');
      expect(result.policyId).to.equal('cp-api');
      expect(cfSendStub.secondCall.args[0].input.Id).to.equal('cp-api');
    });

    it('throws when pathPattern is missing', async () => {
      let error;
      try {
        await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', '');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('pathPattern');
    });
  });

  describe('buildLambdaZip', () => {
    it('produces a zip buffer with the local-file-header signature', () => {
      const zip = edgeOptimize.buildLambdaZip('index.mjs', 'console.log(1)');
      expect(Buffer.isBuffer(zip)).to.equal(true);
      expect(zip.readUInt32LE(0)).to.equal(0x04034b50);
    });
  });

  describe('createEdgeOptimizeLambda', () => {
    const creds = { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' };

    it('creates the role, function and publishes a version', async () => {
      iamSendStub.onFirstCall().rejects(Object.assign(new Error('no role'), { name: 'NoSuchEntityException' }));
      iamSendStub.onSecondCall().resolves({ Role: { Arn: 'arn:aws:iam::120569600543:role/edgeoptimize-origin-role' } }); // CreateRole
      iamSendStub.onThirdCall().resolves({}); // PutRolePolicy

      // Lambda flow: GetFunction (not found) -> CreateFunction -> GetFunctionConfiguration(Active)
      // -> PublishVersion
      lambdaSendStub.onCall(0).rejects(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
      lambdaSendStub.onCall(1).resolves({ FunctionArn: 'arn:fn' });
      lambdaSendStub.onCall(2).resolves({ State: 'Active' });
      lambdaSendStub.onCall(3).resolves({ FunctionArn: 'arn:fn:1', Version: '1' });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { roleWaitMs: 0 });

      expect(result).to.include({
        functionArn: 'arn:fn',
        versionArn: 'arn:fn:1',
        version: '1',
        created: true,
      });
      expect(result.roleArn).to.include('edgeoptimize-origin-role');
      expect(iamSendStub.secondCall.args[0].commandName).to.equal('CreateRole');
      expect(lambdaSendStub.getCall(1).args[0].commandName).to.equal('CreateFunction');
      expect(lambdaSendStub.getCall(1).args[0].input.Role).to.include('edgeoptimize-origin-role');
      expect(lambdaSendStub.getCall(3).args[0].commandName).to.equal('PublishVersion');
    });

    it('updates the function code when it already exists', async () => {
      iamSendStub.onFirstCall().resolves({ Role: { Arn: 'arn:role' } }); // GetRole
      iamSendStub.onSecondCall().resolves({}); // UpdateAssumeRolePolicy
      iamSendStub.onThirdCall().resolves({}); // PutRolePolicy

      lambdaSendStub.onCall(0).resolves({}); // GetFunction (exists)
      lambdaSendStub.onCall(1).resolves({ FunctionArn: 'arn:fn' }); // UpdateFunctionCode
      lambdaSendStub.onCall(2).resolves({ State: 'Active' });
      lambdaSendStub.onCall(3).resolves({ FunctionArn: 'arn:fn:2', Version: '2' });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543');

      expect(result.created).to.equal(false);
      expect(result.version).to.equal('2');
      expect(lambdaSendStub.getCall(1).args[0].commandName).to.equal('UpdateFunctionCode');
    });

    it('retries CreateFunction on role-propagation errors then succeeds', async () => {
      iamSendStub.onFirstCall().rejects(Object.assign(new Error('no role'), { name: 'NoSuchEntityException' }));
      iamSendStub.onSecondCall().resolves({ Role: { Arn: 'arn:role' } });
      iamSendStub.onThirdCall().resolves({});

      const roleErr = Object.assign(
        new Error('The role defined for the function cannot be assumed by Lambda'),
        { name: 'InvalidParameterValueException' },
      );
      lambdaSendStub.onCall(0).rejects(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
      lambdaSendStub.onCall(1).rejects(roleErr); // first CreateFunction attempt
      lambdaSendStub.onCall(2).resolves({ FunctionArn: 'arn:fn' }); // retry succeeds
      lambdaSendStub.onCall(3).resolves({ State: 'Active' });
      lambdaSendStub.onCall(4).resolves({ FunctionArn: 'arn:fn:1', Version: '1' });

      const result = await edgeOptimize.createEdgeOptimizeLambda(
        creds,
        '120569600543',
        { roleWaitMs: 0, retryDelayMs: 0 },
      );

      expect(result.version).to.equal('1');
      expect(lambdaSendStub.getCall(1).args[0].commandName).to.equal('CreateFunction');
      expect(lambdaSendStub.getCall(2).args[0].commandName).to.equal('CreateFunction');
    });

    it('throws for an invalid account id', async () => {
      let error;
      try {
        await edgeOptimize.createEdgeOptimizeLambda(creds, '123');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('12-digit');
      expect(iamSendStub.called).to.equal(false);
    });
  });

  describe('applyEdgeOptimizeAssociations', () => {
    const lambdaArn = 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1';

    it('wires the CF function (viewer-request) and Lambda (origin req/res) onto the behavior', async () => {
      cfSendStub.onFirstCall().resolves({
        FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } },
      });
      cfSendStub.onSecondCall().resolves({
        DistributionConfig: { DefaultCacheBehavior: {} },
        ETag: 'dist-etag',
      });
      cfSendStub.onThirdCall().resolves({});

      const result = await edgeOptimize.applyEdgeOptimizeAssociations({}, 'E2EXAMPLE', 'default', lambdaArn);

      expect(result).to.deep.equal({ cfFunctionArn: 'arn:cf-fn', lambdaArn });
      const update = cfSendStub.thirdCall.args[0];
      expect(update.commandName).to.equal('UpdateDistribution');
      const behavior = update.input.DistributionConfig.DefaultCacheBehavior;
      expect(behavior.FunctionAssociations.Items[0]).to.deep.equal({ FunctionARN: 'arn:cf-fn', EventType: 'viewer-request' });
      expect(behavior.LambdaFunctionAssociations.Quantity).to.equal(2);
      expect(behavior.LambdaFunctionAssociations.Items.map((i) => i.EventType)).to.deep.equal(['origin-request', 'origin-response']);
    });

    it('throws when the CF function is not published to LIVE', async () => {
      cfSendStub.onFirstCall().resolves({ FunctionSummary: {} });
      let error;
      try {
        await edgeOptimize.applyEdgeOptimizeAssociations({}, 'E2EXAMPLE', 'default', lambdaArn);
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('not found or not published');
    });

    it('surfaces a conflicting viewer-request association', async () => {
      cfSendStub.onFirstCall().resolves({
        FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } },
      });
      cfSendStub.onSecondCall().resolves({
        DistributionConfig: {
          DefaultCacheBehavior: {
            FunctionAssociations: { Items: [{ EventType: 'viewer-request', FunctionARN: 'arn:other-fn' }] },
          },
        },
        ETag: 'dist-etag',
      });
      let error;
      try {
        await edgeOptimize.applyEdgeOptimizeAssociations({}, 'E2EXAMPLE', 'default', lambdaArn);
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('already has a different viewer-request function');
    });

    it('throws when lambdaVersionArn is missing', async () => {
      let error;
      try {
        await edgeOptimize.applyEdgeOptimizeAssociations({}, 'E2EXAMPLE', 'default', '');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('lambdaVersionArn');
      expect(cfSendStub.called).to.equal(false);
    });
  });

  describe('verifyEdgeOptimizeRouting', () => {
    let fetchStub;

    const makeResponse = (status, headerMap) => ({
      status,
      headers: { forEach: (cb) => Object.entries(headerMap).forEach(([k, v]) => cb(v, k)) },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    afterEach(() => {
      if (fetchStub) {
        fetchStub.restore();
      }
      fetchStub = undefined;
    });

    it('passes when the bot response carries x-edgeoptimize-request-id and the human does not', async () => {
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeResponse(200, { 'x-edgeoptimize-request-id': 'req-123' }));
      fetchStub.onSecondCall().resolves(makeResponse(200, {}));

      const result = await edgeOptimize.verifyEdgeOptimizeRouting('https://d.cloudfront.net/');

      expect(result.passed).to.equal(true);
      expect(result.requestId).to.equal('req-123');
      expect(result.details.bot.status).to.equal(200);
    });

    it('does NOT pass when only failover (x-edgeoptimize-fo) is present', async () => {
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeResponse(200, { 'x-edgeoptimize-fo': '1' }));
      fetchStub.onSecondCall().resolves(makeResponse(200, {}));

      const result = await edgeOptimize.verifyEdgeOptimizeRouting('https://d.cloudfront.net/');

      expect(result.passed).to.equal(false);
      expect(result.requestId).to.equal(null);
    });

    it('does NOT pass when the human response is also optimized', async () => {
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeResponse(200, { 'x-edgeoptimize-request-id': 'req-123' }));
      fetchStub.onSecondCall().resolves(makeResponse(200, { 'x-edgeoptimize-request-id': 'req-999' }));

      const result = await edgeOptimize.verifyEdgeOptimizeRouting('https://d.cloudfront.net/');

      expect(result.passed).to.equal(false);
    });

    it('throws when url is missing', async () => {
      let error;
      try {
        await edgeOptimize.verifyEdgeOptimizeRouting('');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('url');
    });
  });
});
