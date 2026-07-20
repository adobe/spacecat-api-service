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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { createElementsService } from '../../../src/support/elements/elements-service.js';
import { ELEMENT_IDS } from '../../../src/support/elements/element-ids.js';
import { INTENT_VALUE } from '../../../src/support/serenity/prompt-tags.js';

const INTENT_VALUES = Object.values(INTENT_VALUE);

use(chaiAsPromised);
use(sinonChai);

const RAW_BRANDS = {
  blocks: {
    value: [
      { value: 'Adobe' },
      { value: 'Nike' },
    ],
  },
};

const RAW_MARKETS = {
  blocks: {
    value: [
      { value: 'proj-1', label: 'US-en' },
      { value: 'proj-2', label: 'AU-en' },
    ],
  },
};

const RAW_TOPICS = {
  blocks: {
    value: [
      { value: 'topic__SEO' },
      { value: 'category__Firefly' },
      { value: 'intent__Informational' },
      { value: 'source__organic' },
      { value: 'type__branded' },
      { value: 'plain-tag' },
    ],
  },
};

describe('createElementsService', () => {
  let transport;
  let service;

  beforeEach(() => {
    transport = { fetchElement: sinon.stub() };
    service = createElementsService(transport);
  });

  describe('getUrlInspectorFilterDimensions', () => {
    beforeEach(() => {
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.TOPICS, sinon.match.any)
        .resolves(RAW_TOPICS);
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.BRANDS, sinon.match.any)
        .resolves(RAW_BRANDS);
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.MARKETS, sinon.match.any)
        .resolves(RAW_MARKETS);
    });

    it('calls fetchElement three times (topics, brands, markets)', async () => {
      await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(transport.fetchElement).to.have.been.calledThrice;
    });

    it('fetches TOPICS, BRANDS and MARKETS in parallel', async () => {
      await service.getUrlInspectorFilterDimensions('ws-1', {});
      const calledIds = transport.fetchElement.getCalls().map((c) => c.args[1]);
      expect(calledIds).to.include(ELEMENT_IDS.TOPICS);
      expect(calledIds).to.include(ELEMENT_IDS.BRANDS);
      expect(calledIds).to.include(ELEMENT_IDS.MARKETS);
    });

    it('returns an object with brands, regions, topics, categories, page_intents, origins, type, tags keys', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result).to.have.all.keys([
        'brands', 'regions', 'topics', 'categories', 'page_intents', 'origins', 'type', 'tags',
      ]);
    });

    it('groups unknown prefix__value tags under their own prefix key', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.type).to.deep.equal([{ id: 'type__branded', label: 'branded' }]);
    });

    it('ignores plain, separator-less tags (bare prefix declarations)', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.tags).to.deep.equal([]);
    });

    it('brands contains filter dimensions for each brand', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.brands).to.have.length(2);
      expect(result.brands[0]).to.deep.include({ id: 'Adobe', label: 'Adobe' });
    });

    it('regions contains transformed markets', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.regions).to.have.length(2);
      expect(result.regions[0].label).to.equal('US-en');
    });

    it('topics contains only topic__-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.topics).to.deep.equal([{ id: 'topic__SEO', label: 'SEO' }]);
    });

    it('categories contains only category__-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.categories).to.deep.equal([{ id: 'category__Firefly', label: 'Firefly' }]);
    });

    it('page_intents contains only intent__-prefixed entries with the original tag as id', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.page_intents).to.deep.equal([{ id: 'intent__Informational', label: 'Informational' }]);
    });

    it('origins contains only source__-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.origins).to.deep.equal([{ id: 'source__organic', label: 'organic' }]);
    });

    it('resolves spacecat_brand_id on brands when spacecatBrands are provided', async () => {
      const spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }];
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {}, spacecatBrands);
      const adobeBrand = result.brands.find((b) => b.label === 'Adobe');
      expect(adobeBrand.spacecat_brand_id).to.equal('brand-1');
    });

    it('uses empty payload for markets fetch (no brand filter)', async () => {
      await service.getUrlInspectorFilterDimensions('ws-1', { brand: 'Adobe' });
      const marketsCall = transport.fetchElement.getCalls()
        .find((c) => c.args[1] === ELEMENT_IDS.MARKETS);
      expect(marketsCall.args[2]).to.not.have.nested.property('filters.advanced');
    });

    it('propagates transport errors', async () => {
      transport.fetchElement.withArgs('ws-1', ELEMENT_IDS.TOPICS, sinon.match.any)
        .rejects(new Error('upstream failure'));
      await expect(service.getUrlInspectorFilterDimensions('ws-1', {}))
        .to.be.rejectedWith('upstream failure');
    });

    it('does not throw and does not corrupt the result prototype for Object.prototype-named tag prefixes', async () => {
      transport.fetchElement.withArgs('ws-1', ELEMENT_IDS.TOPICS, sinon.match.any).resolves({
        blocks: {
          value: [
            { value: 'constructor__evil' },
            { value: 'toString__harmless' },
          ],
        },
      });
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      // constructor is explicitly reserved (see getUrlInspectorFilterDimensions),
      // so it's routed into the generic `tags` array rather than becoming its own key.
      expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).to.equal(false);
      expect(result.tags).to.deep.equal([
        { id: 'constructor__evil', label: 'evil' },
      ]);
      // toString isn't in the reserved list, so it becomes its own dynamic group —
      // this is safe (a plain data property shadowing the inherited one), just unusual.
      expect(result.toString).to.deep.equal([{ id: 'toString__harmless', label: 'harmless' }]);
    });
  });

  describe('getPrompts', () => {
    const RAW_PROMPTS = {
      type: 'table',
      blocks: {
        data: [
          {
            primary_intent: 'informational',
            prompt: 'can i make ai influencer for free',
            prompt_topic: 'AI Instagram Influencers',
            volume: 2119,
          },
        ],
      },
    };

    beforeEach(() => {
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.PROMPTS, sinon.match.any)
        .resolves(RAW_PROMPTS);
    });

    it('fetches the PROMPTS element and returns { count, prompts }', async () => {
      const result = await service.getPrompts('ws-1', { tags: ['type__branded'], projectIds: ['proj-a'] });
      expect(transport.fetchElement).to.have.been.calledWith('ws-1', ELEMENT_IDS.PROMPTS, sinon.match.object);
      expect(result.count).to.equal(1);
      expect(result.prompts[0]).to.deep.include({ prompt_topic: 'AI Instagram Influencers', volume: 2119 });
    });

    it('passes the built filter payload to the transport', async () => {
      await service.getPrompts('ws-1', { model: 'perplexity' });
      const call = transport.fetchElement.getCalls().find((c) => c.args[1] === ELEMENT_IDS.PROMPTS);
      const modelClause = call.args[2].filters.advanced.filters
        .find((f) => f.filters?.[0]?.col === 'CBF_model');
      expect(modelClause.filters[0].val).to.equal('perplexity');
    });

    it('propagates transport errors', async () => {
      transport.fetchElement.withArgs('ws-1', ELEMENT_IDS.PROMPTS, sinon.match.any)
        .rejects(new Error('prompts upstream failure'));
      await expect(service.getPrompts('ws-1', {})).to.be.rejectedWith('prompts upstream failure');
    });
  });

  describe('getPrompts — userIntent enrichment', () => {
    const rawWith = (rows) => ({ type: 'table', blocks: { data: rows } });
    const RAW_BASE = rawWith([
      {
        primary_intent: 'informational', prompt: 'p-info', prompt_topic: 'T1', volume: 10,
      },
      {
        primary_intent: 'informational', prompt: 'p-comm', prompt_topic: 'T1', volume: 10,
      },
    ]);
    // Matches a PROMPTS payload carrying a specific `intent__X` tag clause.
    const withTag = (val) => sinon.match((payload) => Boolean(
      payload?.filters?.advanced?.filters?.some((f) => f.col === 'tags' && f.val === val),
    ));
    // Matches the base call (no `intent__` tag clause).
    const noIntentTag = sinon.match((payload) => !payload?.filters?.advanced?.filters
      ?.some((f) => f.col === 'tags' && String(f.val).startsWith('intent__')));

    beforeEach(() => {
      transport.fetchElement.withArgs('ws-1', ELEMENT_IDS.PROMPTS, noIntentTag).resolves(RAW_BASE);
      // All intent-filtered calls return empty except Commercial, which claims p-comm.
      INTENT_VALUES
        .filter((v) => v !== 'Commercial')
        .forEach((v) => transport.fetchElement
          .withArgs('ws-1', ELEMENT_IDS.PROMPTS, withTag(`intent__${v}`)).resolves(rawWith([])));
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.PROMPTS, withTag('intent__Commercial'))
        .resolves(rawWith([{
          primary_intent: 'informational', prompt: 'p-comm', prompt_topic: 'T1', volume: 10,
        }]));
    });

    it('stamps each row with its own intent (base + one call per intent value)', async () => {
      const result = await service.getPrompts('ws-1', { enrichUserIntent: true });
      const byPrompt = Object.fromEntries(result.prompts.map((p) => [p.prompt, p.userIntent]));
      expect(byPrompt['p-comm']).to.equal('commercial');
      expect(byPrompt['p-info']).to.equal('');
      const promptCalls = transport.fetchElement.getCalls()
        .filter((c) => c.args[1] === ELEMENT_IDS.PROMPTS);
      expect(promptCalls).to.have.length(1 + INTENT_VALUES.length);
    });

    it('does not enrich or make extra calls without the flag', async () => {
      const result = await service.getPrompts('ws-1', {});
      const promptCalls = transport.fetchElement.getCalls()
        .filter((c) => c.args[1] === ELEMENT_IDS.PROMPTS);
      expect(promptCalls).to.have.length(1);
      expect(result.prompts[0]).to.not.have.property('userIntent');
    });

    it('ANDs intent__X with any pre-existing tag filter', async () => {
      await service.getPrompts('ws-1', { enrichUserIntent: true, tags: ['type__branded'] });
      const commercialCall = transport.fetchElement.getCalls()
        .find((c) => c.args[1] === ELEMENT_IDS.PROMPTS
          && c.args[2]?.filters?.advanced?.filters
            ?.some((f) => f.col === 'tags' && f.val === 'intent__Commercial'));
      const tagVals = commercialCall.args[2].filters.advanced.filters
        .filter((f) => f.col === 'tags').map((f) => f.val);
      expect(tagVals).to.include.members(['type__branded', 'intent__Commercial']);
    });

    it('is non-fatal: a failing intent call degrades to blank userIntent', async () => {
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.PROMPTS, withTag('intent__Commercial'))
        .rejects(new Error('intent call failed'));
      const result = await service.getPrompts('ws-1', { enrichUserIntent: true });
      expect(result.count).to.equal(2);
      result.prompts.forEach((p) => expect(p.userIntent).to.equal(''));
    });
  });

  describe('getBrandPresenceStats', () => {
    const simpleNumeric = (value) => ({
      blocks: { firstSectionMainValue: [{ firstSectionMainValue: value }] },
    });

    beforeEach(() => {
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.TOTAL_EXECUTIONS, sinon.match.any)
        .resolves(simpleNumeric(19528));
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.MENTIONS, sinon.match.any)
        .resolves(simpleNumeric(14635));
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.VISIBILITY, sinon.match.any)
        .resolves(simpleNumeric(0.4877));
      transport.fetchElement
        .withArgs('ws-1', ELEMENT_IDS.CITATIONS_KPI, sinon.match.any)
        .resolves(simpleNumeric(158903));
    });

    it('fetches the 4 KPI elements in parallel and returns the combined stats', async () => {
      const result = await service.getBrandPresenceStats('ws-1', {
        model: 'search-gpt',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectId: 'proj-1',
      });
      expect(result).to.deep.equal({
        stats: {
          total_executions: 19528,
          total_mentions: 14635,
          average_visibility_score: 48.77,
          total_citations: 158903,
        },
      });
    });

    it('does not fetch trends when showTrends is falsy', async () => {
      await service.getBrandPresenceStats('ws-1', {
        startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectId: 'proj-1',
      });
      expect(transport.fetchElement.callCount).to.equal(4);
    });

    it('scopes Total Executions to the single resolved project via CBF_project, same as the other KPI elements', async () => {
      await service.getBrandPresenceStats('ws-1', {
        startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectId: 'proj-1',
      });
      const totalExecCall = transport.fetchElement.getCalls()
        .find((c) => c.args[1] === ELEMENT_IDS.TOTAL_EXECUTIONS);
      const projectFilter = totalExecCall.args[2].filters.advanced.filters.find(
        (f) => f.filters?.some((sub) => sub.col === 'CBF_project'),
      );
      expect(projectFilter.filters).to.deep.equal([{ op: 'eq', val: 'proj-1', col: 'CBF_project' }]);
    });

    it('omits the CBF_project filter on Total Executions in aggregate mode (no projectIds)', async () => {
      await service.getBrandPresenceStats('ws-1', {
        startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectIds: [],
      });
      const totalExecCall = transport.fetchElement.getCalls()
        .find((c) => c.args[1] === ELEMENT_IDS.TOTAL_EXECUTIONS);
      const hasProjectFilter = totalExecCall.args[2].filters.advanced.filters.some(
        (f) => f.filters?.some((sub) => sub.col === 'CBF_project'),
      );
      expect(hasProjectFilter).to.equal(false);
    });

    it('fetches weekly trends for each week when showTrends is true', async () => {
      const result = await service.getBrandPresenceStats('ws-1', {
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectId: 'proj-1',
        showTrends: true,
      });
      // 4 for the overall range + 4 per week (2 weeks in a 14-day range) = 12
      expect(transport.fetchElement.callCount).to.equal(12);
      expect(result.trends).to.deep.equal([
        {
          startDate: '2026-07-01',
          endDate: '2026-07-07',
          data: {
            stats: {
              total_executions: 19528,
              total_mentions: 14635,
              average_visibility_score: 48.77,
              total_citations: 158903,
            },
          },
        },
        {
          startDate: '2026-07-08',
          endDate: '2026-07-14',
          data: {
            stats: {
              total_executions: 19528,
              total_mentions: 14635,
              average_visibility_score: 48.77,
              total_citations: 158903,
            },
          },
        },
      ]);
    });

    it('propagates transport errors', async () => {
      transport.fetchElement.withArgs('ws-1', ELEMENT_IDS.MENTIONS, sinon.match.any)
        .rejects(new Error('mentions upstream failure'));
      await expect(service.getBrandPresenceStats('ws-1', {
        startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectId: 'proj-1',
      })).to.be.rejectedWith('mentions upstream failure');
    });
  });
});
