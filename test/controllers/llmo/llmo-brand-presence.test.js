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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  createFilterDimensionsHandler,
  strCompare,
  toFilterOption,
  validateSiteBelongsToOrg,
} from '../../../src/controllers/llmo/llmo-brand-presence.js';

use(sinonChai);

function createChainableMock(resolveValue = { data: [], error: null }, resolveSequence = null) {
  const limitStub = resolveSequence
    ? sinon.stub()
      .onFirstCall()
      .resolves(resolveSequence[0] ?? resolveValue)
      .onSecondCall()
      .resolves(resolveSequence[1] ?? { data: [], error: null })
      .onThirdCall()
      .resolves(resolveSequence[2] ?? { data: [], error: null })
    : sinon.stub().resolves(resolveValue);
  const c = {
    from: sinon.stub().returnsThis(),
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    in: sinon.stub().returnsThis(),
    ilike: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    not: sinon.stub().returnsThis(),
    or: sinon.stub().returnsThis(),
    filter: sinon.stub().returnsThis(),
    limit: limitStub,
    then(resolve) { return Promise.resolve(resolveValue).then(resolve); },
  };
  return c;
}

describe('llmo-brand-presence', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;
  let mockClient;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: {
        spaceCatId: '0178a3f0-1234-7000-8000-000000000001',
        brandId: 'all',
      },
      data: {},
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: {
          postgrestService: null,
        },
      },
    };
    mockClient = createChainableMock();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('strCompare', () => {
    it('handles null/undefined first arg (uses empty string fallback)', () => {
      expect(strCompare(null, 'b')).to.be.lessThan(0);
      expect(strCompare(undefined, 'b')).to.be.lessThan(0);
      expect(strCompare('', 'b')).to.be.lessThan(0);
    });

    it('handles null/undefined second arg (uses empty string fallback)', () => {
      expect(strCompare('a', null)).to.be.greaterThan(0);
      expect(strCompare('a', undefined)).to.be.greaterThan(0);
      expect(strCompare('a', '')).to.be.greaterThan(0);
    });

    it('handles both null/undefined (both become empty string)', () => {
      expect(strCompare(null, null)).to.equal(0);
      expect(strCompare(undefined, undefined)).to.equal(0);
    });

    it('compares truthy strings normally', () => {
      expect(strCompare('a', 'b')).to.be.lessThan(0);
      expect(strCompare('b', 'a')).to.be.greaterThan(0);
    });
  });

  describe('toFilterOption', () => {
    it('handles null id (uses empty string fallback)', () => {
      expect(toFilterOption(null, 'Label')).to.deep.equal({ id: '', label: 'Label' });
    });

    it('handles null label (uses id fallback)', () => {
      expect(toFilterOption('id-1', null)).to.deep.equal({ id: 'id-1', label: 'id-1' });
    });

    it('handles both null (uses empty string fallbacks)', () => {
      expect(toFilterOption(null, null)).to.deep.equal({ id: '', label: '' });
    });

    it('handles undefined id and label', () => {
      expect(toFilterOption(undefined, undefined)).to.deep.equal({ id: '', label: '' });
    });

    it('returns id and label when both provided', () => {
      expect(toFilterOption('id-1', 'Label')).to.deep.equal({ id: 'id-1', label: 'Label' });
    });
  });

  describe('validateSiteBelongsToOrg', () => {
    it('returns true when siteId is null (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', null);
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is undefined (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', undefined);
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is empty string (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', '');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is "all" (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', 'all');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is "*" (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', '*');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });
  });

  describe('createFilterDimensionsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: 0178a3f0-1234-7000-8000-000000000001'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when generic error is thrown', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Database connection failed'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.calledWith('Brand presence filter-dimensions error: Database connection failed');
    });

    it('returns badRequest when executions query returns error', async () => {
      const queryError = { message: 'relation "brand_presence_executions" does not exist' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: queryError },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation "brand_presence_executions" does not exist');
    });

    it('handles executions query returning data: null (uses empty rows fallback)', async () => {
      const emptySites = { data: [], error: null };
      const emptyPageIntents = { data: [], error: null };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [{ data: null, error: null }, emptySites, emptyPageIntents],
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.deep.equal([]);
      expect(body.categories).to.deep.equal([]);
      expect(body.page_intents).to.deep.equal([]);
    });

    it('skips filter when categoryId is "all" (SKIP_VALUES)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'all' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).not.to.have.been.calledWith('category_id', sinon.match.any);
      expect(chainMock.eq).not.to.have.been.calledWith('category_name', sinon.match.any);
    });

    it('handles null/undefined context.data (uses empty object fallback)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('accepts snake_case params (start_date, end_date, model, site_id, etc.)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        model: 'gemini',
        site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
        category_id: '0178a3f0-1234-7000-8000-000000000099',
        topic_id: 't1',
        region_code: 'US',
        user_intent: 'TRANSACTIONAL',
        prompt_branding: 'true',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.gte).to.have.been.calledWith('execution_date', '2025-01-01');
      expect(chainMock.lte).to.have.been.calledWith('execution_date', '2025-01-31');
      expect(chainMock.eq).to.have.been.calledWith('model', 'gemini');
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'cccdac43-1a22-4659-9086-b762f59b9928');
    });

    it('returns ok with brands, categories, topics, origins, regions, page_intents', async () => {
      const brandData = {
        data: [
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000002',
            brand_name: 'Brand A',
            category_name: 'Cat1',
            topics: 't1',
            region_code: 'US',
            origin: 'human',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000003',
            brand_name: 'Brand B',
            category_name: 'Cat2',
            topics: 't2',
            region_code: 'DE',
            origin: 'ai',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
        ],
        error: null,
      };
      const sitesData = {
        data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
        error: null,
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        brandData,
        [brandData, sitesData, pageIntentsData],
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.have.lengthOf(2);
      expect(body.brands[0]).to.have.property('id');
      expect(body.brands[0]).to.have.property('label');
      expect(body.categories).to.have.lengthOf(2);
      expect(body.topics).to.have.lengthOf(2);
      expect(body.origins).to.have.lengthOf(2);
      expect(body.regions).to.have.lengthOf(2);
      expect(body.page_intents).to.have.lengthOf(2);
      expect(body.page_intents[0]).to.have.property('id');
      expect(body.page_intents[0]).to.have.property('label');
    });

    it('filters by brandId when single brand route', async () => {
      const brandData = {
        data: [
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000002',
            brand_name: 'Brand A',
            category_name: 'Cat1',
            topics: 't1',
            region_code: 'US',
            origin: 'human',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
        ],
        error: null,
      };
      const pageIntentsData = { data: [{ page_intent: 'TRANSACTIONAL' }], error: null };
      const chainMock = createChainableMock(brandData, [brandData, pageIntentsData]);
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(chainMock.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000002');
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: '0178a3f0-1234-7000-8000-000000000099' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_id', '0178a3f0-1234-7000-8000-000000000099');
    });

    it('filters by category_name when categoryId is not a UUID (e.g. Acrobat)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'Acrobat' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_name', 'Acrobat');
    });

    it('filters by topicId when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicId: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('topics', 'combine pdf');
    });

    it('accepts topic/topics as fallback for topicId', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topic: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('topics', 'combine pdf');
    });

    it('filters by regionCode when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { regionCode: 'US' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('region_code', 'US');
    });

    it('filters by origin when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { origin: 'ai' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.ilike).to.have.been.calledWith('origin', 'ai');
    });

    it('includes page_intents from page_intents table when siteId is provided', async () => {
      const brandData = { data: [], error: null };
      const sitesValidation = { data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }], error: null };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      const chainMock = createChainableMock(brandData, [
        brandData,
        sitesValidation,
        pageIntentsData,
      ]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.page_intents).to.have.lengthOf(2);
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'cccdac43-1a22-4659-9086-b762f59b9928');
    });

    it('returns 403 when siteId does not belong to the organization', async () => {
      const brandData = { data: [], error: null };
      const sitesValidation = { data: [], error: null };
      const chainMock = createChainableMock(brandData, [brandData, sitesValidation]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Site does not belong to the organization');
    });

    it('dedupes origins after lowercasing (Human and human become one)', async () => {
      const brandData = {
        data: [
          {
            brand_id: 'b1',
            brand_name: 'B1',
            category_name: 'C1',
            topics: 't1',
            region_code: 'US',
            origin: 'Human',
            site_id: 's1',
          },
          {
            brand_id: 'b2',
            brand_name: 'B2',
            category_name: 'C2',
            topics: 't2',
            region_code: 'DE',
            origin: 'human',
            site_id: 's1',
          },
          {
            brand_id: 'b3',
            brand_name: 'B3',
            category_name: 'C3',
            topics: 't3',
            region_code: 'WW',
            origin: 'ai',
            site_id: 's1',
          },
        ],
        error: null,
      };
      const sitesData = { data: [{ id: 's1' }], error: null };
      const pageIntentsData = { data: [{ page_intent: 'TRANSACTIONAL' }], error: null };
      const chainMock = createChainableMock(brandData, [brandData, sitesData, pageIntentsData]);
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.origins).to.have.lengthOf(2);
      const originIds = body.origins.map((o) => o.id).sort();
      expect(originIds).to.deep.equal(['ai', 'human']);
    });
  });
});
