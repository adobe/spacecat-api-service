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
      { value: 'topic:SEO' },
      { value: 'category:Firefly' },
      { value: 'intent:Informational' },
      { value: 'source:organic' },
      { value: 'type:branded' },
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

    it('groups unknown prefix:value tags under their own prefix key', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.type).to.deep.equal([{ id: null, label: 'branded' }]);
    });

    it('collects plain, prefix-less tags into the generic tags key', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.tags).to.deep.equal([{ id: null, label: 'plain-tag' }]);
    });

    it('brands contains filter dimensions for each brand', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.brands).to.have.length(2);
      expect(result.brands[0]).to.deep.include({ id: null, label: 'Adobe' });
    });

    it('regions contains transformed markets', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.regions).to.have.length(2);
      expect(result.regions[0].label).to.equal('US-en');
    });

    it('topics contains only topic:-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.topics).to.deep.equal([{ id: null, label: 'SEO' }]);
    });

    it('categories contains only category:-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.categories).to.deep.equal([{ id: null, label: 'Firefly' }]);
    });

    it('page_intents contains only intent:-prefixed entries with uppercased id', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.page_intents).to.deep.equal([{ id: 'INFORMATIONAL', label: 'Informational' }]);
    });

    it('origins contains only source:-prefixed entries', async () => {
      const result = await service.getUrlInspectorFilterDimensions('ws-1', {});
      expect(result.origins).to.deep.equal([{ id: 'organic', label: 'organic' }]);
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
      const result = await service.getPrompts('ws-1', { tags: ['type:branded'], projectIds: ['proj-a'] });
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
});
