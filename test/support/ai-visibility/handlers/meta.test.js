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
import { handleMeta } from '../../../../src/support/ai-visibility/handlers/meta.js';
import { COUNTRY_ENUM } from '../../../../src/support/ai-visibility/grpc-utils.js';

describe('AI Visibility – meta handler', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      brandClient: {
        statsByLLM: sandbox.stub(),
        statsByCountry: sandbox.stub(),
        topBrandsByDomain: sandbox.stub(),
        brandsByTopicFTS: sandbox.stub(),
        brandsByTopicFTSTotals: sandbox.stub(),
      },
      topicClient: {
        brandTopics: sandbox.stub(),
        brandTopicsTotals: sandbox.stub(),
        gapTopics: sandbox.stub(),
        gapTopicsTotals: sandbox.stub(),
        topicsByFTS: sandbox.stub(),
        metricsByFTS: sandbox.stub(),
        metricsByFTSGroupedByLLM: sandbox.stub(),
      },
      promptClient: {
        prompts: sandbox.stub(),
        promptsTotals: sandbox.stub(),
        gapPrompts: sandbox.stub(),
        gapPromptsTotals: sandbox.stub(),
        promptsByTopicFTS: sandbox.stub(),
        promptsByTopicFTSTotals: sandbox.stub(),
      },
      sourceClient: {
        sources: sandbox.stub(),
        sourceDomains: sandbox.stub(),
        gapSourceDomains: sandbox.stub(),
        gapSourceDomainsTotals: sandbox.stub(),
        sourceDomainsByTopicFTS: sandbox.stub(),
        sourceDomainsByTopicFTSTotals: sandbox.stub(),
      },
      competitorClient: { brandCompetitors: sandbox.stub() },
      crMetricsClient: { stats: sandbox.stub() },
      crMetaClient: { meta: sandbox.stub() },
      voSourcesClient: { sourcesTotals: sandbox.stub(), domainsTotals: sandbox.stub() },
      prRelationsClient: { prompt: sandbox.stub() },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleMeta', () => {
    it('returns 200 with countries array with mapped fields', async () => {
      clients.crMetaClient.meta.resolves({
        countries: [
          {
            country: COUNTRY_ENUM.US, daily: ['2026-05-01'], monthly: ['2026-05'], isComingSoon: false,
          },
          {
            country: COUNTRY_ENUM.UK, daily: [], monthly: ['2026-04'], isComingSoon: true,
          },
        ],
      });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.countries).to.have.length(2);
      expect(res.body.countries[0].daily).to.deep.equal(['2026-05-01']);
      expect(res.body.countries[0].monthly).to.deep.equal(['2026-05']);
      expect(res.body.countries[0].isComingSoon).to.equal(false);
      expect(res.body.countries[1].isComingSoon).to.equal(true);
    });

    it('handles empty countries array', async () => {
      clients.crMetaClient.meta.resolves({ countries: [] });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.countries).to.deep.equal([]);
    });

    it('handles unknown country enum values', async () => {
      clients.crMetaClient.meta.resolves({
        countries: [{
          country: 99999, daily: [], monthly: [], isComingSoon: false,
        }],
      });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.countries).to.have.length(1);
      expect(res.body.countries[0].countryCode).to.equal('99999');
    });

    it('handles missing isComingSoon', async () => {
      clients.crMetaClient.meta.resolves({
        countries: [{ country: COUNTRY_ENUM.US, daily: [], monthly: [] }],
      });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.body.countries[0].isComingSoon).to.equal(false);
    });

    it('maps known country enum to its string name', async () => {
      clients.crMetaClient.meta.resolves({
        countries: [{
          country: COUNTRY_ENUM.UK, daily: [], monthly: [], isComingSoon: false,
        }],
      });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.body.countries[0].countryCode).to.be.a('string');
    });

    it('handles missing daily/monthly arrays', async () => {
      clients.crMetaClient.meta.resolves({
        countries: [{ country: COUNTRY_ENUM.US }],
      });
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.body.countries[0].daily).to.deep.equal([]);
      expect(res.body.countries[0].monthly).to.deep.equal([]);
    });

    it('handles raw.countries being undefined', async () => {
      clients.crMetaClient.meta.resolves({});
      const sp = new URLSearchParams('');
      const res = await handleMeta(sp, clients);
      expect(res.body.countries).to.deep.equal([]);
    });
  });
});
