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

/* eslint-disable */
/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import TokowakaClient from '../src/index.js';

use(sinonChai);

describe('TokowakaClient', () => {
  let client;
  let s3Client;
  let log;
  let mockSite;
  let mockOpportunity;
  let mockSuggestions;

  beforeEach(() => {
    s3Client = {
      send: sinon.stub().resolves(),
    };

    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };

    const env = {
      TOKOWAKA_CDN_PROVIDER: 'cloudfront',
      TOKOWAKA_CDN_CONFIG: JSON.stringify({
        cloudfront: {
          distributionId: 'E123456',
          region: 'us-east-1',
        },
      }),
    };

    client = new TokowakaClient(
      {
        bucketName: 'test-bucket',
        previewBucketName: 'test-preview-bucket',
        s3Client,
        env,
      },
      log,
    );

    mockSite = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
      getConfig: () => ({
        getTokowakaConfig: () => ({
          forwardedHost: 'example.com',
          apiKey: 'test-api-key',
        }),
      }),
    };

    mockOpportunity = {
      getId: () => 'opp-123',
      getType: () => 'headings',
    };

    mockSuggestions = [
      {
        getId: () => 'sugg-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Heading',
          checkType: 'heading-empty',
          transformRules: {
            action: 'replace',
            selector: 'h1',
          },
        }),
      },
      {
        getId: () => 'sugg-2',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://example.com/page1',
          recommendedAction: 'New Subtitle',
          checkType: 'heading-empty',
          transformRules: {
            action: 'replace',
            selector: 'h2',
          },
        }),
      },
    ];
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should create an instance with valid config', () => {
      expect(client).to.be.instanceOf(TokowakaClient);
      expect(client.deployBucketName).to.equal('test-bucket');
      expect(client.previewBucketName).to.equal('test-preview-bucket');
      expect(client.s3Client).to.equal(s3Client);
    });

    it('should throw error if bucketName is missing', () => {
      expect(() => new TokowakaClient({ s3Client }, log))
        .to.throw('TOKOWAKA_SITE_CONFIG_BUCKET is required');
    });

    it('should throw error if s3Client is missing', () => {
      expect(() => new TokowakaClient({ bucketName: 'test-bucket' }, log))
        .to.throw('S3 client is required');
    });

    it('should use deployBucketName for preview if previewBucketName not provided', () => {
      const clientWithoutPreview = new TokowakaClient(
        { bucketName: 'test-bucket', s3Client },
        log,
      );
      // previewBucketName is undefined if not explicitly provided
      expect(clientWithoutPreview.previewBucketName).to.be.undefined;
    });
  });

  describe('createFrom', () => {
    it('should create client from context', () => {
      const context = {
        env: {
          TOKOWAKA_SITE_CONFIG_BUCKET: 'test-bucket',
          TOKOWAKA_PREVIEW_BUCKET: 'test-preview-bucket',
        },
        s3: { s3Client },
        log,
      };

      const createdClient = TokowakaClient.createFrom(context);

      expect(createdClient).to.be.instanceOf(TokowakaClient);
      expect(context.tokowakaClient).to.equal(createdClient);
      expect(createdClient.previewBucketName).to.equal('test-preview-bucket');
    });

    it('should reuse existing client from context', () => {
      const existingClient = new TokowakaClient(
        { bucketName: 'test-bucket', s3Client },
        log,
      );
      const context = {
        env: { TOKOWAKA_SITE_CONFIG_BUCKET: 'test-bucket' },
        s3: { s3Client },
        log,
        tokowakaClient: existingClient,
      };

      const createdClient = TokowakaClient.createFrom(context);

      expect(createdClient).to.equal(existingClient);
    });
  });

  describe('getSupportedOpportunityTypes', () => {
    it('should return list of supported opportunity types', () => {
      const types = client.getSupportedOpportunityTypes();

      expect(types).to.be.an('array');
      expect(types).to.include('headings');
    });
  });

  describe('registerMapper', () => {
    it('should register a custom mapper', () => {
      class CustomMapper {
        // eslint-disable-next-line class-methods-use-this
        getOpportunityType() {
          return 'custom-type';
        }

        // eslint-disable-next-line class-methods-use-this
        requiresPrerender() {
          return false;
        }

        // eslint-disable-next-line class-methods-use-this
        suggestionsToPatches() {
          return [];
        }

        // eslint-disable-next-line class-methods-use-this
        canDeploy() {
          return { eligible: true };
        }
      }

      const customMapper = new CustomMapper();
      client.registerMapper(customMapper);

      const types = client.getSupportedOpportunityTypes();
      expect(types).to.include('custom-type');
    });
  });

  describe('generateConfig', () => {
    it('should generate config for headings opportunity with single URL', () => {
      const url = 'https://example.com/page1';
      const config = client.generateConfig(url, mockOpportunity, mockSuggestions);

      expect(config).to.deep.include({
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
      });

      expect(config.patches).to.have.length(2);

      const patch = config.patches[0];
      expect(patch).to.include({
        op: 'replace',
        selector: 'h1',
        value: 'New Heading',
        opportunityId: 'opp-123',
        prerenderRequired: true,
      });
      expect(patch.suggestionId).to.equal('sugg-1');
      expect(patch).to.have.property('lastUpdated');
    });

    it('should generate config for FAQ opportunity', () => {
      mockOpportunity = {
        getId: () => 'opp-faq-123',
        getType: () => 'faq',
      };

      mockSuggestions = [
        {
          getId: () => 'sugg-faq-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Question 1?',
              answer: 'Answer 1.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
        {
          getId: () => 'sugg-faq-2',
          getUpdatedAt: () => '2025-01-15T11:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            headingText: 'FAQs',
            shouldOptimize: true,
            item: {
              question: 'Question 2?',
              answer: 'Answer 2.',
            },
            transformRules: {
              action: 'appendChild',
              selector: 'main',
            },
          }),
        },
      ];

      const url = 'https://example.com/page1';
      const config = client.generateConfig(url, mockOpportunity, mockSuggestions);

      expect(config).to.deep.include({
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
      });

      expect(config.patches).to.have.length(3); // heading + 2 FAQs

      // First patch: heading (no suggestionId)
      const headingPatch = config.patches[0];
      expect(headingPatch).to.include({
        op: 'appendChild',
        selector: 'main',
        opportunityId: 'opp-faq-123',
        prerenderRequired: true,
      });
      expect(headingPatch.suggestionId).to.be.undefined;
      expect(headingPatch).to.have.property('lastUpdated');
      expect(headingPatch.value.tagName).to.equal('h2');

      // Second patch: first FAQ
      const firstFaqPatch = config.patches[1];
      expect(firstFaqPatch).to.include({
        op: 'appendChild',
        selector: 'main',
        opportunityId: 'opp-faq-123',
        prerenderRequired: true,
      });
      expect(firstFaqPatch.suggestionId).to.equal('sugg-faq-1');
      expect(firstFaqPatch.value.tagName).to.equal('div');
    });

    it('should return null if no eligible suggestions', () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({
            url: 'https://example.com/page1',
            // Missing required fields
          }),
        },
      ];

      const url = 'https://example.com/page1';
      const config = client.generateConfig(url, mockOpportunity, mockSuggestions);

      expect(config).to.be.null;
    });

    it('should handle unsupported opportunity types', () => {
      mockOpportunity.getType = () => 'unsupported-type';

      expect(() => client.generateConfig('https://example.com/page1', mockOpportunity, mockSuggestions))
        .to.throw(/No mapper found for opportunity type: unsupported-type/)
        .with.property('status', 501);
    });
  });

  describe('fetchMetaconfig', () => {
    it('should fetch metaconfig from S3', async () => {
      const metaconfig = {
        siteId: 'site-123',
        prerender: true,
      };

      s3Client.send.resolves({
        Body: {
          transformToString: async () => JSON.stringify(metaconfig),
        },
      });

      const result = await client.fetchMetaconfig('https://example.com/page1');

      expect(result).to.deep.equal(metaconfig);
      expect(s3Client.send).to.have.been.calledOnce;

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-bucket');
      expect(command.input.Key).to.equal('opportunities/example.com/config');
    });

    it('should fetch metaconfig from preview bucket', async () => {
      const metaconfig = {
        siteId: 'site-123',
        prerender: true,
      };

      s3Client.send.resolves({
        Body: {
          transformToString: async () => JSON.stringify(metaconfig),
        },
      });

      await client.fetchMetaconfig('https://example.com/page1', true);

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-preview-bucket');
      expect(command.input.Key).to.equal('preview/opportunities/example.com/config');
    });

    it('should return null if metaconfig does not exist', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      s3Client.send.rejects(noSuchKeyError);

      const result = await client.fetchMetaconfig('https://example.com/page1');

      expect(result).to.be.null;
    });

    it('should throw error on S3 fetch failure', async () => {
      const s3Error = new Error('Access Denied');
      s3Error.name = 'AccessDenied';
      s3Client.send.rejects(s3Error);

      try {
        await client.fetchMetaconfig('https://example.com/page1');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('S3 fetch failed');
        expect(error.status).to.equal(500);
      }
    });

    it('should throw error if URL is missing', async () => {
      try {
        await client.fetchMetaconfig('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('URL is required');
        expect(error.status).to.equal(400);
      }
    });
  });

  describe('uploadMetaconfig', () => {
    it('should upload metaconfig to S3', async () => {
      const metaconfig = {
        siteId: 'site-123',
        prerender: true,
      };

      const s3Path = await client.uploadMetaconfig('https://example.com/page1', metaconfig);

      expect(s3Path).to.equal('opportunities/example.com/config');
      expect(s3Client.send).to.have.been.calledOnce;

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-bucket');
      expect(command.input.Key).to.equal('opportunities/example.com/config');
      expect(command.input.ContentType).to.equal('application/json');
      expect(JSON.parse(command.input.Body)).to.deep.equal(metaconfig);
    });

    it('should upload metaconfig to preview bucket', async () => {
      const metaconfig = {
        siteId: 'site-123',
        prerender: true,
      };

      const s3Path = await client.uploadMetaconfig('https://example.com/page1', metaconfig, true);

      expect(s3Path).to.equal('preview/opportunities/example.com/config');

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-preview-bucket');
    });

    it('should throw error if URL is missing', async () => {
      try {
        await client.uploadMetaconfig('', { siteId: 'site-123', prerender: true });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('URL is required');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error if metaconfig is empty', async () => {
      try {
        await client.uploadMetaconfig('https://example.com/page1', {});
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Metaconfig object is required');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error on S3 upload failure', async () => {
      const s3Error = new Error('Access Denied');
      s3Client.send.rejects(s3Error);

      try {
        await client.uploadMetaconfig('https://example.com/page1', { siteId: 'site-123', prerender: true });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('S3 upload failed');
        expect(error.status).to.equal(500);
      }
    });
  });

  describe('uploadConfig', () => {
    it('should upload config to S3', async () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [],
      };

      const s3Key = await client.uploadConfig('https://example.com/page1', config);

      expect(s3Key).to.equal('opportunities/example.com/L3BhZ2Ux');
      expect(s3Client.send).to.have.been.calledOnce;

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-bucket');
      expect(command.input.Key).to.equal('opportunities/example.com/L3BhZ2Ux');
      expect(command.input.ContentType).to.equal('application/json');
      expect(JSON.parse(command.input.Body)).to.deep.equal(config);
    });

    it('should upload config to preview bucket', async () => {
      const config = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [],
      };

      const s3Key = await client.uploadConfig('https://example.com/page1', config, true);

      expect(s3Key).to.equal('preview/opportunities/example.com/L3BhZ2Ux');

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-preview-bucket');
      expect(command.input.Key).to.equal('preview/opportunities/example.com/L3BhZ2Ux');
    });

    it('should throw error if URL is missing', async () => {
      const config = { url: 'https://example.com/page1', patches: [] };

      try {
        await client.uploadConfig('', config);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('URL is required');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error if config is empty', async () => {
      try {
        await client.uploadConfig('https://example.com/page1', {});
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Config object is required');
        expect(error.status).to.equal(400);
      }
    });

    it('should handle S3 upload failure', async () => {
      s3Client.send.rejects(new Error('Network error'));
      const config = { url: 'https://example.com/page1', patches: [] };

      try {
        await client.uploadConfig('https://example.com/page1', config);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('S3 upload failed');
        expect(error.status).to.equal(500);
      }
    });
  });

  describe('fetchConfig', () => {
    it('should fetch existing config from S3', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Old Heading',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      s3Client.send.resolves({
        Body: {
          transformToString: async () => JSON.stringify(existingConfig),
        },
      });

      const config = await client.fetchConfig('https://example.com/page1');

      expect(config).to.deep.equal(existingConfig);
      expect(s3Client.send).to.have.been.calledOnce;

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-bucket');
      expect(command.input.Key).to.equal('opportunities/example.com/L3BhZ2Ux');
    });

    it('should fetch config from preview bucket', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [],
      };

      s3Client.send.resolves({
        Body: {
          transformToString: async () => JSON.stringify(existingConfig),
        },
      });

      await client.fetchConfig('https://example.com/page1', true);

      const command = s3Client.send.firstCall.args[0];
      expect(command.input.Bucket).to.equal('test-preview-bucket');
      expect(command.input.Key).to.equal('preview/opportunities/example.com/L3BhZ2Ux');
    });

    it('should return null if config does not exist', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      s3Client.send.rejects(noSuchKeyError);

      const config = await client.fetchConfig('https://example.com/page1');

      expect(config).to.be.null;
    });

    it('should return null if S3 returns NoSuchKey error code', async () => {
      const noSuchKeyError = new Error('The specified key does not exist');
      noSuchKeyError.Code = 'NoSuchKey';
      s3Client.send.rejects(noSuchKeyError);

      const config = await client.fetchConfig('https://example.com/page1');

      expect(config).to.be.null;
    });

    it('should throw error if URL is missing', async () => {
      try {
        await client.fetchConfig('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('URL is required');
        expect(error.status).to.equal(400);
      }
    });

    it('should handle S3 fetch failure', async () => {
      s3Client.send.rejects(new Error('Network error'));

      try {
        await client.fetchConfig('https://example.com/page1');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('S3 fetch failed');
        expect(error.status).to.equal(500);
      }
    });
  });

  describe('mergeConfigs', () => {
    let existingConfig;
    let newConfig;

    beforeEach(() => {
      existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Old Heading',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
          {
            op: 'replace',
            selector: 'h2',
            value: 'Old Subtitle',
            opportunityId: 'opp-456',
            suggestionId: 'sugg-2',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      newConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Updated Heading',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567900,
          },
        ],
      };
    });

    it('should return new config if existing config is null', () => {
      const merged = client.mergeConfigs(null, newConfig);

      expect(merged).to.deep.equal(newConfig);
    });

    it('should update existing patch with same opportunityId and suggestionId', () => {
      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(2);

      // First patch should be updated
      const updatedPatch = merged.patches[0];
      expect(updatedPatch.value).to.equal('Updated Heading');
      expect(updatedPatch.lastUpdated).to.equal(1234567900);

      // Second patch should remain unchanged
      const unchangedPatch = merged.patches[1];
      expect(unchangedPatch.value).to.equal('Old Subtitle');
      expect(unchangedPatch.opportunityId).to.equal('opp-456');
    });

    it('should add new patch if opportunityId and suggestionId do not exist', () => {
      newConfig.patches.push({
        op: 'replace',
        selector: 'h3',
        value: 'New Section Title',
        opportunityId: 'opp-789',
        suggestionId: 'sugg-3',
        prerenderRequired: true,
        lastUpdated: 1234567900,
      });

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(3);

      // New patch should be added at the end
      const newPatch = merged.patches[2];
      expect(newPatch.value).to.equal('New Section Title');
      expect(newPatch.opportunityId).to.equal('opp-789');
      expect(newPatch.suggestionId).to.equal('sugg-3');
    });

    it('should update config metadata from new config', () => {
      newConfig.version = '2.0';
      newConfig.forceFail = true;

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.version).to.equal('2.0');
      expect(merged.forceFail).to.equal(true);
    });

    it('should handle empty patches array in existing config', () => {
      existingConfig.patches = [];

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(1);
      expect(merged.patches[0].value).to.equal('Updated Heading');
    });

    it('should handle empty patches array in new config', () => {
      newConfig.patches = [];

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(2);
      expect(merged.patches[0].value).to.equal('Old Heading');
    });

    it('should handle undefined patches in existing config', () => {
      existingConfig.patches = undefined;

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(1);
      expect(merged.patches[0].value).to.equal('Updated Heading');
    });

    it('should handle undefined patches in new config', () => {
      newConfig.patches = undefined;

      const merged = client.mergeConfigs(existingConfig, newConfig);

      expect(merged.patches).to.have.length(2);
      expect(merged.patches[0].value).to.equal('Old Heading');
    });
  });

  describe('deploySuggestions', () => {
    beforeEach(() => {
      // Stub CDN invalidation for deploy tests
      sinon.stub(client, 'invalidateCdnCache').resolves({
        status: 'success',
        provider: 'cloudfront',
        invalidationId: 'I123',
      });
      // Stub fetchConfig to return null by default (no existing config)
      sinon.stub(client, 'fetchConfig').resolves(null);
      // Stub fetchMetaconfig to return null by default (will create new)
      sinon.stub(client, 'fetchMetaconfig').resolves(null);
      // Stub uploadMetaconfig
      sinon.stub(client, 'uploadMetaconfig').resolves('opportunities/example.com/config');
    });

    it('should deploy suggestions successfully', async () => {
      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result).to.have.property('s3Paths');
      expect(result.s3Paths).to.be.an('array').with.length(1);
      expect(result.s3Paths[0]).to.equal('opportunities/example.com/L3BhZ2Ux');
      expect(result).to.have.property('cdnInvalidations');
      expect(result.cdnInvalidations).to.be.an('array').with.length(1);
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.failedSuggestions).to.have.length(0);
      expect(s3Client.send).to.have.been.called;
    });

    it('should create metaconfig on first deployment', async () => {
      await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(client.fetchMetaconfig).to.have.been.calledOnce;
      expect(client.uploadMetaconfig).to.have.been.calledOnce;

      const metaconfigArg = client.uploadMetaconfig.firstCall.args[1];
      expect(metaconfigArg).to.deep.include({
        siteId: 'site-123',
        prerender: true,
      });
    });

    it('should reuse existing metaconfig', async () => {
      client.fetchMetaconfig.resolves({
        siteId: 'site-123',
        prerender: true,
      });

      await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(client.fetchMetaconfig).to.have.been.calledOnce;
      expect(client.uploadMetaconfig).to.not.have.been.called;
    });

    it('should handle suggestions for multiple URLs', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'Page 1 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page2',
            recommendedAction: 'Page 2 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
      ];

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.s3Paths).to.have.length(2);
      expect(result.cdnInvalidations).to.have.length(2);
      expect(result.succeededSuggestions).to.have.length(2);
    });

    it('should handle suggestions that are not eligible for deployment', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-missing', // Not eligible
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-empty', // Eligible
            transformRules: {
              action: 'replace',
              selector: 'h2',
            },
          }),
        },
      ];

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(1);
      expect(result.failedSuggestions).to.have.length(1);
      expect(result.failedSuggestions[0].reason).to.include('can be deployed');
    });

    it('should handle multi-URL deploy where one URL has no eligible suggestions', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-empty', // Eligible
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({
            url: 'https://example.com/page2',
            recommendedAction: 'New Heading',
            checkType: 'heading-missing', // Not eligible
          }),
        },
      ];

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(1);
      expect(result.failedSuggestions).to.have.length(1);
      expect(result.failedSuggestions[0].suggestion.getId()).to.equal('sugg-2');
    });

    it('should skip URL when generateConfig returns no patches', async () => {
      // Stub mapper to return empty patches for the first call, normal for subsequent calls
      const mapper = client.mapperRegistry.getMapper('headings');
      const originalSuggestionsToPatches = mapper.suggestionsToPatches.bind(mapper);
      let callCount = 0;
      sinon.stub(mapper, 'suggestionsToPatches').callsFake((...args) => {
        callCount += 1;
        if (callCount === 1) {
          // First call (for page1) returns no patches
          return [];
        }
        // Subsequent calls work normally
        return originalSuggestionsToPatches(...args);
      });

      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page2',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h2',
            },
          }),
        },
      ];

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      // Both suggestions are in result but sugg-1 skipped deployment due to no patches
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.s3Paths).to.have.length(1); // Only one URL actually deployed
    });

    it('should return early when no eligible suggestions', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-missing', // Wrong checkType name, not eligible
          }),
        },
      ];

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(0);
      expect(result.failedSuggestions).to.have.length(1);
      expect(log.warn).to.have.been.calledWith('No eligible suggestions to deploy');
      expect(s3Client.send).to.not.have.been.called;
    });

    it('should throw error for unsupported opportunity type', async () => {
      mockOpportunity.getType = () => 'unsupported-type';

      try {
        await client.deploySuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('No mapper found for opportunity type: unsupported-type');
        expect(error.status).to.equal(501);
      }
    });

    it('should fetch existing config and merge when deploying', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h3',
            value: 'Existing Heading',
            opportunityId: 'opp-999',
            suggestionId: 'sugg-999',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      client.fetchConfig.resolves(existingConfig);

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(client.fetchConfig).to.have.been.called;
      expect(result.s3Paths).to.have.length(1);

      // Verify the uploaded config contains both existing and new patches
      const uploadedConfig = JSON.parse(s3Client.send.firstCall.args[0].input.Body);
      expect(uploadedConfig.patches).to.have.length(3);
    });

    it('should update existing patch when deploying same opportunityId and suggestionId', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Old Heading Value',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      client.fetchConfig.resolves(existingConfig);

      const result = await client.deploySuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.s3Paths).to.have.length(1);

      // Verify the patch was updated, not duplicated
      const uploadedConfig = JSON.parse(s3Client.send.firstCall.args[0].input.Body);
      expect(uploadedConfig.patches).to.have.length(2);

      // First patch should be updated with new value
      const updatedPatch = uploadedConfig.patches[0];
      expect(updatedPatch.value).to.equal('New Heading');
      expect(updatedPatch.opportunityId).to.equal('opp-123');
      expect(updatedPatch.suggestionId).to.equal('sugg-1');
      expect(updatedPatch.lastUpdated).to.be.greaterThan(1234567890);
    });
  });

  describe('rollbackSuggestions', () => {
    beforeEach(() => {
      // Stub CDN invalidation for rollback tests
      sinon.stub(client, 'invalidateCdnCache').resolves({
        status: 'success',
        provider: 'cloudfront',
        invalidationId: 'I123',
      });
    });

    it('should rollback suggestions successfully', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Heading 1',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
          {
            op: 'replace',
            selector: 'h2',
            value: 'Heading 2',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-2',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
          {
            op: 'replace',
            selector: 'h3',
            value: 'Heading 3',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-3',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      sinon.stub(client, 'fetchConfig').resolves(existingConfig);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions, // Only sugg-1 and sugg-2
      );

      expect(result.s3Paths).to.have.length(1);
      expect(result.s3Paths[0]).to.equal('opportunities/example.com/L3BhZ2Ux');
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.failedSuggestions).to.have.length(0);
      expect(result.removedPatchesCount).to.equal(2);

      // Verify uploaded config has sugg-3 but not sugg-1 and sugg-2
      const uploadedConfig = JSON.parse(s3Client.send.firstCall.args[0].input.Body);
      expect(uploadedConfig.patches).to.have.length(1);
      expect(uploadedConfig.patches[0].suggestionId).to.equal('sugg-3');
    });

    it('should handle no existing config gracefully', async () => {
      sinon.stub(client, 'fetchConfig').resolves(null);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      // Code continues and marks eligible suggestions as succeeded even if no config found
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.failedSuggestions).to.have.length(0);
      expect(result.s3Paths).to.have.length(0);
      expect(s3Client.send).to.not.have.been.called;
    });

    it('should handle empty existing config patches', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [],
      };

      sinon.stub(client, 'fetchConfig').resolves(existingConfig);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      // Code marks eligible suggestions as succeeded even if no patches to remove
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.failedSuggestions).to.have.length(0);
      expect(result.s3Paths).to.have.length(0);
      expect(s3Client.send).to.not.have.been.called;
    });

    it('should handle suggestions not found in config', async () => {
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Heading',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-999', // Different suggestion ID
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      sinon.stub(client, 'fetchConfig').resolves(existingConfig);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      // Code marks eligible suggestions as succeeded even if patches not found
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.failedSuggestions).to.have.length(0);
      expect(result.s3Paths).to.have.length(0);
      expect(s3Client.send).to.not.have.been.called;
    });

    it('should return early when all suggestions are ineligible for rollback', async () => {
      const ineligibleSuggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-missing', // Not eligible
          }),
        },
        {
          getId: () => 'sugg-2',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Subtitle',
            checkType: 'heading-wrong', // Not eligible
          }),
        },
      ];

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        ineligibleSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(0);
      expect(result.failedSuggestions).to.have.length(2);
      expect(s3Client.send).to.not.have.been.called;
    });

    it('should delete config file when all patches are rolled back', async () => {
      // Code uploads empty config instead of deleting
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Heading 1',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      sinon.stub(client, 'fetchConfig').resolves(existingConfig);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        [mockSuggestions[0]], // Only roll back sugg-1 (all patches for this URL)
      );

      expect(result.succeededSuggestions).to.have.length(1);
      expect(result.removedPatchesCount).to.equal(1);

      // Code uploads empty patches array instead of deleting
      expect(s3Client.send).to.have.been.calledOnce;
      const command = s3Client.send.firstCall.args[0];
      expect(command.constructor.name).to.equal('PutObjectCommand');
      expect(command.input.Key).to.equal('opportunities/example.com/L3BhZ2Ux');
    });

    it('should handle rollback for multiple URLs', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'Page 1 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page2',
            recommendedAction: 'Page 2 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
      ];

      const config1 = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Heading 1',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-1',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      const config2 = {
        url: 'https://example.com/page2',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'h1',
            value: 'Heading 2',
            opportunityId: 'opp-123',
            suggestionId: 'sugg-2',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      sinon.stub(client, 'fetchConfig')
        .onFirstCall()
        .resolves(config1)
        .onSecondCall()
        .resolves(config2);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.s3Paths).to.have.length(2);
      expect(result.cdnInvalidations).to.have.length(2);
      expect(result.succeededSuggestions).to.have.length(2);
    });

    it('should throw error for unsupported opportunity type', async () => {
      mockOpportunity.getType = () => 'unsupported-type';

      try {
        await client.rollbackSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('No mapper found for opportunity type: unsupported-type');
        expect(error.status).to.equal(501);
      }
    });

    it('should remove FAQ heading patch when rolling back last FAQ suggestion', async () => {
      // Change opportunity to FAQ type
      mockOpportunity.getType = () => 'faq';

      // Create FAQ suggestion
      const faqSuggestion = {
        getId: () => 'faq-sugg-1',
        getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
        getData: () => ({
          url: 'https://example.com/page1',
          shouldOptimize: true,
          item: {
            question: 'What is this?',
            answer: 'This is a FAQ',
          },
          transformRules: {
            action: 'appendChild',
            selector: 'body',
          },
        }),
      };

      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            opportunityId: 'opp-123',
            // FAQ heading patch (no suggestionId)
            op: 'appendChild',
            selector: 'body',
            value: { type: 'element', tagName: 'h2', children: [{ type: 'text', value: 'FAQs' }] },
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
          {
            opportunityId: 'opp-123',
            suggestionId: 'faq-sugg-1',
            op: 'appendChild',
            selector: 'body',
            value: { type: 'element', tagName: 'div' },
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      sinon.stub(client, 'fetchConfig').resolves(existingConfig);

      const result = await client.rollbackSuggestions(
        mockSite,
        mockOpportunity,
        [faqSuggestion],
      );

      expect(result.succeededSuggestions).to.have.length(1);
      expect(result.removedPatchesCount).to.equal(2); // FAQ item + heading

      // Code uploads empty config instead of deleting
      const command = s3Client.send.firstCall.args[0];
      expect(command.constructor.name).to.equal('PutObjectCommand');
    });
  });

  describe('previewSuggestions', () => {
    let fetchStub;

    beforeEach(() => {
      // Stub global fetch for HTML fetching
      fetchStub = sinon.stub(global, 'fetch');
      // Mock fetch responses for HTML fetching (warmup + actual for both original and optimized)
      fetchStub.resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => (name === 'x-tokowaka-cache' ? 'HIT' : null),
        },
        text: async () => '<html><body>Test HTML</body></html>',
      });

      // Stub CDN invalidation for preview tests
      sinon.stub(client, 'invalidateCdnCache').resolves({
        status: 'success',
        provider: 'cloudfront',
        invalidationId: 'I123',
      });

      // Stub fetchConfig to return null by default (no existing config)
      sinon.stub(client, 'fetchConfig').resolves(null);

      // Add TOKOWAKA_EDGE_URL to env
      client.env.TOKOWAKA_EDGE_URL = 'https://edge-dev.tokowaka.now';
    });

    afterEach(() => {
      // fetchStub will be restored by global afterEach sinon.restore()
      // Just clean up env changes
      delete client.env.TOKOWAKA_EDGE_URL;
    });

    it('should preview suggestions successfully with HTML', async () => {
      const result = await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
        { warmupDelayMs: 0 },
      );

      expect(result).to.have.property('s3Path', 'preview/opportunities/example.com/L3BhZ2Ux');
      expect(result).to.have.property('succeededSuggestions');
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result).to.have.property('failedSuggestions');
      expect(result.failedSuggestions).to.have.length(0);
      expect(result).to.have.property('html');
      expect(result.html).to.have.property('url', 'https://example.com/page1');
      expect(result.html).to.have.property('originalHtml');
      expect(result.html).to.have.property('optimizedHtml');
      expect(result.html.originalHtml).to.equal('<html><body>Test HTML</body></html>');
      expect(result.html.optimizedHtml).to.equal('<html><body>Test HTML</body></html>');

      // Verify fetch was called for HTML fetching
      // (4 times: warmup + actual for original and optimized)
      expect(fetchStub.callCount).to.equal(4);
      expect(s3Client.send).to.have.been.calledOnce;
    });

    it('should throw error if TOKOWAKA_EDGE_URL is not configured', async () => {
      delete client.env.TOKOWAKA_EDGE_URL;

      try {
        await client.previewSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('TOKOWAKA_EDGE_URL is required for preview');
        expect(error.status).to.equal(500);
      }
    });

    it('should throw error if site does not have forwardedHost', async () => {
      mockSite.getConfig = () => ({
        getTokowakaConfig: () => ({}),
      });

      try {
        await client.previewSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Site does not have a Tokowaka API key or forwarded host configured');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error if getTokowakaConfig returns null', async () => {
      mockSite.getConfig = () => ({
        getTokowakaConfig: () => null,
      });

      try {
        await client.previewSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Site does not have a Tokowaka API key or forwarded host configured');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error for unsupported opportunity type', async () => {
      mockOpportunity.getType = () => 'unsupported-type';

      try {
        await client.previewSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('No mapper found for opportunity type');
        expect(error.status).to.equal(501);
      }
    });

    it('should handle ineligible suggestions', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-missing', // Not eligible
          }),
        },
      ];

      const result = await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(0);
      expect(result.failedSuggestions).to.have.length(1);
      expect(result.config).to.be.null;
    });

    it('should return early when generateConfig returns no patches', async () => {
      // Stub mapper to return eligible but no patches
      const mapper = client.mapperRegistry.getMapper('headings');
      sinon.stub(mapper, 'suggestionsToPatches').returns([]);

      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'New Heading',
            checkType: 'heading-empty', // Eligible
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
      ];

      const result = await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
      );

      expect(result.succeededSuggestions).to.have.length(0);
      expect(result.failedSuggestions).to.have.length(1);
      expect(result.config).to.be.null;
    });

    it('should throw error when preview URL not found in suggestion data', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            // URL missing
            recommendedAction: 'New Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
      ];

      try {
        await client.previewSuggestions(mockSite, mockOpportunity, mockSuggestions);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Preview URL not found in suggestion data');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error when HTML fetch fails', async () => {
      fetchStub.rejects(new Error('Network timeout'));

      try {
        await client.previewSuggestions(
          mockSite,
          mockOpportunity,
          mockSuggestions,
          { warmupDelayMs: 0 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Preview failed: Unable to fetch HTML');
        expect(error.status).to.equal(500);
      }
    });

    it('should merge with existing deployed patches for the same URL', async () => {
      // Setup existing config with deployed patches
      const existingConfig = {
        url: 'https://example.com/page1',
        version: '1.0',
        forceFail: false,
        prerender: true,
        patches: [
          {
            op: 'replace',
            selector: 'title',
            value: 'Deployed Title',
            opportunityId: 'opp-456',
            suggestionId: 'sugg-deployed',
            prerenderRequired: true,
            lastUpdated: 1234567890,
          },
        ],
      };

      client.fetchConfig.resolves(existingConfig);

      const result = await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
        { warmupDelayMs: 0 },
      );

      expect(result.succeededSuggestions).to.have.length(2);

      // Verify config was uploaded with merged patches
      const uploadedConfig = JSON.parse(s3Client.send.firstCall.args[0].input.Body);
      expect(uploadedConfig.patches).to.have.length(3);

      // Should have existing deployed patch + 2 new preview patches
      const deployedPatch = uploadedConfig.patches
        .find((p) => p.suggestionId === 'sugg-deployed');
      expect(deployedPatch).to.exist;
      expect(deployedPatch.value).to.equal('Deployed Title');
    });

    it('should upload config to preview S3 path', async () => {
      await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
        { warmupDelayMs: 0 },
      );

      expect(s3Client.send).to.have.been.calledOnce;

      const putCommand = s3Client.send.firstCall.args[0];
      expect(putCommand.input.Bucket).to.equal('test-preview-bucket');
      expect(putCommand.input.Key).to.equal('preview/opportunities/example.com/L3BhZ2Ux');
    });

    it('should invalidate CDN cache for preview path', async () => {
      await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
        { warmupDelayMs: 0 },
      );

      expect(client.invalidateCdnCache).to.have.been.calledOnce;
      const { firstCall } = client.invalidateCdnCache;
      expect(firstCall.args[0]).to.equal('https://example.com/page1');
      expect(firstCall.args[1]).to.equal('cloudfront');
      expect(firstCall.args[2]).to.be.true; // isPreview
    });

    it('should throw error if suggestions span multiple URLs', async () => {
      mockSuggestions = [
        {
          getId: () => 'sugg-1',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page1',
            recommendedAction: 'Page 1 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
        {
          getId: () => 'sugg-2',
          getUpdatedAt: () => '2025-01-15T10:00:00.000Z',
          getData: () => ({
            url: 'https://example.com/page2', // Different URL
            recommendedAction: 'Page 2 Heading',
            checkType: 'heading-empty',
            transformRules: {
              action: 'replace',
              selector: 'h1',
            },
          }),
        },
      ];

      // Code doesn't validate multi-URL, silently uses first URL
      // fetchConfig and invalidateCdnCache already stubbed in beforeEach
      // Only need to stub uploadConfig
      sinon.stub(client, 'uploadConfig').resolves('preview/opportunities/example.com/L3BhZ2Ux');

      const result = await client.previewSuggestions(
        mockSite,
        mockOpportunity,
        mockSuggestions,
        { warmupDelayMs: 0 },
      );

      // Preview succeeds, using first URL only
      expect(result.succeededSuggestions).to.have.length(2);
      expect(result.config.url).to.equal('https://example.com/page1');
    });
  });

  describe('invalidateCdnCache', () => {
    let mockCdnClient;

    beforeEach(() => {
      mockCdnClient = {
        invalidateCache: sinon.stub().resolves({
          status: 'success',
          provider: 'cloudfront',
          invalidationId: 'I123',
        }),
      };

      sinon.stub(client.cdnClientRegistry, 'getClient').returns(mockCdnClient);
    });

    it('should invalidate CDN cache successfully', async () => {
      const result = await client.invalidateCdnCache('https://example.com/page1', 'cloudfront');

      expect(result).to.deep.equal({
        status: 'success',
        provider: 'cloudfront',
        invalidationId: 'I123',
      });

      expect(mockCdnClient.invalidateCache).to.have.been.calledWith([
        '/opportunities/example.com/L3BhZ2Ux',
      ]);
      expect(log.debug).to.have.been.calledWith(sinon.match(/Invalidating CDN cache/));
      expect(log.info).to.have.been.calledWith(sinon.match(/CDN cache invalidation completed/));
    });

    it('should invalidate CDN cache for preview path', async () => {
      await client.invalidateCdnCache('https://example.com/page1', 'cloudfront', true);

      expect(mockCdnClient.invalidateCache).to.have.been.calledWith([
        '/preview/opportunities/example.com/L3BhZ2Ux',
      ]);
    });

    it('should throw error if URL is missing', async () => {
      try {
        await client.invalidateCdnCache('', 'cloudfront');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('URL and provider are required');
        expect(error.status).to.equal(400);
      }
    });

    it('should throw error if provider is missing', async () => {
      try {
        await client.invalidateCdnCache('https://example.com/page1', '');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('URL and provider are required');
        expect(error.status).to.equal(400);
      }
    });

    it('should return error object if no CDN client available', async () => {
      client.cdnClientRegistry.getClient.returns(null);

      const result = await client.invalidateCdnCache('https://example.com/page1', 'cloudfront');

      expect(result).to.deep.equal({
        status: 'error',
        provider: 'cloudfront',
        message: 'No CDN client available for provider: cloudfront',
      });
      expect(log.error).to.have.been.calledWith(sinon.match(/Failed to invalidate Tokowaka CDN cache/));
    });

    it('should return error object if CDN invalidation fails', async () => {
      mockCdnClient.invalidateCache.rejects(new Error('CDN API error'));

      const result = await client.invalidateCdnCache('https://example.com/page1', 'cloudfront');

      expect(result).to.deep.equal({
        status: 'error',
        provider: 'cloudfront',
        message: 'CDN API error',
      });

      expect(log.error).to.have.been.calledWith(sinon.match(/Failed to invalidate Tokowaka CDN cache/));
    });
  });
});
