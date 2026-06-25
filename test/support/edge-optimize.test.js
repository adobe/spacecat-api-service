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

  // esmock ONCE for the whole file (not per-test) — esmock re-instantiates the mocked module
  // graph on every call and accumulates memory, which contributes to the suite's heap pressure.
  // The mocked clients call the `*SendStub` closures, which read the `let` bindings reassigned
  // fresh in beforeEach, so a single esmock works for all tests.
  before(async function setupEsmock() {
    // One-time esmock of the AWS SDK module graph. This is memory-heavy, so under the full CI
    // suite (12k+ tests + nyc coverage + heap pressure) it can take well over the default/30s
    // even though it runs in ~1s locally. Give the hook generous headroom so it can't flake the
    // whole build on suite growth (it still completes in seconds in practice).
    this.timeout(120000);
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
        GetCachePolicyCommand: cfCommand('GetCachePolicy'),
        ListCachePoliciesCommand: cfCommand('ListCachePolicies'),
        CreateCachePolicyCommand: cfCommand('CreateCachePolicy'),
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
        GetRolePolicyCommand: iamCommand('GetRolePolicy'),
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
        GetFunctionConfigurationCommand: lambdaCommand('GetFunctionConfiguration'),
        ListVersionsByFunctionCommand: lambdaCommand('ListVersionsByFunction'),
        PublishVersionCommand: lambdaCommand('PublishVersion'),
      },
    });
  });

  beforeEach(() => {
    // Fresh stubs per test; the esmocked clients read these `let` bindings at call time.
    stsSendStub = sinon.stub();
    cfSendStub = sinon.stub();
    iamSendStub = sinon.stub();
    lambdaSendStub = sinon.stub();
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

      expect(result).to.deep.equal({
        created: true, alreadyExisted: false, updated: false, originId: 'EdgeOptimize_Origin',
      });
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('UpdateDistribution');
      const update = cfSendStub.secondCall.args[0].input;
      expect(update.IfMatch).to.equal('etag-1');
      const added = update.DistributionConfig.Origins.Items.find((o) => o.Id === 'EdgeOptimize_Origin');
      expect(added.DomainName).to.equal('dev.edgeoptimize.net');
      expect(added.CustomOriginConfig.OriginProtocolPolicy).to.equal('https-only');
    });

    it('sets the EO custom headers on the new origin', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: 'origin-aem', DomainName: 'origin.example.com' }] } },
        ETag: 'etag-1',
      });
      cfSendStub.onSecondCall().resolves({});

      await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE', 'dev.edgeoptimize.net', {
        apiKey: 'eo-key-123', forwardedHost: 'www.example.com', fetcherKey: 'fk-9',
      });

      const update = cfSendStub.secondCall.args[0].input;
      const added = update.DistributionConfig.Origins.Items.find((o) => o.Id === 'EdgeOptimize_Origin');
      expect(added.CustomHeaders.Quantity).to.equal(3);
      const headerMap = added.CustomHeaders.Items.reduce((acc, h) => {
        acc[h.HeaderName] = h.HeaderValue;
        return acc;
      }, {});
      expect(headerMap).to.deep.equal({
        'x-edgeoptimize-api-key': 'eo-key-123',
        'x-forwarded-host': 'www.example.com',
        'x-edgeoptimize-fetcher-key': 'fk-9',
      });
    });

    it('is idempotent when the origin already exists by id', async () => {
      cfSendStub.resolves({
        DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: 'EdgeOptimize_Origin', DomainName: 'x' }] } },
        ETag: 'etag-1',
      });

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE');

      expect(result).to.deep.equal({
        created: false, alreadyExisted: true, updated: false, originId: 'EdgeOptimize_Origin',
      });
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

    it('patches the headers when the origin exists without them (self-heal)', async () => {
      cfSendStub.onFirstCall().resolves({
        DistributionConfig: {
          Origins: {
            Quantity: 1,
            Items: [{ Id: 'EdgeOptimize_Origin', DomainName: 'dev.edgeoptimize.net', CustomHeaders: { Quantity: 0, Items: [] } }],
          },
        },
        ETag: 'etag-1',
      });
      cfSendStub.onSecondCall().resolves({});

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE', 'dev.edgeoptimize.net', {
        apiKey: 'eo-key-123', forwardedHost: 'www.example.com',
      });

      expect(result).to.deep.equal({
        created: false, alreadyExisted: true, updated: true, originId: 'EdgeOptimize_Origin',
      });
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('UpdateDistribution');
      const patched = cfSendStub.secondCall.args[0].input
        .DistributionConfig.Origins.Items.find((o) => o.Id === 'EdgeOptimize_Origin');
      expect(patched.CustomHeaders.Quantity).to.equal(2);
    });

    it('does not patch when the existing headers already match', async () => {
      cfSendStub.resolves({
        DistributionConfig: {
          Origins: {
            Quantity: 1,
            Items: [{
              Id: 'EdgeOptimize_Origin',
              DomainName: 'dev.edgeoptimize.net',
              CustomHeaders: {
                Quantity: 2,
                Items: [
                  { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key-123' },
                  { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                ],
              },
            }],
          },
        },
        ETag: 'etag-1',
      });

      const result = await edgeOptimize.createEdgeOptimizeOrigin({}, 'E2EXAMPLE', 'dev.edgeoptimize.net', {
        apiKey: 'eo-key-123', forwardedHost: 'www.example.com',
      });

      expect(result.updated).to.equal(false);
      expect(cfSendStub.calledOnce).to.equal(true); // no UpdateDistribution
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

  describe('buildEdgeOptimizeLambdaCode', () => {
    it('bakes the EO origin domain into the routing check (per environment)', () => {
      const dev = edgeOptimize.buildEdgeOptimizeLambdaCode('dev.edgeoptimize.net');
      expect(dev).to.include("originDomain === 'dev.edgeoptimize.net'");
      expect(dev).to.not.include("originDomain === 'live.edgeoptimize.net'");

      const prod = edgeOptimize.buildEdgeOptimizeLambdaCode('live.edgeoptimize.net');
      expect(prod).to.include("originDomain === 'live.edgeoptimize.net'");
    });
  });

  describe('createEdgeOptimizeRoutingFunction', () => {
    it('creates and publishes a new function when none exists', async () => {
      cfSendStub.onFirstCall().rejects(Object.assign(new Error('not found'), { name: 'NoSuchFunctionExists' }));
      cfSendStub.onSecondCall().resolves({ ETag: 'fn-etag' }); // CreateFunction
      cfSendStub.onThirdCall().resolves({}); // PublishFunction

      const result = await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem', 'E2EXAMPLE');

      expect(result).to.deep.equal({ name: 'edgeoptimize-routing-adobe-E2EXAMPLE', created: true, stage: 'LIVE' });
      expect(cfSendStub.secondCall.args[0].commandName).to.equal('CreateFunction');
      expect(cfSendStub.thirdCall.args[0].commandName).to.equal('PublishFunction');
      expect(cfSendStub.thirdCall.args[0].input.IfMatch).to.equal('fn-etag');
    });

    it('updates and publishes when the function already exists', async () => {
      cfSendStub.onFirstCall().resolves({ ETag: 'dev-etag' }); // DescribeFunction DEVELOPMENT
      cfSendStub.onSecondCall().resolves({ ETag: 'updated-etag' }); // UpdateFunction
      cfSendStub.onThirdCall().resolves({}); // PublishFunction

      const result = await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem', 'E2EXAMPLE');

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
        await edgeOptimize.createEdgeOptimizeRoutingFunction({}, 'origin-aem', 'E2EXAMPLE');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.equal('boom');
    });
  });

  describe('applyEdgeOptimizeCacheHeaders', () => {
    // Dispatch cfSendStub by command name so tests are robust to call order.
    const wireCloudFront = (responders) => {
      cfSendStub.callsFake((cmd) => {
        const fn = responders[cmd.commandName];
        if (!fn) {
          throw new Error(`unexpected command in test: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
    };

    const lastCommand = (name) => cfSendStub.getCalls()
      .filter((c) => c.args[0].commandName === name).pop()?.args[0];

    it('updates a CUSTOM policy to add the EO headers + MinTTL 0', async () => {
      wireCloudFront({
        GetDistributionConfig: { DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'cp-1' } } },
        ListCachePolicies: { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-x' } }] } },
        GetCachePolicyConfig: {
          CachePolicyConfig: {
            Name: 'my-policy',
            MinTTL: 60,
            ParametersInCacheKeyAndForwardedToOrigin: {
              HeadersConfig: { HeaderBehavior: 'whitelist', Headers: { Quantity: 1, Items: ['accept'] } },
            },
          },
          ETag: 'cp-etag',
        },
        UpdateCachePolicy: {},
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result.scenario).to.equal('custom');
      expect(result.policyId).to.equal('cp-1');
      expect(result.updated).to.equal(true);
      const updated = lastCommand('UpdateCachePolicy').input.CachePolicyConfig;
      expect(updated.MinTTL).to.equal(0);
      const items = updated.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.Items;
      expect(items).to.include('x-edgeoptimize-config');
      expect(items).to.include('x-edgeoptimize-url');
    });

    it('is a no-op when a custom policy already forwards the headers and MinTTL is 0', async () => {
      wireCloudFront({
        GetDistributionConfig: { DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'cp-1' } } },
        ListCachePolicies: { CachePolicyList: { Items: [] } },
        GetCachePolicyConfig: {
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
        },
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result).to.deep.equal({
        scenario: 'custom', policyId: 'cp-1', updated: false, alreadyForwarded: true,
      });
      expect(lastCommand('UpdateCachePolicy')).to.equal(undefined); // never updated
    });

    it('CLONES an AWS-managed policy into a per-distribution custom policy and repoints the behavior', async () => {
      wireCloudFront({
        GetDistributionConfig: {
          DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'managed-1', ForwardedValues: { x: 1 } } },
          ETag: 'dist-etag',
        },
        ListCachePolicies: (cmd) => (cmd.input.Type === 'managed'
          ? { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-1' } }] } }
          : { CachePolicyList: { Items: [] } }), // no existing custom edgeoptimize-cache
        GetCachePolicy: {
          CachePolicy: {
            CachePolicyConfig: {
              Name: 'Managed-CachingOptimized',
              MinTTL: 86400,
              ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'none' } },
            },
          },
        },
        CreateCachePolicy: { CachePolicy: { Id: 'new-eo-policy' } },
        UpdateDistribution: {},
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result.scenario).to.equal('managed');
      expect(result.policyId).to.equal('new-eo-policy');
      expect(result.reused).to.equal(false);
      const created = lastCommand('CreateCachePolicy').input.CachePolicyConfig;
      expect(created.Name).to.equal('CachingOptimized-adobe-E2EXAMPLE');
      expect(created.MinTTL).to.equal(0);
      const items = created.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.Items;
      expect(items).to.include('x-edgeoptimize-config');
      // behavior repointed to the new policy + ForwardedValues removed
      const cfg = lastCommand('UpdateDistribution').input.DistributionConfig;
      expect(cfg.DefaultCacheBehavior.CachePolicyId).to.equal('new-eo-policy');
      expect(cfg.DefaultCacheBehavior.ForwardedValues).to.equal(undefined);
    });

    it('keeps a short MinTTL (<=5s) when cloning a managed policy instead of forcing it to 0', async () => {
      wireCloudFront({
        GetDistributionConfig: {
          DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'managed-1' } },
          ETag: 'dist-etag',
        },
        ListCachePolicies: (cmd) => (cmd.input.Type === 'managed'
          ? { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-1' } }] } }
          : { CachePolicyList: { Items: [] } }),
        GetCachePolicy: {
          CachePolicy: {
            CachePolicyConfig: {
              Name: 'Managed-CachingOptimized',
              MinTTL: 3,
              ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'none' } },
            },
          },
        },
        CreateCachePolicy: { CachePolicy: { Id: 'new-eo-policy' } },
        UpdateDistribution: {},
      });

      await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      const created = lastCommand('CreateCachePolicy').input.CachePolicyConfig;
      expect(created.MinTTL).to.equal(3); // <= 5s kept, not zeroed
    });

    it('reuses an existing edgeoptimize-cache custom policy (idempotent managed path)', async () => {
      wireCloudFront({
        GetDistributionConfig: {
          DistributionConfig: { DefaultCacheBehavior: { CachePolicyId: 'managed-1' } },
          ETag: 'dist-etag',
        },
        ListCachePolicies: (cmd) => (cmd.input.Type === 'managed'
          ? { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-1' } }] } }
          : { CachePolicyList: { Items: [{ CachePolicy: { Id: 'existing-eo', CachePolicyConfig: { Name: 'X-adobe-E2EXAMPLE' } } }] } }),
        GetCachePolicy: {
          CachePolicy: { CachePolicyConfig: { Name: 'Managed-X', ParametersInCacheKeyAndForwardedToOrigin: {} } },
        },
        UpdateDistribution: {},
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result.scenario).to.equal('managed');
      expect(result.policyId).to.equal('existing-eo');
      expect(result.reused).to.equal(true);
      expect(lastCommand('CreateCachePolicy')).to.equal(undefined); // reused, not created
    });

    it('handles a LEGACY behavior (ForwardedValues, no CachePolicyId)', async () => {
      wireCloudFront({
        GetDistributionConfig: {
          DistributionConfig: {
            DefaultCacheBehavior: { ForwardedValues: { Headers: { Quantity: 1, Items: ['accept'] } }, MinTTL: 60 },
          },
          ETag: 'dist-etag',
        },
        UpdateDistribution: {},
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', 'default');

      expect(result.scenario).to.equal('legacy');
      expect(result.updated).to.equal(true);
      const cfg = lastCommand('UpdateDistribution').input.DistributionConfig;
      const items = cfg.DefaultCacheBehavior.ForwardedValues.Headers.Items;
      expect(items).to.include('x-edgeoptimize-config');
      expect(cfg.DefaultCacheBehavior.MinTTL).to.equal(0);
    });

    it('targets a named (non-default) custom-policy behavior', async () => {
      wireCloudFront({
        GetDistributionConfig: {
          DistributionConfig: {
            DefaultCacheBehavior: { CachePolicyId: 'cp-default' },
            CacheBehaviors: { Items: [{ PathPattern: '/api/*', CachePolicyId: 'cp-api' }] },
          },
        },
        ListCachePolicies: { CachePolicyList: { Items: [] } },
        GetCachePolicyConfig: {
          CachePolicyConfig: {
            Name: 'api',
            MinTTL: 0,
            ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'none' } },
          },
          ETag: 'cp-etag',
        },
        UpdateCachePolicy: {},
      });

      const result = await edgeOptimize.applyEdgeOptimizeCacheHeaders({}, 'E2EXAMPLE', '/api/*');
      expect(result.policyId).to.equal('cp-api');
      expect(lastCommand('GetCachePolicyConfig').input.Id).to.equal('cp-api');
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

    // IAM + Lambda stubs dispatch by command name (robust to call order/poll counts).
    const wireIam = (responders) => {
      iamSendStub.callsFake((cmd) => {
        const r = responders[cmd.commandName];
        return Promise.resolve(typeof r === 'function' ? r(cmd) : (r || {}));
      });
    };
    const wireLambda = (responders) => {
      lambdaSendStub.callsFake((cmd) => {
        const r = responders[cmd.commandName];
        if (r === undefined) {
          throw new Error(`unexpected lambda command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof r === 'function' ? r(cmd) : r);
      });
    };
    const lastLambda = (name) => lambdaSendStub.getCalls()
      .filter((c) => c.args[0].commandName === name).pop()?.args[0];
    const notFound = () => Promise.reject(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));

    it('creates the role + function (non-blocking) and returns provisioning', async () => {
      wireIam({
        GetRole: () => Promise.reject(Object.assign(new Error('no role'), { name: 'NoSuchEntityException' })),
        CreateRole: { Role: { Arn: 'arn:aws:iam::120569600543:role/edgeoptimize-origin-role' } },
        PutRolePolicy: {},
      });
      wireLambda({
        GetFunctionConfiguration: () => notFound(),
        CreateFunction: { FunctionArn: 'arn:fn' },
      });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { roleWaitMs: 0, distributionId: 'E2EXAMPLE' });

      // Does NOT block on the new function becoming Active — returns provisioning immediately.
      expect(result.status).to.equal('provisioning');
      expect(result.created).to.equal(true);
      expect(result.versionArn).to.equal(null);
      expect(result.roleArn).to.include('edgeoptimize-origin-role');
      expect(lastLambda('CreateFunction').input.Role).to.include('edgeoptimize-origin-role');
      expect(lastLambda('PublishVersion')).to.equal(undefined); // never publishes while Pending
    });

    it('returns provisioning (no mutation) while the function is still finalizing', async () => {
      wireIam({ GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} });
      wireLambda({
        GetFunctionConfiguration: {
          FunctionArn: 'arn:fn', State: 'Active', LastUpdateStatus: 'InProgress',
        },
      });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { distributionId: 'E2EXAMPLE' });

      expect(result.status).to.equal('provisioning');
      expect(result.versionArn).to.equal(null);
      expect(lastLambda('PublishVersion')).to.equal(undefined); // never touched while InProgress
    });

    it('is idempotent: reuses the existing version when the function is idle', async () => {
      wireIam({ GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} });
      wireLambda({
        GetFunctionConfiguration: {
          FunctionArn: 'arn:fn', State: 'Active', LastUpdateStatus: 'Successful',
        },
        ListVersionsByFunction: { Versions: [{ Version: '$LATEST' }, { Version: '3', FunctionArn: 'arn:fn:3' }] },
      });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { distributionId: 'E2EXAMPLE' });

      expect(result.status).to.equal('ready');
      expect(result.alreadyExisted).to.equal(true);
      expect(result.versionArn).to.equal('arn:fn:3');
      expect(lastLambda('PublishVersion')).to.equal(undefined); // reused, not re-published
    });

    it('publishes a version when the function is idle but unpublished', async () => {
      wireIam({ GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} });
      wireLambda({
        GetFunctionConfiguration: {
          FunctionArn: 'arn:fn', State: 'Active', LastUpdateStatus: 'Successful',
        },
        ListVersionsByFunction: { Versions: [{ Version: '$LATEST' }] },
        PublishVersion: { FunctionArn: 'arn:fn:1', Version: '1' },
      });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { distributionId: 'E2EXAMPLE' });

      expect(result.status).to.equal('ready');
      expect(result.versionArn).to.equal('arn:fn:1');
      expect(lastLambda('PublishVersion')).to.not.equal(undefined);
    });

    it('treats a concurrent-create conflict as provisioning', async () => {
      wireIam({ GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} });
      wireLambda({
        GetFunctionConfiguration: () => notFound(),
        CreateFunction: () => Promise.reject(Object.assign(new Error('exists'), { name: 'ResourceConflictException' })),
      });

      const result = await edgeOptimize.createEdgeOptimizeLambda(creds, '120569600543', { roleWaitMs: 0, distributionId: 'E2EXAMPLE' });

      expect(result.status).to.equal('provisioning');
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

  describe('getEdgeOptimizeLambdaStatus', () => {
    it('reports roleExists:false + exists:false when nothing is provisioned', async () => {
      iamSendStub.callsFake(() => Promise.reject(Object.assign(new Error('no role'), { name: 'NoSuchEntityException' })));
      lambdaSendStub.callsFake((cmd) => {
        if (cmd.commandName === 'GetFunctionConfiguration') {
          return Promise.reject(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
        }
        throw new Error(`unexpected: ${cmd.commandName}`);
      });

      const result = await edgeOptimize.getEdgeOptimizeLambdaStatus({}, 'E2EXAMPLE');

      expect(result).to.deep.equal({
        roleExists: false, exists: false, versionArn: null, ready: false,
      });
    });

    it('reports the role + published version and ready:true when fully provisioned', async () => {
      iamSendStub.callsFake(() => Promise.resolve({ Role: { Arn: 'arn:role' } }));
      lambdaSendStub.callsFake((cmd) => {
        if (cmd.commandName === 'GetFunctionConfiguration') {
          return Promise.resolve({ FunctionArn: 'arn:fn', State: 'Active', LastUpdateStatus: 'Successful' });
        }
        if (cmd.commandName === 'ListVersionsByFunction') {
          return Promise.resolve({ Versions: [{ Version: '$LATEST' }, { Version: '2', FunctionArn: 'arn:fn:2' }] });
        }
        throw new Error(`unexpected: ${cmd.commandName}`);
      });

      const result = await edgeOptimize.getEdgeOptimizeLambdaStatus({}, 'E2EXAMPLE');

      expect(result.roleExists).to.equal(true);
      expect(result.exists).to.equal(true);
      expect(result.state).to.equal('Active');
      expect(result.versionArn).to.equal('arn:fn:2');
      expect(result.version).to.equal('2');
      expect(result.ready).to.equal(true);
    });

    it('reports ready:false (role created, still provisioning) when not yet published', async () => {
      iamSendStub.callsFake(() => Promise.resolve({ Role: { Arn: 'arn:role' } }));
      lambdaSendStub.callsFake((cmd) => {
        if (cmd.commandName === 'GetFunctionConfiguration') {
          return Promise.resolve({ FunctionArn: 'arn:fn', State: 'Pending', LastUpdateStatus: 'InProgress' });
        }
        if (cmd.commandName === 'ListVersionsByFunction') {
          return Promise.resolve({ Versions: [{ Version: '$LATEST' }] });
        }
        throw new Error(`unexpected: ${cmd.commandName}`);
      });

      const result = await edgeOptimize.getEdgeOptimizeLambdaStatus({}, 'E2EXAMPLE');

      expect(result.roleExists).to.equal(true);
      expect(result.exists).to.equal(true);
      expect(result.versionArn).to.equal(null);
      expect(result.ready).to.equal(false);
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

    it('preserves the customer\'s other-slot associations (merge, not wholesale replace)', async () => {
      cfSendStub.onFirstCall().resolves({
        FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } },
      });
      cfSendStub.onSecondCall().resolves({
        DistributionConfig: {
          DefaultCacheBehavior: {
            FunctionAssociations: {
              Quantity: 1,
              Items: [{ EventType: 'viewer-response', FunctionARN: 'arn:cust-fn' }],
            },
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [{ EventType: 'viewer-response', LambdaFunctionARN: 'arn:cust-lambda', IncludeBody: false }],
            },
          },
        },
        ETag: 'dist-etag',
      });
      cfSendStub.onThirdCall().resolves({});

      await edgeOptimize.applyEdgeOptimizeAssociations({}, 'E2EXAMPLE', 'default', lambdaArn);
      const behavior = cfSendStub.thirdCall.args[0].input.DistributionConfig.DefaultCacheBehavior;
      // Customer's viewer-response function is preserved; EO's viewer-request function is added.
      expect(behavior.FunctionAssociations.Items)
        .to.deep.include({ EventType: 'viewer-response', FunctionARN: 'arn:cust-fn' });
      expect(behavior.FunctionAssociations.Items)
        .to.deep.include({ FunctionARN: 'arn:cf-fn', EventType: 'viewer-request' });
      // Customer's viewer-response lambda is preserved; EO's origin-request/response are added.
      const lambdaEvents = behavior.LambdaFunctionAssociations.Items.map((i) => i.EventType);
      expect(lambdaEvents).to.include.members(['viewer-response', 'origin-request', 'origin-response']);
      expect(behavior.LambdaFunctionAssociations.Items
        .find((i) => i.EventType === 'viewer-response').LambdaFunctionARN).to.equal('arn:cust-lambda');
    });

    it('refuses to overwrite a customer origin-request Lambda@Edge', async () => {
      cfSendStub.onFirstCall().resolves({
        FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } },
      });
      cfSendStub.onSecondCall().resolves({
        DistributionConfig: {
          DefaultCacheBehavior: {
            LambdaFunctionAssociations: {
              Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:cust-origin-lambda' }],
            },
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
      expect(error.message).to.include('different origin-request');
      expect(cfSendStub.thirdCall).to.equal(null); // never issued an UpdateDistribution
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

  describe('runEdgeOptimizeDeployStep', () => {
    let fetchStub;
    const deployParams = {
      distributionId: 'E2EXAMPLE123',
      originId: 'origin-aem',
      behavior: 'default',
      originDomain: 'dev.edgeoptimize.net',
      originHeaders: { apiKey: 'eo-key', forwardedHost: 'www.example.com' },
      accountId: '120569600543',
    };

    // Dispatch each client's send() by command name; per-test overrides via the `r` map.
    const wire = (cf = {}, lambda = {}, iam = {}) => {
      cfSendStub.callsFake((cmd) => {
        const fn = cf[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected cf command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
      lambdaSendStub.callsFake((cmd) => {
        const fn = lambda[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected lambda command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
      iamSendStub.callsFake((cmd) => {
        const fn = iam[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected iam command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
    };

    const statusOf = (steps, key) => steps.find((s) => s.key === key).status;
    const cfCalls = (name) => cfSendStub.getCalls().filter((c) => c.args[0].commandName === name);

    // Returns a responder that throws an AWS-style named error (so the SDK error path triggers).
    const throwNamed = (name, message) => () => {
      const e = new Error(message);
      e.name = name;
      throw e;
    };

    const makeFetchResponse = (status, headerMap) => ({
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

    it('first call advances origin+function+cache and returns lambda in_progress (others pending)', async () => {
      wire(
        {
          // origin: existing with matching headers → idempotent no-op (no UpdateDistribution).
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: { CachePolicyId: 'cp-1' },
            },
            ETag: 'etag',
          },
          // function gate: already published to LIVE → skip create+publish.
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          // cache: custom policy already forwards EO headers + MinTTL 0 → no-op.
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
            ETag: 'cp-etag',
          },
        },
        {
          // lambda: does not exist yet → kick off create → in_progress.
          GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope'),
          ListVersionsByFunction: { Versions: [] },
          CreateFunction: { FunctionArn: 'arn:lambda', Version: '$LATEST' },
        },
        {
          // Role already exists → no role-propagation wait (the slow create path is avoided).
          GetRole: { Role: { Arn: 'arn:role' } },
          UpdateAssumeRolePolicy: {},
          PutRolePolicy: {},
        },
      );

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'origin')).to.equal('done');
      expect(statusOf(out.steps, 'function')).to.equal('done');
      expect(statusOf(out.steps, 'cache')).to.equal('done');
      expect(statusOf(out.steps, 'lambda')).to.equal('in_progress');
      expect(statusOf(out.steps, 'associate')).to.equal('pending');
      expect(statusOf(out.steps, 'verify')).to.equal('pending');
      expect(out.routingDeployed).to.equal(false);
      expect(out.verified).to.equal(false);
      // function already LIVE → never created/published.
      expect(cfCalls('CreateFunction')).to.have.length(0);
      expect(cfCalls('PublishFunction')).to.have.length(0);
    });

    it('with lambda ready proceeds to associate then verify (in_progress until propagation)', async () => {
      const lambdaVersionArn = 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:3';
      wire(
        {
          GetDistributionConfig: () => ({
            // origin exists (idempotent), default behavior NOT yet associated (associate must run).
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: { CachePolicyId: 'cp-1' },
            },
            ETag: 'etag',
          }),
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
            ETag: 'cp-etag',
          },
          UpdateDistribution: {},
          ListDistributions: { DistributionList: { Items: [{ Id: 'E2EXAMPLE123', DomainName: 'd123.cloudfront.net', Status: 'Deployed' }] } },
        },
        {
          GetFunctionConfiguration: { State: 'Active', LastUpdateStatus: 'Successful', FunctionArn: 'arn:lambda' },
          ListVersionsByFunction: { Versions: [{ Version: '3', FunctionArn: lambdaVersionArn, CodeSha256: 'sha' }] },
        },
        {
          GetRole: { Role: { Arn: 'arn:role' } },
        },
      );
      // verify probe: bot lacks request-id → not passed yet (propagation).
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeFetchResponse(200, {}));
      fetchStub.onSecondCall().resolves(makeFetchResponse(200, {}));

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'lambda')).to.equal('done');
      expect(statusOf(out.steps, 'associate')).to.equal('done');
      expect(statusOf(out.steps, 'verify')).to.equal('in_progress');
      expect(out.routingDeployed).to.equal(true);
      expect(out.verified).to.equal(false);
      // associate ran exactly one UpdateDistribution (behavior was not associated).
      expect(cfCalls('UpdateDistribution')).to.have.length(1);
    });

    it('verify passes → verified true and verify done', async () => {
      const lambdaVersionArn = 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:3';
      wire(
        {
          GetDistributionConfig: () => ({
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              // already associated → associate gate skips UpdateDistribution.
              DefaultCacheBehavior: {
                CachePolicyId: 'cp-1',
                FunctionAssociations: { Items: [{ EventType: 'viewer-request', FunctionARN: 'arn:fn/edgeoptimize-routing' }] },
                LambdaFunctionAssociations: { Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:edgeoptimize-origin:3' }] },
              },
            },
            ETag: 'etag',
          }),
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
            ETag: 'cp-etag',
          },
          ListDistributions: { DistributionList: { Items: [{ Id: 'E2EXAMPLE123', DomainName: 'd123.cloudfront.net', Status: 'Deployed' }] } },
        },
        {
          GetFunctionConfiguration: { State: 'Active', LastUpdateStatus: 'Successful', FunctionArn: 'arn:lambda' },
          ListVersionsByFunction: { Versions: [{ Version: '3', FunctionArn: lambdaVersionArn, CodeSha256: 'sha' }] },
        },
        { GetRole: { Role: { Arn: 'arn:role' } } },
      );
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeFetchResponse(200, { 'x-edgeoptimize-request-id': 'req-1' }));
      fetchStub.onSecondCall().resolves(makeFetchResponse(200, {}));

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'associate')).to.equal('done');
      expect(statusOf(out.steps, 'propagation')).to.equal('done');
      expect(statusOf(out.steps, 'verify')).to.equal('done');
      expect(out.routingDeployed).to.equal(true);
      expect(out.verified).to.equal(true);
      // verify probe surfaces the per-UA result the wizard renders.
      const verifyProbe = out.steps.find((s) => s.key === 'verify').probe;
      expect(verifyProbe.bot).to.deep.include({ ua: 'chatgpt-user', requestId: 'req-1', failover: false });
      expect(verifyProbe.human.requestId).to.equal(null);
      // idempotent gate: behavior already associated → no UpdateDistribution at all.
      expect(cfCalls('UpdateDistribution')).to.have.length(0);
    });

    it('holds at propagation (verify pending) while the distribution is still Deploying', async () => {
      const lambdaVersionArn = 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:3';
      wire(
        {
          GetDistributionConfig: () => ({
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: {
                CachePolicyId: 'cp-1',
                FunctionAssociations: { Items: [{ EventType: 'viewer-request', FunctionARN: 'arn:fn/edgeoptimize-routing' }] },
                LambdaFunctionAssociations: { Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:edgeoptimize-origin:3' }] },
              },
            },
            ETag: 'etag',
          }),
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: { HeaderBehavior: 'whitelist', Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] } },
              },
            },
            ETag: 'cp-etag',
          },
          // distribution still deploying → propagation gate holds, verify never runs.
          ListDistributions: { DistributionList: { Items: [{ Id: 'E2EXAMPLE123', DomainName: 'd123.cloudfront.net', Status: 'InProgress' }] } },
        },
        {
          GetFunctionConfiguration: { State: 'Active', LastUpdateStatus: 'Successful', FunctionArn: 'arn:lambda' },
          ListVersionsByFunction: { Versions: [{ Version: '3', FunctionArn: lambdaVersionArn, CodeSha256: 'sha' }] },
        },
        { GetRole: { Role: { Arn: 'arn:role' } } },
      );

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'associate')).to.equal('done');
      expect(statusOf(out.steps, 'propagation')).to.equal('in_progress');
      expect(statusOf(out.steps, 'verify')).to.equal('pending');
      expect(out.steps.find((s) => s.key === 'propagation').detail).to.include('Deploying');
      expect(out.verified).to.equal(false);
    });

    it('marks the step error (earlier done, later pending) and does not throw when a step fails', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: { CachePolicyId: 'cp-1' },
            },
            ETag: 'etag',
          },
          // function gate DescribeFunction throws a non-NoSuchFunction error → step error.
          DescribeFunction: () => { throw new Error('AccessDenied on DescribeFunction'); },
        },
      );

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'origin')).to.equal('done');
      expect(statusOf(out.steps, 'function')).to.equal('error');
      expect(out.steps.find((s) => s.key === 'function').detail).to.include('AccessDenied');
      // later steps remain pending.
      expect(statusOf(out.steps, 'cache')).to.equal('pending');
      expect(statusOf(out.steps, 'lambda')).to.equal('pending');
      expect(out.routingDeployed).to.equal(false);
    });

    it('holds the sequence when lambda exists but is not yet ready (no re-create)', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: { CachePolicyId: 'cp-1' },
            },
            ETag: 'etag',
          },
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
            ETag: 'cp-etag',
          },
        },
        {
          // exists but still finalizing (Pending) → createEdgeOptimizeLambda is called to drive the
          // state machine, but it must NOT CreateFunction or PublishVersion while still Pending.
          GetFunctionConfiguration: { State: 'Pending', LastUpdateStatus: 'InProgress', FunctionArn: 'arn:lambda' },
          ListVersionsByFunction: { Versions: [] },
        },
        { GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} },
      );

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      expect(statusOf(out.steps, 'lambda')).to.equal('in_progress');
      expect(statusOf(out.steps, 'associate')).to.equal('pending');
      // Pending → neither CreateFunction nor PublishVersion (no re-create, no premature publish).
      expect(lambdaSendStub.getCalls().filter((c) => c.args[0].commandName === 'CreateFunction')).to.have.length(0);
      expect(lambdaSendStub.getCalls().filter((c) => c.args[0].commandName === 'PublishVersion')).to.have.length(0);
    });

    it('publishes the version once the Lambda is Active, then proceeds to associate + verify', async () => {
      const lambdaVersionArn = 'arn:aws:lambda:us-east-1:120569600543:function:edgeoptimize-origin:1';
      wire(
        {
          GetDistributionConfig: () => ({
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'dev.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              // already associated → associate gate skips; the focus is the lambda publish path.
              DefaultCacheBehavior: {
                CachePolicyId: 'cp-1',
                FunctionAssociations: { Items: [{ EventType: 'viewer-request', FunctionARN: 'arn:fn/edgeoptimize-routing' }] },
                LambdaFunctionAssociations: { Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:edgeoptimize-origin:1' }] },
              },
            },
            ETag: 'etag',
          }),
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'p',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Quantity: 2, Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
            ETag: 'cp-etag',
          },
          ListDistributions: { DistributionList: { Items: [{ Id: 'E2EXAMPLE123', DomainName: 'd123.cloudfront.net', Status: 'Deployed' }] } },
        },
        {
          // Active + idle, NO published version yet → createEdgeOptimizeLambda must publish one.
          GetFunctionConfiguration: { State: 'Active', LastUpdateStatus: 'Successful', FunctionArn: 'arn:lambda' },
          ListVersionsByFunction: { Versions: [] },
          PublishVersion: { Version: '1', FunctionArn: lambdaVersionArn },
        },
        { GetRole: { Role: { Arn: 'arn:role' } }, UpdateAssumeRolePolicy: {}, PutRolePolicy: {} },
      );
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(makeFetchResponse(200, { 'x-edgeoptimize-request-id': 'req-1' }));
      fetchStub.onSecondCall().resolves(makeFetchResponse(200, {}));

      const out = await edgeOptimize.runEdgeOptimizeDeployStep({}, deployParams);

      // the fix: Active-without-version gets published → lambda flips to done (not stuck).
      expect(statusOf(out.steps, 'lambda')).to.equal('done');
      expect(lambdaSendStub.getCalls().filter((c) => c.args[0].commandName === 'PublishVersion')).to.have.length(1);
      expect(statusOf(out.steps, 'associate')).to.equal('done');
      expect(statusOf(out.steps, 'verify')).to.equal('done');
      expect(out.routingDeployed).to.equal(true);
      expect(out.verified).to.equal(true);
    });
  });

  describe('planEdgeOptimizeDeploy', () => {
    const planParams = {
      distributionId: 'E2EXAMPLE123',
      originId: 'origin-aem',
      behavior: 'default',
      originDomain: 'live.edgeoptimize.net',
      originHeaders: { apiKey: 'eo-key', forwardedHost: 'www.example.com' },
      accountId: '120569600543',
    };

    // Dispatch each client's send() by command name; per-test overrides via the maps.
    const wire = (cf = {}, lambda = {}, iam = {}) => {
      cfSendStub.callsFake((cmd) => {
        const fn = cf[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected cf command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
      lambdaSendStub.callsFake((cmd) => {
        const fn = lambda[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected lambda command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
      iamSendStub.callsFake((cmd) => {
        const fn = iam[cmd.commandName];
        if (fn === undefined) {
          throw new Error(`unexpected iam command: ${cmd.commandName}`);
        }
        return Promise.resolve(typeof fn === 'function' ? fn(cmd) : fn);
      });
    };

    const throwNamed = (name, message) => () => {
      const e = new Error(message);
      e.name = name;
      throw e;
    };

    const stepOf = (steps, key) => steps.find((s) => s.key === key);

    it('plans an all-create deploy (nothing exists yet, legacy cache)', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: { Items: [] },
              DefaultCacheBehavior: {
                ForwardedValues: { Headers: { Quantity: 0, Items: [] } },
                MinTTL: 60,
              },
            },
          },
          // function gate: not published to LIVE.
          DescribeFunction: throwNamed('NoSuchFunctionExists', 'no fn'),
        },
        {
          // lambda: does not exist.
          GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope'),
        },
        {
          GetRole: throwNamed('NoSuchEntityException', 'no role'),
        },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);

      expect(result.canProceed).to.equal(true);
      expect(result.blocker).to.equal(null);
      expect(result.steps.map((s) => s.key)).to.deep.equal(['origin', 'function', 'cache', 'lambda', 'associate']);
      expect(stepOf(result.steps, 'origin').action).to.equal('create');
      expect(stepOf(result.steps, 'function').action).to.equal('create');
      expect(stepOf(result.steps, 'cache').action).to.equal('update');
      expect(stepOf(result.steps, 'cache').detail).to.include('Add the Edge Optimize headers');
      expect(stepOf(result.steps, 'lambda').action).to.equal('create');
      expect(stepOf(result.steps, 'associate').action).to.equal('create');
      // no `verify` row in the plan
      expect(result.steps.some((s) => s.key === 'verify')).to.equal(false);
    });

    it('blocks when the behavior is already associated (canProceed:false + exact blocker)', async () => {
      const associatedBehavior = {
        ForwardedValues: { Headers: { Items: [] } },
        FunctionAssociations: {
          Items: [{ EventType: 'viewer-request', FunctionARN: 'arn:aws:cloudfront::1:function/edgeoptimize-routing-adobe-E2EXAMPLE123' }],
        },
        LambdaFunctionAssociations: {
          Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:aws:lambda:us-east-1:1:function:edgeoptimize-origin-adobe-E2EXAMPLE123:1' }],
        },
      };
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: { Items: [] },
              DefaultCacheBehavior: associatedBehavior,
            },
          },
          DescribeFunction: throwNamed('NoSuchFunctionExists', 'no fn'),
        },
        { GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope') },
        { GetRole: throwNamed('NoSuchEntityException', 'no role') },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);

      expect(result.canProceed).to.equal(false);
      expect(result.blocker).to.equal(
        "This behaviour is already associated with routes, please recheck — can't proceed with this automation.",
      );
      expect(stepOf(result.steps, 'associate').action).to.equal('blocked');
    });

    it('describes a managed-policy clone in the cache step', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: { Items: [] },
              DefaultCacheBehavior: { CachePolicyId: 'managed-1' },
            },
          },
          DescribeFunction: throwNamed('NoSuchFunctionExists', 'no fn'),
          ListCachePolicies: (cmd) => (cmd.input.Type === 'managed'
            ? { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-1' } }] } }
            : { CachePolicyList: { Items: [] } }), // no existing clone
          GetCachePolicy: {
            CachePolicy: { CachePolicyConfig: { Name: 'Managed-CachingOptimized' } },
          },
        },
        { GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope') },
        { GetRole: throwNamed('NoSuchEntityException', 'no role') },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);

      expect(stepOf(result.steps, 'cache').action).to.equal('create');
      expect(stepOf(result.steps, 'cache').detail).to.include('CachingOptimized-adobe-E2EXAMPLE123');
      expect(result.canProceed).to.equal(true);
    });

    it('marks the managed cache step "update" when the clone exists but the behavior is not associated with it', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: { Items: [] },
              DefaultCacheBehavior: { CachePolicyId: 'managed-1' },
            },
          },
          DescribeFunction: throwNamed('NoSuchFunctionExists', 'no fn'),
          ListCachePolicies: (cmd) => (cmd.input.Type === 'managed'
            ? { CachePolicyList: { Items: [{ CachePolicy: { Id: 'managed-1' } }] } }
            : { CachePolicyList: { Items: [{ CachePolicy: { Id: 'eo-clone', CachePolicyConfig: { Name: 'CachingOptimized-adobe-E2EXAMPLE123' } } }] } }),
          GetCachePolicy: {
            CachePolicy: { CachePolicyConfig: { Name: 'Managed-CachingOptimized' } },
          },
        },
        { GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope') },
        { GetRole: throwNamed('NoSuchEntityException', 'no role') },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);
      // The clone exists but the behavior is still on the managed policy → the deploy will switch
      // the behavior to the existing copy, so this is an 'update' with a clear created-but-not-
      // associated message that names both the current policy and the copy.
      expect(stepOf(result.steps, 'cache').action).to.equal('update');
      expect(stepOf(result.steps, 'cache').detail).to.include('not associated');
      expect(stepOf(result.steps, 'cache').detail).to.include('CachingOptimized-adobe-E2EXAMPLE123');
    });

    it('marks function + lambda + origin "exists" when already present', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: {
                Items: [{
                  Id: 'EdgeOptimize_Origin',
                  DomainName: 'live.edgeoptimize.net',
                  CustomHeaders: {
                    Items: [
                      { HeaderName: 'x-edgeoptimize-api-key', HeaderValue: 'eo-key' },
                      { HeaderName: 'x-forwarded-host', HeaderValue: 'www.example.com' },
                    ],
                  },
                }],
              },
              DefaultCacheBehavior: {
                CachePolicyId: 'cp-custom',
              },
            },
          },
          // function gate: already published to LIVE.
          DescribeFunction: { FunctionSummary: { FunctionMetadata: { FunctionARN: 'arn:cf-fn' } } },
          // cache: custom (not managed), without our headers → update in place.
          ListCachePolicies: { CachePolicyList: { Items: [] } },
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'my-custom-policy',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'none' } },
            },
          },
        },
        {
          // lambda: exists + has a published version → ready.
          GetFunctionConfiguration: { FunctionArn: 'arn:lambda', State: 'Active', LastUpdateStatus: 'Successful' },
          ListVersionsByFunction: { Versions: [{ Version: '3', FunctionArn: 'arn:lambda:3', CodeSha256: 'sha' }] },
        },
        {
          GetRole: {
            Role: {
              Arn: 'arn:role',
              AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Principal: { Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'] },
                  Action: 'sts:AssumeRole',
                }],
              })),
            },
          },
          GetRolePolicy: { PolicyName: 'EdgeOptimizeLambdaLogging', PolicyDocument: '{}' },
        },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);

      expect(stepOf(result.steps, 'origin').action).to.equal('exists');
      expect(stepOf(result.steps, 'function').action).to.equal('exists');
      expect(stepOf(result.steps, 'cache').action).to.equal('update');
      expect(stepOf(result.steps, 'cache').detail).to.include('my-custom-policy');
      expect(stepOf(result.steps, 'lambda').action).to.equal('exists');
      // Role visibility: an existing, correctly-configured execution role is surfaced + reused.
      expect(stepOf(result.steps, 'lambda').detail).to.include('Execution role');
      expect(stepOf(result.steps, 'lambda').detail).to.include('correctly configured');
      expect(stepOf(result.steps, 'associate').action).to.equal('create');
      expect(result.canProceed).to.equal(true);
    });

    it('marks the custom cache step "exists" when our headers are already present (idempotent re-deploy)', async () => {
      wire(
        {
          GetDistributionConfig: {
            DistributionConfig: {
              Origins: { Items: [] },
              DefaultCacheBehavior: { CachePolicyId: 'eo-clone' },
            },
          },
          DescribeFunction: throwNamed('NoSuchFunctionExists', 'no fn'),
          ListCachePolicies: { CachePolicyList: { Items: [] } }, // eo-clone not managed → custom
          GetCachePolicyConfig: {
            CachePolicyConfig: {
              Name: 'CachingOptimized-adobe-E2EXAMPLE123',
              MinTTL: 0,
              ParametersInCacheKeyAndForwardedToOrigin: {
                HeadersConfig: {
                  HeaderBehavior: 'whitelist',
                  Headers: { Items: ['x-edgeoptimize-config', 'x-edgeoptimize-url'] },
                },
              },
            },
          },
        },
        { GetFunctionConfiguration: throwNamed('ResourceNotFoundException', 'nope') },
        { GetRole: throwNamed('NoSuchEntityException', 'no role') },
      );

      const result = await edgeOptimize.planEdgeOptimizeDeploy({}, planParams);
      expect(stepOf(result.steps, 'cache').action).to.equal('exists');
      expect(stepOf(result.steps, 'cache').detail).to.include('Already has the Edge Optimize headers');
    });

    it('throws when distributionId is missing', async () => {
      let error;
      try {
        await edgeOptimize.planEdgeOptimizeDeploy({}, { ...planParams, distributionId: '' });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('distributionId');
    });

    it('throws when behavior is missing', async () => {
      let error;
      try {
        await edgeOptimize.planEdgeOptimizeDeploy({}, { ...planParams, behavior: '' });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include('behavior');
    });
  });
});
