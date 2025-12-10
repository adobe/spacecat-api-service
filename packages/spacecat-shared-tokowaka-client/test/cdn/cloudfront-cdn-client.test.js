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
import { mockClient } from 'aws-sdk-client-mock';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import CloudFrontCdnClient from '../../src/cdn/cloudfront-cdn-client.js';

use(sinonChai);

describe('CloudFrontCdnClient', () => {
  let client;
  let log;
  let cloudFrontMock;

  beforeEach(() => {
    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    };

    // Mock the CloudFront SDK client
    cloudFrontMock = mockClient(CloudFrontClient);
  });

  afterEach(() => {
    // Reset all mocks
    cloudFrontMock.reset();
    sinon.restore();
  });

  describe('constructor', () => {
    it('should throw error for invalid JSON in TOKOWAKA_CDN_CONFIG', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: 'invalid-json{',
      };

      expect(() => new CloudFrontCdnClient(env, log))
        .to.throw('Invalid TOKOWAKA_CDN_CONFIG: must be valid JSON');
    });

    it('should throw error when cloudfront config is missing', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          someOtherProvider: {},
        }),
      };

      expect(() => new CloudFrontCdnClient(env, log))
        .to.throw("Missing 'cloudfront' config in TOKOWAKA_CDN_CONFIG");
    });
  });

  describe('getProviderName', () => {
    it('should return cloudfront', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      expect(client.getProviderName()).to.equal('cloudfront');
    });
  });

  describe('validateConfig', () => {
    it('should return true for valid config with only distributionId', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      expect(client.validateConfig()).to.be.true;
    });

    it('should return true for valid config with credentials', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      expect(client.validateConfig()).to.be.true;
    });

    it('should return false if distributionId is missing', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            region: 'us-east-1',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      const result = client.validateConfig();

      expect(result).to.be.false;
      expect(log.error).to.have.been.calledWith(
        'CloudFront CDN config missing required fields: distributionId and region',
      );
    });
  });

  describe('invalidateCache', () => {
    beforeEach(() => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);
    });

    it('should invalidate cache successfully', async () => {
      const mockResponse = {
        Invalidation: {
          Id: 'I2J4EXAMPLE',
          Status: 'InProgress',
          CreateTime: new Date('2025-01-15T10:30:00.000Z'),
        },
      };
      cloudFrontMock.on(CreateInvalidationCommand).resolves(mockResponse);

      const paths = ['/path1', '/path2'];
      const result = await client.invalidateCache(paths);

      expect(result).to.deep.include({
        status: 'success',
        provider: 'cloudfront',
        invalidationId: 'I2J4EXAMPLE',
        invalidationStatus: 'InProgress',
        createTime: mockResponse.Invalidation.CreateTime,
        paths: 2,
      });

      expect(log.debug).to.have.been.calledWith(sinon.match(/Initiating CloudFront cache invalidation/));
      expect(log.info).to.have.been.calledWith(sinon.match(/CloudFront cache invalidation initiated/));
      expect(log.info).to.have.been.calledWith(sinon.match(/took \d+ms/));
    });

    it('should format paths to start with /', async () => {
      const mockResponse = {
        Invalidation: {
          Id: 'I2J4EXAMPLE',
          Status: 'InProgress',
          CreateTime: new Date(),
        },
      };
      cloudFrontMock.on(CreateInvalidationCommand).resolves(mockResponse);

      const paths = ['path1', '/path2', 'path3'];
      await client.invalidateCache(paths);

      const calls = cloudFrontMock.commandCalls(CreateInvalidationCommand);
      expect(calls).to.have.length(1);
      expect(calls[0].args[0].input.InvalidationBatch.Paths.Items).to.deep.equal([
        '/path1',
        '/path2',
        '/path3',
      ]);
    });

    it('should throw error if config is invalid', async () => {
      client.cdnConfig = {};

      try {
        await client.invalidateCache(['/path1']);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('Invalid CloudFront CDN configuration');
      }
    });

    it('should return skipped result if paths array is empty', async () => {
      const result = await client.invalidateCache([]);

      expect(result).to.deep.equal({
        status: 'skipped',
        message: 'No paths to invalidate',
      });
      expect(log.warn).to.have.been.calledWith('No paths provided for cache invalidation');

      // Verify no CloudFront commands were sent
      const calls = cloudFrontMock.commandCalls(CreateInvalidationCommand);
      expect(calls).to.have.length(0);
    });

    it('should return skipped result if paths is not an array', async () => {
      const result = await client.invalidateCache(null);

      expect(result).to.deep.equal({
        status: 'skipped',
        message: 'No paths to invalidate',
      });
      expect(log.warn).to.have.been.calledWith('No paths provided for cache invalidation');
    });

    it('should throw error on CloudFront API failure', async () => {
      cloudFrontMock.on(CreateInvalidationCommand).rejects(new Error('CloudFront API error'));

      try {
        await client.invalidateCache(['/path1']);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('CloudFront API error');
        expect(log.error).to.have.been.calledWith(sinon.match(/Failed to invalidate CloudFront cache after \d+ms/));
      }
    });
  });

  describe('client initialization', () => {
    it('should initialize client with explicit credentials', async () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-west-2',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            sessionToken: 'SESSION_TOKEN',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      // Client should be null initially
      expect(client.client).to.be.null;

      // Mock successful invalidation
      cloudFrontMock.on(CreateInvalidationCommand).resolves({
        Invalidation: {
          Id: 'I123',
          Status: 'InProgress',
          CreateTime: new Date(),
        },
      });

      await client.invalidateCache(['/test']);

      // Verify the command was called
      const calls = cloudFrontMock.commandCalls(CreateInvalidationCommand);
      expect(calls).to.have.length(1);
    });

    it('should initialize client without credentials (Lambda role)', async () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      // Client should be null initially
      expect(client.client).to.be.null;

      // Mock successful invalidation
      cloudFrontMock.on(CreateInvalidationCommand).resolves({
        Invalidation: {
          Id: 'I123',
          Status: 'InProgress',
          CreateTime: new Date(),
        },
      });

      await client.invalidateCache(['/test']);

      // Verify the command was called
      const calls = cloudFrontMock.commandCalls(CreateInvalidationCommand);
      expect(calls).to.have.length(1);
    });

    it('should lazy-initialize CloudFront client on first use', () => {
      const env = {
        TOKOWAKA_CDN_CONFIG: JSON.stringify({
          cloudfront: {
            distributionId: 'E123456',
            region: 'us-east-1',
          },
        }),
      };
      client = new CloudFrontCdnClient(env, log);

      // Client should be null initially - it's lazy-initialized on first use
      expect(client.client).to.be.null;

      // The #initializeClient() method is called internally by invalidateCache()
      // and getInvalidationStatus(), which we test in other test cases.
      // Those tests verify the client gets created when needed.
    });
  });
});
