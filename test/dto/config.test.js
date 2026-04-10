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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import { ConfigDto } from '../../src/dto/config.js';

describe('ConfigDto', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns null when config is nullish', () => {
    expect(ConfigDto.toJSON(null)).to.equal(null);
    expect(ConfigDto.toJSON(undefined)).to.equal(null);
  });

  it('returns sanitized config without brandProfile', () => {
    const fakeConfig = {
      foo: 'bar',
    };
    const toJSONStub = sinon.stub(Config, 'toDynamoItem').returns({
      foo: 'bar',
      brandProfile: { discovery: {} },
    });

    const result = ConfigDto.toJSON(fakeConfig);

    expect(result).to.deep.equal({ foo: 'bar' });
    expect(toJSONStub.calledOnceWithExactly(fakeConfig)).to.be.true;
  });

  describe('toListJSON', () => {
    it('returns null when config is nullish', () => {
      expect(ConfigDto.toListJSON(null)).to.equal(null);
      expect(ConfigDto.toListJSON(undefined)).to.equal(null);
    });

    it('returns null when toDynamoItem returns null', () => {
      sinon.stub(Config, 'toDynamoItem').returns(null);
      expect(ConfigDto.toListJSON({ some: 'config' })).to.equal(null);
    });

    it('returns null when config has no UI-relevant keys', () => {
      sinon.stub(Config, 'toDynamoItem').returns({
        brandProfile: { large: 'data' },
        contentAiConfig: { some: 'value' },
        cdnLogsConfig: { bucket: 'test' },
      });
      expect(ConfigDto.toListJSON({ some: 'config' })).to.equal(null);
    });

    it('returns only UI-relevant config keys', () => {
      sinon.stub(Config, 'toDynamoItem').returns({
        llmo: {
          dataFolder: '/data',
          brand: 'TestBrand',
          tags: ['tag1'],
          customerIntent: [{ key: 'intent1' }],
          detectedCdn: 'aem-cs-fastly',
          someInternalField: 'should-be-excluded',
        },
        edgeOptimizeConfig: { enabled: true, opted: 1, stagingDomains: [{ domain: 'stage.example.com', id: 'abc' }] },
        slack: { channel: '#test', workspace: 'T123' },
        brandConfig: { brandId: 'brand-123' },
        fetchConfig: { overrideBaseURL: 'https://override.example.com' },
        handlers: { 'meta-tags': { excludedURLs: ['/excluded'] } },
        brandProfile: { large: 'data' },
        contentAiConfig: { some: 'value' },
        cdnLogsConfig: { bucket: 'test' },
      });

      const result = ConfigDto.toListJSON({ some: 'config' });

      expect(result).to.deep.equal({
        llmo: {
          dataFolder: '/data',
          brand: 'TestBrand',
          tags: ['tag1'],
          customerIntent: [{ key: 'intent1' }],
          detectedCdn: 'aem-cs-fastly',
        },
        edgeOptimizeConfig: { enabled: true, opted: 1, stagingDomains: [{ domain: 'stage.example.com', id: 'abc' }] },
        slack: { channel: '#test', workspace: 'T123' },
        brandConfig: { brandId: 'brand-123' },
        fetchConfig: { overrideBaseURL: 'https://override.example.com' },
        handlers: { 'meta-tags': { excludedURLs: ['/excluded'] } },
      });

      expect(result).to.not.have.property('brandProfile');
      expect(result).to.not.have.property('contentAiConfig');
      expect(result).to.not.have.property('cdnLogsConfig');
      expect(result.llmo).to.not.have.property('someInternalField');
      expect(result.edgeOptimizeConfig).to.have.property('stagingDomains');
    });

    it('handles partial config with only llmo', () => {
      sinon.stub(Config, 'toDynamoItem').returns({
        llmo: { dataFolder: '/data', brand: 'Test' },
      });

      const result = ConfigDto.toListJSON({ some: 'config' });
      expect(result).to.deep.equal({
        llmo: { dataFolder: '/data', brand: 'Test' },
      });
    });

    it('includes detectedCdn other in toListJSON', () => {
      sinon.stub(Config, 'toDynamoItem').returns({
        llmo: { dataFolder: '/data', brand: 'Test', detectedCdn: 'other' },
      });

      const result = ConfigDto.toListJSON({ some: 'config' });
      expect(result).to.deep.equal({
        llmo: { dataFolder: '/data', brand: 'Test', detectedCdn: 'other' },
      });
    });

    it('includes full edgeOptimizeConfig when present', () => {
      sinon.stub(Config, 'toDynamoItem').returns({
        edgeOptimizeConfig: { opted: 1, stagingDomains: [{ domain: 'stage.example.com', id: 'abc' }] },
        slack: { channel: '#test' },
      });

      const result = ConfigDto.toListJSON({ some: 'config' });
      expect(result).to.deep.equal({
        edgeOptimizeConfig: { opted: 1, stagingDomains: [{ domain: 'stage.example.com', id: 'abc' }] },
        slack: { channel: '#test' },
      });
    });
  });
});
