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
import { gunzipSync } from 'node:zlib';
import { KEYWORD_INTENT_ENUM } from '@quazar/ai-seo-ts/v2/fanout/enums_pb.js';

use(sinonChai);

const ORG_ID = '5d4e5082-b030-433d-9dbd-7007116f701f';
const BRAND_ID = '3e3556f0-6494-4e8f-858f-01f2c358861a';

function dbTopic(overrides = {}) {
  return {
    topicUuid: '11111111-1111-7111-8111-111111111111',
    topicId: 'best-crm',
    name: 'Best CRM',
    description: null,
    promptsTotal: 10,
    mentionRate: 0.5,
    citationRate: 0.1,
    ...overrides,
  };
}

function semTopic(overrides = {}) {
  return {
    originalTopic: 'Best CRM',
    matchedTopicId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    matchedTopicName: 'Best CRM',
    similarityScore: 90,
    metrics: { volume: 1000n },
    fanoutQueries: [],
    ...overrides,
  };
}

function fanoutQuery(overrides = {}) {
  return {
    keyword: 'best crm for smb',
    intents: [KEYWORD_INTENT_ENUM.COMMERCIAL],
    volume: 100,
    rankings: [
      { domain: 'hubspot.com', position: 1 },
      { domain: 'acme.com', position: 3 },
    ],
    ...overrides,
  };
}

