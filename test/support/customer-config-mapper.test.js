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
import { convertV1ToV2 } from '../../src/support/customer-config-mapper.js';

describe('Customer Config Mapper', () => {
  describe('convertV1ToV2', () => {
    it('converts basic LLMO config to customer config', () => {
      const llmoConfig = {
        brands: {
          aliases: [
            { name: 'Adobe Photoshop', regions: ['US', 'GB'] },
            { name: 'Photoshop', regions: ['GL'] },
          ],
        },
        competitors: {
          competitors: [
            { name: 'GIMP', url: 'https://gimp.org', regions: ['GL'] },
          ],
        },
        categories: {
          'cat-uuid-1': {
            name: 'Photo Editing',
            region: 'us',
            urls: [],
          },
        },
        topics: {
          'topic-uuid-1': {
            name: 'Photo Retouching',
            category: 'cat-uuid-1',
            prompts: [
              {
                id: 'prompt-1',
                prompt: 'What is the best photo editing software?',
                regions: ['us', 'gb'],
                origin: 'human',
                source: 'config',
              },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'Adobe', '1234@AdobeOrg');

      expect(result).to.have.property('customer');
      expect(result.customer).to.have.property('customerName', 'Adobe');
      expect(result.customer).to.have.property('imsOrgID', '1234@AdobeOrg');
      expect(result.customer.brands).to.be.an('array').with.lengthOf(1);

      const brand = result.customer.brands[0];
      expect(brand.name).to.equal('Adobe Photoshop');
      expect(brand.id).to.equal('adobe-photoshop');
      expect(brand.brandAliases).to.have.lengthOf(2);
      expect(brand.competitors).to.have.lengthOf(1);
      expect(brand.prompts).to.have.lengthOf(1);

      const prompt = brand.prompts[0];
      expect(prompt.prompt).to.equal('What is the best photo editing software?');
      expect(prompt.categoryId).to.equal('cat-uuid-1');
      expect(prompt.topicId).to.equal('topic-uuid-1');

      // Check top-level collections
      expect(result.customer.categories).to.have.lengthOf(1);
      expect(result.customer.topics).to.have.lengthOf(1);
      expect(result.customer.categories[0].id).to.equal('cat-uuid-1');
      expect(result.customer.categories[0].name).to.equal('Photo Editing');
      expect(result.customer.topics[0].id).to.equal('topic-uuid-1');
      expect(result.customer.topics[0].name).to.equal('Photo Retouching');
    });

    it('throws error if LLMO config is missing', () => {
      expect(() => convertV1ToV2(null, 'Adobe', '1234@AdobeOrg')).to.throw('LLMO config is required');
    });

    it('throws error if LLMO config is empty object', () => {
      expect(() => convertV1ToV2({}, 'Adobe', '1234@AdobeOrg')).to.throw('LLMO config is required');
    });

    it('throws error if customer name is missing', () => {
      const llmoConfig = { brands: { aliases: [] } };
      expect(() => convertV1ToV2(llmoConfig, '', '1234@AdobeOrg')).to.throw('Brand name and IMS Org ID are required');
    });

    it('throws error if IMS Org ID is missing', () => {
      const llmoConfig = { brands: { aliases: [] } };
      expect(() => convertV1ToV2(llmoConfig, 'Adobe', '')).to.throw('Brand name and IMS Org ID are required');
    });

    it('handles empty brands aliases', () => {
      const llmoConfig = {
        brands: { aliases: [] },
        competitors: { competitors: [] },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'Adobe', '1234@AdobeOrg');

      expect(result.customer.brands).to.be.an('array').with.lengthOf(0);
      expect(result.customer.categories).to.be.an('array').with.lengthOf(0);
      expect(result.customer.topics).to.be.an('array').with.lengthOf(0);
      expect(result.customer.availableVerticals).to.be.an('array').with.lengthOf.greaterThan(0);
    });

    it('handles brand alias with region property (single string)', () => {
      const llmoConfig = {
        brands: {
          aliases: [
            { name: 'Test Brand', region: ['US'] },
          ],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.include('us');
    });

    it('handles brand alias with regions property (array)', () => {
      const llmoConfig = {
        brands: {
          aliases: [
            { name: 'Test Brand', regions: ['US', 'GB'] },
          ],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.include('us');
      expect(result.customer.brands[0].region).to.include('gb');
    });

    it('handles competitor without regions', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        competitors: {
          competitors: [
            { name: 'Competitor A', url: 'https://example.com' },
          ],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].competitors[0].regions).to.deep.equal(['gl']);
    });

    it('handles category with array region', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: {
          'cat-1': {
            name: 'Category 1',
            region: ['us', 'gb'],
            urls: [],
          },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.include('us');
      expect(result.customer.brands[0].region).to.include('gb');
    });

    it('handles category with single string region', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: {
          'cat-1': {
            name: 'Category 1',
            region: 'fr',
            urls: [],
          },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.include('fr');
    });

    it('collects URLs from categories', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: {
          'cat-1': {
            name: 'Category 1',
            urls: [
              { value: 'https://example.com' },
              { value: 'https://test.com' },
            ],
          },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].urls).to.have.lengthOf(2);
      expect(result.customer.brands[0].urls[0]).to.deep.equal({ value: 'https://example.com', type: 'url' });
    });

    it('handles category URLs without value', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: {
          'cat-1': {
            name: 'Category 1',
            urls: [{ noValue: true }],
          },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].urls).to.have.lengthOf(0);
    });

    it('collects regions from topics and prompts', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [
              { prompt: 'Test', regions: ['jp'] },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.include('jp');
    });

    it('uses default region "gl" when no regions are specified', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.deep.equal(['gl']);
    });

    it('uses alias name from primaryAlias.name', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Primary Name' }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].name).to.equal('Primary Name');
    });

    it('uses alias name from primaryAlias.aliases[0] when name is missing', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ aliases: ['Alias Name'] }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].name).to.equal('Alias Name');
    });

    it('uses brandName fallback when both name and aliases are missing', () => {
      const llmoConfig = {
        brands: {
          aliases: [{}],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'FallbackName', 'test@org');
      expect(result.customer.brands[0].name).to.equal('FallbackName');
    });

    it('handles missing brands object', () => {
      const llmoConfig = {
        // No brands object at all
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands).to.have.lengthOf(0);
    });

    it('handles missing competitors object', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        // No competitors object
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].competitors).to.have.lengthOf(0);
    });

    it('handles missing topics object', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: {},
        // No topics object
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts).to.have.lengthOf(0);
    });

    it('handles prompts without regions', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [
              { prompt: 'Test' /* no regions */ },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].region).to.deep.equal(['gl']);
    });

    it('handles topics without prompts array', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            // No prompts array
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts).to.have.lengthOf(0);
    });

    it('handles aiTopics without prompts array', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {},
        aiTopics: {
          'ai-topic-1': {
            name: 'AI Topic',
            category: 'cat-1',
            // No prompts array
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts).to.have.lengthOf(0);
    });

    it('handles missing categories object', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        // No categories object
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.categories).to.have.lengthOf(0);
    });

    it('handles AI topics with prompts without regions', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {},
        aiTopics: {
          'ai-topic-1': {
            name: 'AI Topic',
            category: 'cat-1',
            prompts: [
              { prompt: 'AI question without regions?' },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts[0].regions).to.deep.equal(['gl']);
    });

    it('preserves brand alias status from V1', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test', status: 'inactive' }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].status).to.equal('inactive');
    });

    it('uses default status "active" when not provided', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].status).to.equal('active');
    });

    it('preserves updatedAt from primaryAlias', () => {
      const timestamp = '2024-01-15T10:00:00.000Z';
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test', updatedAt: timestamp }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].updatedAt).to.equal(timestamp);
    });

    it('handles competitor without url', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        competitors: {
          competitors: [{ name: 'Comp' }],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].competitors[0].url).to.equal('');
    });

    it('processes AI topics correctly', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {},
        aiTopics: {
          'ai-topic-1': {
            name: 'AI Topic',
            category: 'cat-1',
            prompts: [
              { prompt: 'AI prompt', regions: ['us'] },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts).to.have.lengthOf(1);
      expect(result.customer.brands[0].prompts[0].origin).to.equal('ai');
      expect(result.customer.brands[0].prompts[0].source).to.equal('flow');
      expect(result.customer.topics).to.have.lengthOf(1);
    });

    it('generates prompt ID when not provided', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [
              { prompt: 'Test prompt without ID' },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts[0].id).to.be.a('string');
      expect(result.customer.brands[0].prompts[0].id).to.include('testco');
    });

    it('handles deleted prompts with existing category', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Category 1' } },
        topics: {},
        deleted: {
          prompts: {
            'del-prompt-1': {
              prompt: 'Deleted prompt',
              category: 'Category 1',
              topic: 'Topic A',
              regions: ['us'],
            },
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.brands[0].prompts).to.have.lengthOf(1);
      expect(result.customer.brands[0].prompts[0].status).to.equal('deleted');
      expect(result.customer.brands[0].prompts[0].id).to.equal('del-prompt-1');
    });

    it('handles deleted prompts with non-existing category', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: {},
        topics: {},
        deleted: {
          prompts: {
            'del-prompt-1': {
              prompt: 'Deleted prompt',
              category: 'New Category',
              topic: 'New Topic',
            },
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      const deletedCategory = result.customer.categories.find((c) => c.name === 'New Category');
      expect(deletedCategory).to.exist;
      expect(deletedCategory.status).to.equal('deleted');

      const deletedTopic = result.customer.topics.find((t) => t.name === 'New Topic');
      expect(deletedTopic).to.exist;
      expect(deletedTopic.status).to.equal('deleted');
    });

    it('avoids duplicate topic entries when processing multiple prompts', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [
              { prompt: 'Prompt 1' },
              { prompt: 'Prompt 2' },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      expect(result.customer.topics).to.have.lengthOf(1);
    });

    it('preserves category metadata from V1', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: {
          'cat-1': {
            name: 'Cat 1',
            origin: 'ai',
            updatedBy: 'admin',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      const category = result.customer.categories[0];
      expect(category.origin).to.equal('ai');
      expect(category.updatedBy).to.equal('admin');
      expect(category.updatedAt).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('uses default values for missing category metadata', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: {
          'cat-1': { name: 'Cat 1' },
        },
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      const category = result.customer.categories[0];
      expect(category.origin).to.equal('human');
      expect(category.updatedBy).to.equal('system');
      expect(category.updatedAt).to.be.a('string');
    });

    it('preserves prompt metadata from V1', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test' }],
        },
        categories: { 'cat-1': { name: 'Cat 1' } },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [{
              prompt: 'Test',
              status: 'inactive',
              updatedBy: 'user1',
              updatedAt: '2024-01-01T00:00:00.000Z',
            }],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      const prompt = result.customer.brands[0].prompts[0];
      expect(prompt.status).to.equal('inactive');
      expect(prompt.updatedBy).to.equal('user1');
      expect(prompt.updatedAt).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('handles brand alias without name or aliases', () => {
      const llmoConfig = {
        brands: {
          aliases: [
            { name: 'First' },
            {},
          ],
        },
        categories: {},
        topics: {},
      };

      const result = convertV1ToV2(llmoConfig, 'Fallback', 'test@org');
      expect(result.customer.brands[0].brandAliases[1].name).to.equal('Fallback');
    });
  });
});
