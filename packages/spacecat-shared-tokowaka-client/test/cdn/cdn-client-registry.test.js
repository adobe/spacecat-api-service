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
/* eslint-disable max-classes-per-file */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import CdnClientRegistry from '../../src/cdn/cdn-client-registry.js';
import CloudFrontCdnClient from '../../src/cdn/cloudfront-cdn-client.js';
import BaseCdnClient from '../../src/cdn/base-cdn-client.js';

use(sinonChai);

describe('CdnClientRegistry', () => {
  let registry;
  let log;
  let env;

  beforeEach(() => {
    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    env = {
      TOKOWAKA_CDN_CONFIG: JSON.stringify({
        cloudfront: {
          distributionId: 'E123456',
          region: 'us-east-1',
        },
      }),
    };

    registry = new CdnClientRegistry(env, log);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should create an instance and register default clients', () => {
      expect(registry).to.be.instanceOf(CdnClientRegistry);
      expect(registry.clients).to.be.instanceOf(Map);
      expect(registry.clients.size).to.be.greaterThan(0);
    });
  });

  describe('registerClient', () => {
    it('should register a custom CDN client', () => {
      class CustomCdnClient extends BaseCdnClient {}

      registry.registerClient('custom', CustomCdnClient);

      expect(registry.clients.has('custom')).to.be.true;
      expect(registry.getSupportedProviders()).to.include('custom');
    });

    it('should register client with case-insensitive provider name', () => {
      class CustomCdnClient extends BaseCdnClient {}

      registry.registerClient('CUSTOM', CustomCdnClient);

      expect(registry.clients.has('custom')).to.be.true;
    });
  });

  describe('getClient', () => {
    it('should return CloudFront client for cloudfront provider', () => {
      const client = registry.getClient('cloudfront');

      expect(client).to.be.instanceOf(CloudFrontCdnClient);
      expect(client.cdnConfig).to.deep.equal({
        distributionId: 'E123456',
        region: 'us-east-1',
      });
    });

    it('should be case-insensitive for provider names', () => {
      const client = registry.getClient('CloudFront');

      expect(client).to.be.instanceOf(CloudFrontCdnClient);
    });

    it('should return null if provider is not specified', () => {
      const client = registry.getClient('');

      expect(client).to.be.null;
      expect(log.warn).to.have.been.calledWith('No CDN provider specified');
    });

    it('should return null if provider is null', () => {
      const client = registry.getClient(null);

      expect(client).to.be.null;
      expect(log.warn).to.have.been.calledWith('No CDN provider specified');
    });

    it('should return null for unsupported provider', () => {
      const client = registry.getClient('unsupported-provider');

      expect(client).to.be.null;
      expect(log.warn).to.have.been.calledWith(
        'No CDN client found for provider: unsupported-provider',
      );
    });

    it('should handle client creation errors gracefully', () => {
      class FailingCdnClient extends BaseCdnClient {
        constructor() {
          throw new Error('Construction failed');
        }
      }

      registry.registerClient('failing', FailingCdnClient);

      const client = registry.getClient('failing');

      expect(client).to.be.null;
      expect(log.error).to.have.been.calledWith(
        sinon.match(/Failed to create CDN client for failing/),
      );
    });
  });

  describe('getSupportedProviders', () => {
    it('should return list of supported providers', () => {
      const providers = registry.getSupportedProviders();

      expect(providers).to.be.an('array');
      expect(providers).to.include('cloudfront');
    });

    it('should include custom registered providers', () => {
      class CustomCdnClient extends BaseCdnClient {}

      registry.registerClient('custom', CustomCdnClient);

      const providers = registry.getSupportedProviders();

      expect(providers).to.include('custom');
      expect(providers).to.include('cloudfront');
    });
  });

  describe('isProviderSupported', () => {
    it('should return true for supported provider', () => {
      expect(registry.isProviderSupported('cloudfront')).to.be.true;
    });

    it('should return true for supported provider (case-insensitive)', () => {
      expect(registry.isProviderSupported('CloudFront')).to.be.true;
    });

    it('should return false for unsupported provider', () => {
      expect(registry.isProviderSupported('unsupported')).to.be.false;
    });

    it('should return false for null provider', () => {
      expect(registry.isProviderSupported(null)).to.be.false;
    });

    it('should return false for undefined provider', () => {
      expect(registry.isProviderSupported(undefined)).to.be.false;
    });
  });
});