describe('curateFanoutReport', () => {
  let sandbox;
  let mockFetchFanoutTopics;
  let mockResolveTopicMetricsBatched;
  let mockGetBrandById;
  let curate;

  before(async () => {
    const stubs = {
      fetchFanoutTopics: sinon.stub(),
      resolveTopicMetricsBatched: sinon.stub(),
      getBrandById: sinon.stub(),
    };
    mockFetchFanoutTopics = stubs.fetchFanoutTopics;
    mockResolveTopicMetricsBatched = stubs.resolveTopicMetricsBatched;
    mockGetBrandById = stubs.getBrandById;

    const mod = await esmock('../../../src/support/fanout/curate.js', {
      '../../../src/support/fanout/topics-rpc.js': {
        fetchFanoutTopics: (...args) => mockFetchFanoutTopics(...args),
      },
      '../../../src/support/fanout/semrush-client.js': {
        resolveTopicMetricsBatched: (...args) => mockResolveTopicMetricsBatched(...args),
        intentNameFromEnum: (intents) => {
          if (!Array.isArray(intents) || intents.length === 0) {
            return undefined;
          }
          const NAME = {
            [KEYWORD_INTENT_ENUM.UNSPECIFIED]: 'UNSPECIFIED',
            [KEYWORD_INTENT_ENUM.COMMERCIAL]: 'COMMERCIAL',
            [KEYWORD_INTENT_ENUM.INFORMATIONAL]: 'INFORMATIONAL',
            [KEYWORD_INTENT_ENUM.NAVIGATIONAL]: 'NAVIGATIONAL',
            [KEYWORD_INTENT_ENUM.TRANSACTIONAL]: 'TRANSACTIONAL',
          };
          return NAME[intents[0]] ?? 'UNSPECIFIED';
        },
      },
      '../../../src/support/brands-storage.js': {
        getBrandById: (...args) => mockGetBrandById(...args),
      },
    });
    curate = mod;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockFetchFanoutTopics.reset();
    mockResolveTopicMetricsBatched.reset();
    mockGetBrandById.reset();

    mockGetBrandById.resolves({
      name: 'Acme',
      urls: [{ value: 'https://acme.com' }],
      baseUrl: 'https://acme.com',
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  const callerArgs = (overrides = {}) => ({
    organizationId: ORG_ID,
    brandId: BRAND_ID,
    country: 1, // COUNTRY_ENUM.US (don't care which int)
    llm: 1, // LLM_ENUM.CHAT_GPT (don't care which int)
    countryName: 'US',
    llmName: 'chatgpt',
    windowDays: 7,
    postgrestClient: { rpc: sinon.stub() },
    fanoutClient: { resolveTopicMetrics: sinon.stub() },
    concurrency: 5,
    batchSize: 100,
    log: { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() },
    ...overrides,
  });

  it('returns an empty report when the brand has no tracked topics', async () => {
    mockFetchFanoutTopics.resolves([]);

    const { report, stats } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics).to.deep.equal([]);
    expect(report.brandName).to.equal('Acme');
    expect(report.brandDomains).to.deep.equal(['acme.com']);
    expect(report.country).to.equal('US');
    expect(report.llm).to.equal('chatgpt');
    expect(stats.dbTopics).to.equal(0);
    expect(stats.semrushReturned).to.equal(0);
    expect(mockResolveTopicMetricsBatched).not.to.have.been.called;
  });

  it('drops topics with similarityScore < 70', async () => {
    mockFetchFanoutTopics.resolves([
      dbTopic({ name: 'A' }),
      dbTopic({ name: 'B', topicUuid: '22222222-2222-7222-8222-222222222222' }),
    ]);
    const byOriginal = new Map([
      ['A', semTopic({ originalTopic: 'A', similarityScore: 50 })], // dropped
      ['B', semTopic({ originalTopic: 'B', similarityScore: 80 })], // kept
    ]);
    mockResolveTopicMetricsBatched.resolves({ byOriginal, isoDate: '2026-05-08' });

    const { report, stats } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics).to.have.length(1);
    expect(report.topics[0].name).to.equal('B');
    expect(stats.similarityPassed).to.equal(1);
  });

  it('keeps top 5 by priorityScore desc when more than 5 pass similarity', async () => {
    const topics = Array.from({ length: 7 }, (_, i) => dbTopic({
      name: `T${i}`,
      topicUuid: `${i}1111111-1111-7111-8111-111111111111`,
      // citationRate ascending — index 0 has highest priority after × volume
      citationRate: i * 0.1,
    }));
    mockFetchFanoutTopics.resolves(topics);

    const byOriginal = new Map(topics.map((t, i) => [
      t.name,
      semTopic({
        originalTopic: t.name,
        similarityScore: 90,
        // volume ascending — but priority = volume × (1 − citationRate)
        // makes the middle indices the highest-priority winners.
        metrics: { volume: BigInt(1000 + i * 100) },
      }),
    ]));
    mockResolveTopicMetricsBatched.resolves({ byOriginal, isoDate: '2026-05-08' });

    const { report, stats } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics).to.have.length(5);
    // priorityScore descending
    for (let i = 1; i < report.topics.length; i += 1) {
      expect(report.topics[i].priorityScore).to.be.at.most(report.topics[i - 1].priorityScore);
    }
    expect(stats.topicsPicked).to.equal(5);
  });

  it('treats null citationRate as 0 in priorityScore', async () => {
    mockFetchFanoutTopics.resolves([
      dbTopic({ name: 'NoData', citationRate: null }),
    ]);
    mockResolveTopicMetricsBatched.resolves({
      byOriginal: new Map([
        ['NoData', semTopic({ originalTopic: 'NoData', metrics: { volume: 2000n } })],
      ]),
      isoDate: '2026-05-08',
    });

    const { report } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics[0].priorityScore).to.equal(2000);
    expect(report.topics[0].citationRate).to.equal(null);
  });

  it('computes brandPosition as the lowest position across all brand domains', async () => {
    mockGetBrandById.resolves({
      name: 'Acme',
      urls: [
        { value: 'https://acme.com' },
        { value: 'https://blog.acme.com' },
      ],
      baseUrl: 'https://acme.com',
    });
    mockFetchFanoutTopics.resolves([dbTopic()]);
    mockResolveTopicMetricsBatched.resolves({
      byOriginal: new Map([['Best CRM', semTopic({
        fanoutQueries: [
          fanoutQuery({
            rankings: [
              { domain: 'hubspot.com', position: 1 },
              { domain: 'blog.acme.com', position: 3 },
              { domain: 'acme.com', position: 7 },
            ],
          }),
        ],
      })]]),
      isoDate: '2026-05-08',
    });

    const { report } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics[0].subQueries[0].brandPosition).to.equal(3);
  });

  it('omits the intent field when Semrush returns no intents', async () => {
    mockFetchFanoutTopics.resolves([dbTopic()]);
    mockResolveTopicMetricsBatched.resolves({
      byOriginal: new Map([['Best CRM', semTopic({
        fanoutQueries: [fanoutQuery({ intents: [] })],
      })]]),
      isoDate: '2026-05-08',
    });

    const { report } = await curate.curateFanoutReport(callerArgs());

    expect(report.topics[0].subQueries[0]).not.to.have.property('intent');
  });

  it('falls back to brand.baseUrl when brand.urls is empty', async () => {
    mockGetBrandById.resolves({
      name: 'Acme',
      urls: [],
      baseUrl: 'https://acme.com',
    });
    mockFetchFanoutTopics.resolves([]);

    const { report } = await curate.curateFanoutReport(callerArgs());

    expect(report.brandDomains).to.deep.equal(['acme.com']);
  });

  it('reports brandDomains: [] when neither urls nor baseUrl is set', async () => {
    mockGetBrandById.resolves({ name: '', urls: [], baseUrl: null });
    mockFetchFanoutTopics.resolves([]);

    const { report } = await curate.curateFanoutReport(callerArgs());

    expect(report.brandDomains).to.deep.equal([]);
  });
});

