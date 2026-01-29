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

    it('throws error if customer name is missing', () => {
      const llmoConfig = { brands: { aliases: [] } };
      expect(() => convertV1ToV2(llmoConfig, '', '1234@AdobeOrg')).to.throw('Brand name and IMS Org ID are required');
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
});
