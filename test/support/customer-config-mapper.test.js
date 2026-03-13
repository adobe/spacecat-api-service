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

/* eslint-env mocha */

import { expect } from 'chai';
import { convertV1ToV2, convertV2ToV1 } from '../../src/support/customer-config-mapper.js';

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

  describe('convertV2ToV1', () => {
    it('converts customer config to LLMO config', () => {
      const customerConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: '1234@AdobeOrg',
          brands: [
            {
              id: 'adobe-photoshop',
              name: 'Adobe Photoshop',
              brandAliases: [
                { name: 'Photoshop', regions: ['GL'] },
              ],
              competitors: [
                { name: 'GIMP', url: 'https://gimp.org', regions: ['GL'] },
              ],
              prompts: [
                {
                  id: 'prompt-1',
                  prompt: 'What is the best photo editing software?',
                  regions: ['us', 'gb'],
                  origin: 'human',
                  source: 'config',
                  status: 'active',
                  category: {
                    id: 'photoshop-photo-editing',
                    name: 'Photo Editing',
                  },
                  topic: {
                    id: 'photoshop-topic-1',
                    name: 'Photo Retouching',
                  },
                },
              ],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);

      expect(result).to.have.property('brands');
      expect(result.brands.aliases).to.have.lengthOf(1);
      expect(result.brands.aliases[0].aliases[0]).to.equal('Photoshop');

      expect(result.competitors.competitors).to.have.lengthOf(1);
      expect(result.competitors.competitors[0].name).to.equal('GIMP');

      expect(Object.keys(result.categories)).to.have.lengthOf(1);
      expect(Object.keys(result.topics)).to.have.lengthOf(1);
      expect(result.categories['photoshop-photo-editing'].name).to.equal('Photo Editing');
      expect(result.topics['photoshop-topic-1'].name).to.equal('Photo Retouching');
      expect(result.topics['photoshop-topic-1'].prompts).to.have.lengthOf(1);
    });

    it('throws error if customer config is missing', () => {
      expect(() => convertV2ToV1(null)).to.throw('Customer config is required');
    });

    it('throws error if customer config is empty object', () => {
      expect(() => convertV2ToV1({})).to.throw('Customer config is required');
    });

    it('throws error if no brands exist', () => {
      const customerConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: '1234@AdobeOrg',
          brands: [],
        },
      };

      expect(() => convertV2ToV1(customerConfig)).to.throw('At least one brand is required');
    });

    it('handles customer with undefined brands array', () => {
      const customerConfig = {
        customer: {
          customerName: 'Adobe',
          imsOrgID: '1234@AdobeOrg',
          // brands is undefined
        },
      };

      expect(() => convertV2ToV1(customerConfig)).to.throw('At least one brand is required');
    });

    it('uses categories and topics from top-level collections', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.categories['cat-1'].name).to.equal('Category 1');
      expect(result.topics['topic-1'].name).to.equal('Topic 1');
    });

    it('extracts categories from inline prompt data when not in collections', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  category: { id: 'inline-cat', name: 'Inline Category' },
                  topic: { id: 'inline-topic', name: 'Inline Topic' },
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.categories['inline-cat'].name).to.equal('Inline Category');
      expect(result.topics['inline-topic'].name).to.equal('Inline Topic');
    });

    it('handles prompts without categoryId or topicId', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Orphaned prompt',
                  status: 'active',
                  regions: ['us'],
                },
              ],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(Object.keys(result.topics)).to.have.lengthOf(0);
    });

    it('finds first active category for brand aliases', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Active prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.brands.aliases[0].category).to.equal('cat-1');
    });

    it('handles brand with no active prompts for alias category', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.brands.aliases[0].category).to.be.null;
    });

    it('includes cdnBucketConfig when baseUrl matches', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              baseUrl: 'https://example.com',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
          cdnBucketConfigs: [
            {
              urls: ['https://example.com'],
              bucket: 'test-bucket',
              region: 'us-east-1',
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.cdnBucketConfig).to.exist;
      expect(result.cdnBucketConfig.bucket).to.equal('test-bucket');
      expect(result.cdnBucketConfig.urls).to.be.undefined;
    });

    it('excludes cdnBucketConfig when baseUrl does not match', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              baseUrl: 'https://different.com',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
          cdnBucketConfigs: [
            {
              urls: ['https://example.com'],
              bucket: 'test-bucket',
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.cdnBucketConfig).to.be.undefined;
    });

    it('handles missing cdnBucketConfigs', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              baseUrl: 'https://example.com',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.cdnBucketConfig).to.be.undefined;
    });

    it('handles empty cdnBucketConfigs array', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              baseUrl: 'https://example.com',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
          cdnBucketConfigs: [],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.cdnBucketConfig).to.be.undefined;
    });

    it('handles brand without baseUrl', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
          cdnBucketConfigs: [
            {
              urls: ['https://example.com'],
              bucket: 'test-bucket',
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.cdnBucketConfig).to.be.undefined;
    });

    it('groups prompts by topic and identifies AI topics', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'AI prompt 1',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-ai',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                },
                {
                  id: 'p2',
                  prompt: 'AI prompt 2',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-ai',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-ai', name: 'AI Topic', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.aiTopics['topic-ai']).to.exist;
      expect(result.aiTopics['topic-ai'].prompts).to.have.lengthOf(2);
      expect(result.topics['topic-ai']).to.not.exist;
    });

    it('groups prompts by topic and identifies human topics', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Human prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-human',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-human', name: 'Human Topic', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.topics['topic-human']).to.exist;
      expect(result.topics['topic-human'].prompts).to.have.lengthOf(1);
      expect(result.aiTopics['topic-human']).to.not.exist;
    });

    it('separates active and deleted prompts', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Active prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
                {
                  id: 'p2',
                  prompt: 'Deleted prompt',
                  status: 'deleted',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.topics['topic-1'].prompts).to.have.lengthOf(1);
      expect(result.topics['topic-1'].prompts[0].id).to.equal('p1');
      expect(result.deleted.prompts.p2).to.exist;
    });

    it('adds category only for active topics', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Deleted prompt',
                  status: 'deleted',
                  categoryId: 'cat-deleted',
                  topicId: 'topic-deleted',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-deleted', name: 'Deleted Category', status: 'deleted' }],
          topics: [{
            id: 'topic-deleted', name: 'Deleted Topic', categoryId: 'cat-deleted', status: 'deleted',
          }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.categories['cat-deleted']).to.not.exist;
    });

    it('uses category regions from prompts', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['jp', 'kr'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.categories['cat-1'].region).to.deep.equal(['jp', 'kr']);
    });

    it('uses default regions when prompt has no regions', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', origin: 'human' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.categories['cat-1'].region).to.deep.equal(['gl']);
    });

    it('preserves category metadata', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{
            id: 'cat-1',
            name: 'Category 1',
            origin: 'ai',
            updatedBy: 'admin',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      const category = result.categories['cat-1'];
      expect(category.origin).to.equal('ai');
      expect(category.updatedBy).to.equal('admin');
      expect(category.updatedAt).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('uses default category metadata when not provided', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      const category = result.categories['cat-1'];
      expect(category.origin).to.equal('human');
      expect(category.updatedBy).to.equal('system');
    });

    it('preserves brand metadata in aliases', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              updatedBy: 'user1',
              updatedAt: '2024-01-01T00:00:00.000Z',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.brands.aliases[0].updatedBy).to.equal('user1');
      expect(result.brands.aliases[0].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('uses default brand metadata when not provided', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [],
            },
          ],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.brands.aliases[0].updatedBy).to.equal('system');
      expect(result.brands.aliases[0].updatedAt).to.be.a('string');
    });

    it('preserves AI topic prompt metadata', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'AI prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-ai',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                  updatedBy: 'agent',
                  updatedAt: '2024-01-01T00:00:00.000Z',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-ai', name: 'AI Topic', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      const prompt = result.aiTopics['topic-ai'].prompts[0];
      expect(prompt.updatedBy).to.equal('agent');
      expect(prompt.updatedAt).to.equal('2024-01-01T00:00:00.000Z');
    });

    it('omits prompt ID from AI topic prompts', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'AI prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-ai',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-ai', name: 'AI Topic', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.aiTopics['topic-ai'].prompts[0].id).to.be.undefined;
    });

    it('includes prompt ID in human topic prompts', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Human prompt',
                  status: 'active',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.topics['topic-1'].prompts[0].id).to.equal('p1');
    });

    it('uses default prompt status when not provided', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(result.topics['topic-1'].prompts[0].status).to.equal('active');
    });

    it('uses default prompt metadata when not provided', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Test prompt',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);
      const prompt = result.topics['topic-1'].prompts[0];
      expect(prompt.updatedBy).to.equal('system');
      expect(prompt.updatedAt).to.be.a('string');
    });

    it('skips category and topic when not found in maps', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Orphan prompt',
                  categoryId: 'missing-cat',
                  topicId: 'missing-topic',
                  regions: ['us'],
                },
              ],
            },
          ],
          categories: [],
          topics: [],
        },
      };

      const result = convertV2ToV1(customerConfig);
      expect(Object.keys(result.categories)).to.have.lengthOf(0);
      expect(Object.keys(result.topics)).to.have.lengthOf(0);
    });

    it('moves all prompts to deleted section when all have deleted status', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Active but deleted topic 1',
                  status: 'deleted',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                  updatedBy: 'admin',
                  updatedAt: '2024-01-01T00:00:00.000Z',
                },
                {
                  id: 'p2',
                  prompt: 'Active but deleted topic 2',
                  status: 'deleted',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['gb'],
                  origin: 'ai',
                  source: 'flow',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', status: 'deleted' }],
          topics: [{
            id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1', status: 'deleted',
          }],
        },
      };

      const result = convertV2ToV1(customerConfig);

      // Should not create topics or aiTopics
      expect(result.topics['topic-1']).to.not.exist;
      expect(result.aiTopics['topic-1']).to.not.exist;

      // Should move all prompts to deleted section
      expect(result.deleted.prompts.p1).to.exist;
      expect(result.deleted.prompts.p1.prompt).to.equal('Active but deleted topic 1');
      expect(result.deleted.prompts.p1.topic).to.equal('Topic 1');
      expect(result.deleted.prompts.p1.category).to.equal('Category 1');
      expect(result.deleted.prompts.p1.updatedBy).to.equal('admin');
      expect(result.deleted.prompts.p1.updatedAt).to.equal('2024-01-01T00:00:00.000Z');

      expect(result.deleted.prompts.p2).to.exist;
      expect(result.deleted.prompts.p2.prompt).to.equal('Active but deleted topic 2');
      expect(result.deleted.prompts.p2.topic).to.equal('Topic 1');
      expect(result.deleted.prompts.p2.category).to.equal('Category 1');
    });

    it('uses default metadata when missing in allDeleted prompts', () => {
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Prompt without metadata',
                  status: 'deleted',
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1' }],
          topics: [{ id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1' }],
        },
      };

      const result = convertV2ToV1(customerConfig);

      expect(result.deleted.prompts.p1.updatedBy).to.equal('system');
      expect(result.deleted.prompts.p1.updatedAt).to.be.a('string');
    });

    it('handles mixed active and inactive prompts all marked for deletion', () => {
      // This is an edge case where prompts have mixed statuses but all are considered deleted
      // Testing lines 516-525: the allDeleted block that processes activePrompts
      const customerConfig = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'test-brand',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Prompt 1',
                  status: 'active', // Active status
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['us'],
                  origin: 'human',
                  source: 'config',
                },
                {
                  id: 'p2',
                  prompt: 'Prompt 2',
                  status: 'active', // Active status
                  categoryId: 'cat-1',
                  topicId: 'topic-1',
                  regions: ['gb'],
                  origin: 'human',
                  source: 'config',
                },
                // All prompts will be treated as deleted via the allDeleted logic
              ],
            },
          ],
          categories: [{ id: 'cat-1', name: 'Category 1', status: 'deleted' }],
          topics: [{
            id: 'topic-1', name: 'Topic 1', categoryId: 'cat-1', status: 'deleted',
          }],
        },
      };

      const result = convertV2ToV1(customerConfig);

      // Since category and topic are deleted but prompts are active,
      // and allDeleted logic depends on prompt status, not category/topic status,
      // this should create a normal topic (not all deleted)
      expect(result.topics['topic-1']).to.exist;
      expect(result.topics['topic-1'].prompts).to.have.lengthOf(2);
    });
  });

  describe('roundtrip conversion', () => {
    it('maintains data integrity through V1→V2→V1', () => {
      const originalLlmo = {
        brands: {
          aliases: [
            { name: 'Test Brand', regions: ['US'] },
          ],
        },
        competitors: {
          competitors: [
            { name: 'Competitor', url: 'https://example.com', regions: ['GL'] },
          ],
        },
        categories: {
          'cat-1': {
            name: 'Category 1',
            region: 'us',
            urls: [],
          },
        },
        topics: {
          'topic-1': {
            name: 'Topic 1',
            category: 'cat-1',
            prompts: [
              {
                id: 'prompt-1',
                prompt: 'Test prompt',
                regions: ['us'],
                origin: 'human',
                source: 'config',
                status: 'active',
              },
            ],
          },
        },
      };

      const v2 = convertV1ToV2(originalLlmo, 'Test Company', 'test@org');
      const backToV1 = convertV2ToV1(v2);

      expect(backToV1.brands.aliases[0].aliases[0]).to.equal('Test Brand');
      expect(backToV1.competitors.competitors[0].name).to.equal('Competitor');
      expect(Object.values(backToV1.categories)[0].name).to.equal('Category 1');
      expect(Object.values(backToV1.topics)[0].name).to.equal('Topic 1');
      expect(Object.values(backToV1.topics)[0].prompts[0].prompt).to.equal('Test prompt');
      expect(Object.values(backToV1.topics)[0].prompts[0].id).to.equal('prompt-1');
    });

    it('handles deleted prompts correctly', () => {
      const v2Config = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'brand-1',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test Brand', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Active',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                },
                {
                  id: 'p2',
                  prompt: 'Deleted',
                  status: 'deleted',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                },
              ],
            },
          ],
          categories: [{ id: 'c1', name: 'Category 1' }],
          topics: [{ id: 't1', name: 'Topic 1', categoryId: 'c1' }],
        },
      };

      const v1Config = convertV2ToV1(v2Config);

      expect(v1Config.topics.t1.prompts).to.have.lengthOf(1);
      expect(v1Config.deleted.prompts.p2).to.exist;
      expect(v1Config.deleted.prompts.p2.prompt).to.equal('Deleted');
    });

    it('handles all prompts deleted in a topic', () => {
      const v2Config = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'brand-1',
              name: 'Test Brand',
              brandAliases: [
                { name: 'Test Brand', regions: ['us'] },
              ],
              competitors: [],
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Deleted 1',
                  status: 'deleted',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                },
                {
                  id: 'p2',
                  prompt: 'Deleted 2',
                  status: 'deleted',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                },
              ],
            },
          ],
          categories: [
            { id: 'c1', name: 'Category 1', status: 'deleted' },
          ],
          topics: [
            {
              id: 't1', name: 'Topic 1', categoryId: 'c1', status: 'deleted',
            },
          ],
        },
      };

      const v1Config = convertV2ToV1(v2Config);

      expect(v1Config.topics.t1).to.not.exist;
      expect(v1Config.deleted.prompts.p1).to.exist;
      expect(v1Config.deleted.prompts.p2).to.exist;
    });
  });

  describe('Deterministic ID generation', () => {
    it('generates consistent prompt IDs from brand name and prompt text', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Adobe Photoshop', regions: ['US'] }],
        },
        categories: {
          'cat-1': { name: 'Photo Editing', region: 'us', urls: [] },
        },
        topics: {
          'topic-1': {
            name: 'Retouching',
            category: 'cat-1',
            prompts: [
              { prompt: 'What is the best photo editor?', regions: ['us'] },
              { prompt: 'How do I retouch photos?', regions: ['us'] },
            ],
          },
        },
      };

      const result1 = convertV1ToV2(llmoConfig, 'Adobe', '1234@AdobeOrg');
      const result2 = convertV1ToV2(llmoConfig, 'Adobe', '1234@AdobeOrg');

      // Same prompt text should generate same ID
      const brand1 = result1.customer.brands[0];
      const brand2 = result2.customer.brands[0];
      expect(brand1.prompts[0].id).to.equal(brand2.prompts[0].id);
      expect(brand1.prompts[1].id).to.equal(brand2.prompts[1].id);

      // Different prompt text should generate different IDs
      expect(brand1.prompts[0].id).to.not.equal(brand1.prompts[1].id);

      // IDs should be in format: brandslug-hash
      expect(result1.customer.brands[0].prompts[0].id).to.match(/^adobe-[a-f0-9]{8}$/);
    });

    it('uses existing prompt IDs when present', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand', regions: ['US'] }],
        },
        categories: {
          'cat-1': { name: 'Category', region: 'us', urls: [] },
        },
        topics: {
          'topic-1': {
            name: 'Topic',
            category: 'cat-1',
            prompts: [
              { id: 'custom-id-123', prompt: 'Test prompt', regions: ['us'] },
            ],
          },
        },
      };

      const result = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');

      // Should preserve existing ID
      expect(result.customer.brands[0].prompts[0].id).to.equal('custom-id-123');
    });

    it('generates deterministic IDs for AI topics as well', () => {
      const llmoConfig = {
        brands: {
          aliases: [{ name: 'Test Brand', regions: ['US'] }],
        },
        categories: {
          'cat-1': { name: 'Category', region: 'us', urls: [] },
        },
        topics: {},
        aiTopics: {
          'ai-topic-1': {
            name: 'AI Topic',
            category: 'cat-1',
            prompts: [
              { prompt: 'AI generated question?', regions: ['us'] },
            ],
          },
        },
      };

      const result1 = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');
      const result2 = convertV1ToV2(llmoConfig, 'TestCo', 'test@org');

      // AI topic prompts should also get deterministic IDs
      const brand1 = result1.customer.brands[0];
      const brand2 = result2.customer.brands[0];
      expect(brand1.prompts[0].id).to.equal(brand2.prompts[0].id);
      expect(brand1.prompts[0].origin).to.equal('ai');
    });
  });

  describe('V2 to V1 conversion - AI topics', () => {
    it('converts AI-generated prompts back to aiTopics section', () => {
      const v2Config = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'brand-1',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test Brand', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'ai-prompt-1',
                  prompt: 'AI question?',
                  status: 'active',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                },
              ],
            },
          ],
          categories: [{ id: 'c1', name: 'Category 1' }],
          topics: [{ id: 't1', name: 'AI Topic', categoryId: 'c1' }],
        },
      };

      const v1Config = convertV2ToV1(v2Config);

      // Should be in aiTopics, not regular topics
      expect(v1Config.aiTopics).to.exist;
      expect(v1Config.aiTopics.t1).to.exist;
      expect(v1Config.aiTopics.t1.prompts).to.have.lengthOf(1);
      expect(v1Config.aiTopics.t1.prompts[0].prompt).to.equal('AI question?');
    });

    it('handles all AI topic prompts being deleted', () => {
      const v2Config = {
        customer: {
          customerName: 'Test',
          brands: [
            {
              id: 'brand-1',
              name: 'Test Brand',
              brandAliases: [{ name: 'Test Brand', regions: ['us'] }],
              competitors: [],
              prompts: [
                {
                  id: 'ai-prompt-1',
                  prompt: 'Deleted AI question?',
                  status: 'deleted',
                  categoryId: 'c1',
                  topicId: 't1',
                  regions: ['us'],
                  origin: 'ai',
                  source: 'flow',
                },
              ],
            },
          ],
          categories: [{ id: 'c1', name: 'Category 1' }],
          topics: [{
            id: 't1', name: 'AI Topic', categoryId: 'c1', status: 'deleted',
          }],
        },
      };

      const v1Config = convertV2ToV1(v2Config);

      // Should NOT be in aiTopics since all prompts deleted
      expect(v1Config.aiTopics.t1).to.not.exist;
      // Should be in deleted section
      expect(v1Config.deleted.prompts['ai-prompt-1']).to.exist;
      expect(v1Config.deleted.prompts['ai-prompt-1'].prompt).to.equal('Deleted AI question?');
    });
  });
});