describe('extractDomain / brandDomainsFromBrand / brandPositionOf', () => {
  let helpers;

  before(async () => {
    helpers = await esmock('../../../src/support/fanout/curate.js', {
      '../../../src/support/fanout/topics-rpc.js': { fetchFanoutTopics: sinon.stub() },
      '../../../src/support/fanout/semrush-client.js': {
        resolveTopicMetricsBatched: sinon.stub(),
        intentNameFromEnum: () => 'COMMERCIAL',
      },
      '../../../src/support/brands-storage.js': { getBrandById: sinon.stub() },
    });
  });

  describe('extractDomain', () => {
    it('strips leading www.', () => {
      expect(helpers.extractDomain('https://www.acme.com/x')).to.equal('acme.com');
    });
    it('keeps non-www subdomains', () => {
      expect(helpers.extractDomain('https://blog.acme.com/x')).to.equal('blog.acme.com');
    });
    it('prepends https:// when no scheme', () => {
      expect(helpers.extractDomain('acme.com')).to.equal('acme.com');
    });
    it('returns null for null/empty/whitespace input', () => {
      expect(helpers.extractDomain(null)).to.equal(null);
      expect(helpers.extractDomain('')).to.equal(null);
      expect(helpers.extractDomain('   ')).to.equal(null);
    });
  });

  describe('brandDomainsFromBrand', () => {
    it('prefers urls[] over baseUrl', () => {
      expect(helpers.brandDomainsFromBrand({
        urls: [{ value: 'https://blog.acme.com' }],
        baseUrl: 'https://acme.com',
      })).to.deep.equal(['blog.acme.com']);
    });
    it('falls back to baseUrl only when urls[] yields no valid hostnames', () => {
      expect(helpers.brandDomainsFromBrand({
        urls: [{ value: '' }, { value: null }],
        baseUrl: 'https://acme.com',
      })).to.deep.equal(['acme.com']);
    });
    it('returns [] when neither produces a domain', () => {
      expect(helpers.brandDomainsFromBrand({ urls: [], baseUrl: null })).to.deep.equal([]);
    });
    it('dedupes the urls[] extraction', () => {
      expect(helpers.brandDomainsFromBrand({
        urls: [
          { value: 'https://acme.com' },
          { value: 'https://www.acme.com' }, // same after www-strip
        ],
        baseUrl: null,
      })).to.deep.equal(['acme.com']);
    });
  });

  describe('brandPositionOf', () => {
    it('returns null when no brand domain appears', () => {
      expect(helpers.brandPositionOf(
        [{ domain: 'foo.com', position: 1 }],
        new Set(['acme.com']),
      )).to.equal(null);
    });
    it('returns the lowest matching position', () => {
      expect(helpers.brandPositionOf(
        [
          { domain: 'acme.com', position: 5 },
          { domain: 'blog.acme.com', position: 2 },
          { domain: 'acme.com', position: 9 },
        ],
        new Set(['acme.com', 'blog.acme.com']),
      )).to.equal(2);
    });
  });

  describe('gzipReport', () => {
    it('round-trips through gunzip', () => {
      const report = { schemaVersion: 1, topics: [] };
      const buf = helpers.gzipReport(report);
      expect(buf).to.be.instanceOf(Buffer);
      expect(JSON.parse(gunzipSync(buf).toString('utf-8'))).to.deep.equal(report);
    });
  });
});
