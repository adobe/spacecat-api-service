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
  let edgeOptimize;

  beforeEach(async function setup() {
    this.timeout(30000);
    stsSendStub = sinon.stub();
    cfSendStub = sinon.stub();
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
        ListDistributionsCommand: function ListDistributionsCommand(input) {
          this.input = input;
        },
        GetDistributionConfigCommand: function GetDistributionConfigCommand(input) {
          this.input = input;
        },
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
});
