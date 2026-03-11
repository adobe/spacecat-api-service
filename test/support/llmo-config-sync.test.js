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
import esmock from 'esmock';

describe('LLMO Config Sync', () => {
  let sandbox;
  let syncV2ToV1Sites;
  let syncV1ToV2;
  let mockLlmoConfig;
  let mockConvertV2ToV1;
  let mockConvertV1ToV2;
  let mockMergeCustomerConfigV2;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockLlmoConfig = {
      writeConfig: sandbox.stub().resolves({ version: 'v1' }),
      readCustomerConfigV2: sandbox.stub().resolves(null),
      writeCustomerConfigV2: sandbox.stub().resolves(),
    };
    mockConvertV2ToV1 = sandbox.stub().returns({
      categories: {}, topics: {}, brands: { aliases: [] },
    });
    mockConvertV1ToV2 = sandbox.stub().returns({
      customer: {
        brands: [{ id: 'brand-1', name: 'Test' }],
        imsOrgID: 'ims@org',
      },
    });
    mockMergeCustomerConfigV2 = sandbox.stub().returns({
      mergedConfig: { customer: { brands: [], categories: [], topics: [] } },
    });

    const mod = await esmock('../../src/support/llmo-config-sync.js', {
      '@adobe/spacecat-shared-utils': {
        hasText: (s) => typeof s === 'string' && s.length > 0,
        llmoConfig: mockLlmoConfig,
      },
      '../../src/support/customer-config-mapper.js': {
        convertV1ToV2: mockConvertV1ToV2,
        convertV2ToV1: mockConvertV2ToV1,
      },
      '../../src/support/customer-config-v2-metadata.js': {
        mergeCustomerConfigV2: mockMergeCustomerConfigV2,
      },
    });
    syncV2ToV1Sites = mod.syncV2ToV1Sites;
    syncV1ToV2 = mod.syncV1ToV2;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('syncV2ToV1Sites', () => {
    it('returns early when s3Client is missing', async () => {
      await syncV2ToV1Sites('org-1', { customer: { brands: [{ v1SiteId: 'site-1' }] } }, {});
      expect(mockLlmoConfig.writeConfig.called).to.be.false;
    });

    it('does nothing when no brands have v1SiteId', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      await syncV2ToV1Sites('org-1', { customer: { brands: [{ id: 'b1' }] } }, {
        s3Client: {},
        log,
      });
      expect(mockLlmoConfig.writeConfig.called).to.be.false;
      expect(log.info.called).to.be.false;
    });

    it('syncs each brand with v1SiteId and logs success', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const v2Config = {
        customer: {
          categories: [],
          topics: [],
          brands: [
            { id: 'b1', v1SiteId: 'site-1' },
            { id: 'b2', v1SiteId: 'site-2' },
          ],
        },
      };
      await syncV2ToV1Sites('org-1', v2Config, { s3Client: {}, s3Bucket: 'b', log });
      expect(mockConvertV2ToV1.calledTwice).to.be.true;
      expect(mockLlmoConfig.writeConfig.calledTwice).to.be.true;
      expect(mockLlmoConfig.writeConfig.firstCall.args[0]).to.equal('site-1');
      expect(mockLlmoConfig.writeConfig.secondCall.args[0]).to.equal('site-2');
      expect(log.info.calledTwice).to.be.true;
    });

    it('logs warn when one brand sync rejects and continues', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      mockLlmoConfig.writeConfig.onFirstCall().rejects(new Error('S3 error'));
      mockLlmoConfig.writeConfig.onSecondCall().resolves({ version: 'v1' });
      const v2Config = {
        customer: {
          categories: [],
          topics: [],
          brands: [
            { id: 'b1', v1SiteId: 'site-1' },
            { id: 'b2', v1SiteId: 'site-2' },
          ],
        },
      };
      await syncV2ToV1Sites('org-1', v2Config, { s3Client: {}, s3Bucket: 'b', log });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('site-1');
      expect(log.info.calledOnce).to.be.true;
    });

    it('logs warn with reason when rejection has no message (branch coverage)', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      mockLlmoConfig.writeConfig.rejects('non-Error rejection');
      const v2Config = {
        customer: {
          categories: [],
          topics: [],
          brands: [{ id: 'b1', v1SiteId: 'site-1' }],
        },
      };
      await syncV2ToV1Sites('org-1', v2Config, { s3Client: {}, s3Bucket: 'b', log });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('site-1');
    });

    it('does not call log when log is not provided', async () => {
      const v2Config = {
        customer: {
          categories: [],
          topics: [],
          brands: [{ id: 'b1', v1SiteId: 'site-1' }],
        },
      };
      await syncV2ToV1Sites('org-1', v2Config, { s3Client: {}, s3Bucket: 'b' });
      expect(mockLlmoConfig.writeConfig.calledOnce).to.be.true;
    });

    it('handles v2Config with no customer or brands (branch coverage)', async () => {
      await syncV2ToV1Sites('org-1', null, { s3Client: {} });
      await syncV2ToV1Sites('org-1', {}, { s3Client: {} });
      await syncV2ToV1Sites('org-1', { customer: {} }, { s3Client: {} });
      expect(mockLlmoConfig.writeConfig.called).to.be.false;
    });
  });

  describe('syncV1ToV2', () => {
    it('returns early when dataAccess or s3Client is missing', async () => {
      await syncV1ToV2('site-1', {}, {});
      await syncV1ToV2('site-1', {}, { dataAccess: {}, s3Client: null });
      await syncV1ToV2('site-1', {}, { dataAccess: { Site: {}, Organization: {} }, s3Client: {} });
      expect(mockLlmoConfig.readCustomerConfigV2.called).to.be.false;
    });

    it('returns early when site not found and logs', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().rejects(new Error('not found')) };
      const Organization = { findById: sandbox.stub() };
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        log,
      });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('site not found');
    });

    it('returns early when site is null', async () => {
      const Site = { findById: sandbox.stub().resolves(null) };
      const Organization = { findById: sandbox.stub() };
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
      });
      expect(mockLlmoConfig.readCustomerConfigV2.called).to.be.false;
    });

    it('returns early when organizationId is empty', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => '' }) };
      const Organization = { findById: sandbox.stub() };
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
      });
      expect(mockLlmoConfig.readCustomerConfigV2.called).to.be.false;
    });

    it('returns early when organization not found and logs', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().rejects(new Error('org not found')) };
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        log,
      });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('organization not found');
    });

    it('returns early when org is null', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves(null) };
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
      });
      expect(mockLlmoConfig.readCustomerConfigV2.called).to.be.false;
    });

    it('returns early when readCustomerConfigV2 throws and logs', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      mockLlmoConfig.readCustomerConfigV2.rejects(new Error('S3 read error'));
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
        log,
      });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('failed to read V2 config');
    });

    it('returns early when V2 has no brands', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      mockLlmoConfig.readCustomerConfigV2.resolves({ customer: { brands: [] } });
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
      });
      expect(mockConvertV1ToV2.called).to.be.false;
    });

    it('returns early when no brand matches site (v1SiteId or baseUrl)', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1', getBaseURL: () => 'https://site-url.com' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      mockLlmoConfig.readCustomerConfigV2.resolves({
        customer: {
          imsOrgID: 'ims@org',
          brands: [{ id: 'b1', v1SiteId: 'other-site', baseUrl: 'https://different.com' }],
        },
      });
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
      });
      expect(mockConvertV1ToV2.called).to.be.false;
    });

    it('finds brand by v1SiteId and syncs successfully', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{
            id: 'b1', name: 'Test', v1SiteId: 'site-1', baseUrl: null,
          }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      mockConvertV1ToV2.returns({
        customer: {
          brands: [{ id: 'converted-1', name: 'Test' }],
          imsOrgID: 'ims@org',
        },
      });

      await syncV1ToV2('site-1', { categories: {}, topics: {} }, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
        log,
        userId: 'user1',
      });

      expect(mockConvertV1ToV2.calledOnce).to.be.true;
      expect(mockMergeCustomerConfigV2.calledOnce).to.be.true;
      expect(mockLlmoConfig.writeCustomerConfigV2.calledOnce).to.be.true;
      expect(log.info.calledOnce).to.be.true;
      expect(log.info.firstCall.args[0]).to.include('site-1').and.to.include('org-1');
    });

    it('finds brand by baseUrl when getBaseURL is a function', async () => {
      const Site = {
        findById: sandbox.stub().resolves({
          getOrganizationId: () => 'org-1',
          getBaseURL: () => 'https://example.com',
        }),
      };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{
            id: 'b1', name: 'Test', v1SiteId: null, baseUrl: 'https://example.com',
          }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);

      await syncV1ToV2('site-1', { categories: {}, topics: {} }, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });

      expect(mockConvertV1ToV2.calledOnce).to.be.true;
    });

    it('leaves baseUrl undefined when getBaseURL is not a function (branch coverage)', async () => {
      const Site = {
        findById: sandbox.stub().resolves({
          getOrganizationId: () => 'org-1',
          getBaseURL: 'not-a-function',
        }),
      };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{
            id: 'b1', name: 'Test', v1SiteId: 'site-1', baseUrl: null,
          }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });
      expect(mockConvertV1ToV2.calledOnce).to.be.true;
    });

    it('merges multiple brands and only replaces matching one (branch coverage)', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [
            { id: 'b1', name: 'Test', v1SiteId: 'site-1' },
            { id: 'b2', name: 'Other', v1SiteId: 'site-2' },
          ],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      mockMergeCustomerConfigV2.returns({
        mergedConfig: {
          customer: {
            ...existingV2.customer,
            brands: [
              { id: 'b1', name: 'Test', v1SiteId: 'site-1' },
              { id: 'b2', name: 'Other', v1SiteId: 'site-2' },
            ],
          },
        },
      });

      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });

      const updatesArg = mockMergeCustomerConfigV2.firstCall.args[0];
      expect(updatesArg.customer.brands).to.have.lengthOf(2);
      expect(updatesArg.customer.brands[0].id).to.equal('b1');
      expect(updatesArg.customer.brands[1].id).to.equal('b2');
    });

    it('logs warn when sync throws non-Error (branch coverage)', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{ id: 'b1', name: 'Test', v1SiteId: 'site-1' }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      mockLlmoConfig.writeCustomerConfigV2.rejects('string error');

      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
        log,
      });

      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('Failed to sync V1 to V2');
    });

    it('uses org.getImsOrgId when imsOrgID missing on V2', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'fallback@org' }) };
      const existingV2 = {
        customer: {
          brands: [{ id: 'b1', name: 'Test', v1SiteId: 'site-1' }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);

      await syncV1ToV2('site-1', { categories: {}, topics: {} }, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });

      expect(mockConvertV1ToV2.calledOnce).to.be.true;
      expect(mockConvertV1ToV2.firstCall.args[2]).to.equal('fallback@org');
    });

    it('uses empty string when imsOrgID and org.getImsOrgId both missing (branch coverage)', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({}) };
      const existingV2 = {
        customer: {
          brands: [{ id: 'b1', name: 'Test', v1SiteId: 'site-1' }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);

      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });

      expect(mockConvertV1ToV2.calledOnce).to.be.true;
      expect(mockConvertV1ToV2.firstCall.args[2]).to.equal('');
    });

    it('logs warn with err when readCustomerConfigV2 rejects non-Error (branch coverage)', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      mockLlmoConfig.readCustomerConfigV2.rejects(123);
      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
        log,
      });
      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('123');
    });

    it('returns early when converted brand is missing', async () => {
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{ id: 'b1', name: 'Test', v1SiteId: 'site-1' }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      mockConvertV1ToV2.returns({ customer: { brands: [], imsOrgID: 'ims@org' } });

      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
      });

      expect(mockLlmoConfig.writeCustomerConfigV2.called).to.be.false;
    });

    it('logs warn when write or convert throws', async () => {
      const log = { info: sandbox.stub(), warn: sandbox.stub() };
      const Site = { findById: sandbox.stub().resolves({ getOrganizationId: () => 'org-1' }) };
      const Organization = { findById: sandbox.stub().resolves({ getImsOrgId: () => 'ims@org' }) };
      const existingV2 = {
        customer: {
          imsOrgID: 'ims@org',
          brands: [{ id: 'b1', name: 'Test', v1SiteId: 'site-1' }],
          categories: [],
          topics: [],
        },
      };
      mockLlmoConfig.readCustomerConfigV2.resolves(existingV2);
      mockLlmoConfig.writeCustomerConfigV2.rejects(new Error('write failed'));

      await syncV1ToV2('site-1', {}, {
        dataAccess: { Site, Organization },
        s3Client: {},
        s3Bucket: 'b',
        log,
      });

      expect(log.warn.calledOnce).to.be.true;
      expect(log.warn.firstCall.args[0]).to.include('Failed to sync V1 to V2');
    });
  });
});
