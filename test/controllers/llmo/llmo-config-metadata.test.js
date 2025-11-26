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
import { updateModifiedByDetails, deepEqual } from '../../../src/controllers/llmo/llmo-config-metadata.js';

use(sinonChai);

describe('LLMO Config Metadata Utils', () => {
  const userId = 'test-user-id';
  const categoryId = 'cat-123';
  const topicId = 'top-123';

  describe('deepEqual', () => {
    it('should return true for identical objects', () => {
      expect(deepEqual({ a: 1 }, { a: 1 })).to.be.true;
    });

    it('should return false for different objects', () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).to.be.false;
    });

    it('should return false for objects with different number of keys', () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).to.be.false;
    });

    it('should return true for nested identical objects', () => {
      expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).to.be.true;
    });

    it('should return false for nested different objects', () => {
      expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).to.be.false;
    });

    it('should return true for identical arrays', () => {
      expect(deepEqual([1, 2], [1, 2])).to.be.true;
    });

    it('should return true for arrays with same elements in different order', () => {
      expect(deepEqual([1, 2], [2, 1])).to.be.true; // Order DOES NOT matter
    });

    it('should return false for arrays of different lengths', () => {
      expect(deepEqual([1, 2], [1])).to.be.false;
    });

    it('should return false for arrays with different elements', () => {
      expect(deepEqual([1, 2], [1, 3])).to.be.false;
    });

    it('should return false when comparing array with object', () => {
      expect(deepEqual([], {})).to.be.false;
    });

    it('should handle null and undefined', () => {
      expect(deepEqual(null, null)).to.be.true;
      expect(deepEqual(undefined, undefined)).to.be.true;
      expect(deepEqual(null, undefined)).to.be.false;
      expect(deepEqual({}, null)).to.be.false;
    });
  });

  describe('updateModifiedByDetails', () => {
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers(new Date('2024-01-01T00:00:00Z').getTime());
    });

    afterEach(() => {
      clock.restore();
    });

    it('should initialize stats correctly for empty config', () => {
      const { stats } = updateModifiedByDetails({}, {}, userId);
      expect(stats).to.deep.equal({
        categories: { total: 0, modified: 0 },
        topics: { total: 0, modified: 0 },
        aiTopics: { total: 0, modified: 0 },
        prompts: { total: 0, modified: 0 },
        brandAliases: { total: 0, modified: 0 },
        competitors: { total: 0, modified: 0 },
        deletedPrompts: { total: 0, modified: 0 },
        categoryUrls: { total: 0 },
      });
    });

    it('should update metadata for new category', () => {
      const inputConfig = {
        categories: {
          [categoryId]: { name: 'New Cat', region: ['us'], urls: [{ value: 'url1' }, { value: 'url2' }] },
        },
      };
      const oldConfig = {};

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.equal(userId);
      expect(newConfig.categories[categoryId].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
      expect(stats.categories.modified).to.equal(1);
    });

    it('should NOT update metadata for unchanged category', () => {
      const category = {
        name: 'Old Cat',
        region: ['us'],
        updatedBy: 'old-user',
        updatedAt: '2023-01-01T00:00:00.000Z',
        urls: [{ value: 'url1' }, { value: 'url2' }],
      };
      const inputConfig = { categories: { [categoryId]: { ...category } } };
      const oldConfig = { categories: { [categoryId]: { ...category } } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.equal('old-user');
      expect(newConfig.categories[categoryId].updatedAt).to.equal('2023-01-01T00:00:00.000Z');
      expect(stats.categories.modified).to.equal(0);
    });

    it('should update metadata for modified category', () => {
      const oldCategory = {
        name: 'Old Cat',
        region: ['us'],
        updatedBy: 'old-user',
        updatedAt: '2023-01-01T00:00:00.000Z',
        urls: [{ value: 'url1' }, { value: 'url2' }],
      };
      const newCategory = {
        name: 'Old Cat',
        region: ['us'],
        urls: [{ value: 'url1' }], // changed
      };
      const inputConfig = { categories: { [categoryId]: newCategory } };
      const oldConfig = { categories: { [categoryId]: oldCategory } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.equal(userId);
      expect(newConfig.categories[categoryId].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
      expect(stats.categories.modified).to.equal(1);
    });

    it('should update metadata for AI category', () => {
      const inputConfig = {
        categories: {
          [categoryId]: { name: 'AI Cat', region: ['us'], origin: 'ai' },
        },
      };
      const oldConfig = {};

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.equal(userId);
      expect(stats.categories.modified).to.equal(1);
    });

    it('should handle prompts correctly (new prompt)', () => {
      const inputConfig = {
        topics: {
          [topicId]: {
            name: 'Topic',
            prompts: [{ prompt: 'New Prompt', origin: 'human' }],
          },
        },
      };
      const oldConfig = {
        topics: {
          [topicId]: {
            name: 'Topic',
            prompts: [],
          },
        },
      };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal(userId);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should handle prompts correctly (unchanged prompt)', () => {
      const prompt = {
        prompt: 'Old Prompt',
        origin: 'human',
        updatedBy: 'old-user',
        updatedAt: '2023-01-01',
      };
      const inputConfig = {
        topics: {
          [topicId]: { prompts: [{ ...prompt }] },
        },
      };
      const oldConfig = {
        topics: {
          [topicId]: { prompts: [{ ...prompt }] },
        },
      };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal('old-user');
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should ignore status changes in prompt', () => {
      const oldPrompt = {
        prompt: 'Prompt',
        origin: 'human',
        status: 'processing',
        updatedBy: 'old-user',
        updatedAt: '2023-01-01',
      };
      const newPrompt = {
        prompt: 'Prompt',
        origin: 'human',
        status: 'completed', // changed status
      };
      const inputConfig = {
        topics: {
          [topicId]: { prompts: [newPrompt] },
        },
      };
      const oldConfig = {
        topics: {
          [topicId]: { prompts: [oldPrompt] },
        },
      };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal('old-user');
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should handle prompts with IDs (match by ID)', () => {
      const oldPrompt = {
        id: '507f1f77-bcf8-6cd7-9436-3b7713d911e9',
        prompt: 'Old Prompt',
        origin: 'human',
        updatedBy: 'old-user',
        updatedAt: '2023-01-01',
      };
      const newPrompt = oldPrompt;
      const inputConfig = { topics: { [topicId]: { prompts: [newPrompt] } } };
      const oldConfig = { topics: { [topicId]: { prompts: [oldPrompt] } } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal('old-user');
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should handle aiTopics correctly', () => {
      const inputConfig = {
        aiTopics: {
          [topicId]: {
            name: 'AI Topic',
            prompts: [{ prompt: 'AI Prompt', origin: 'ai' }],
          },
        },
      };
      const oldConfig = {
        aiTopics: {
          [topicId]: {
            name: 'AI Topic',
            prompts: [{ prompt: 'new AI Prompt', origin: 'ai' }],
          },
        },
      };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.aiTopics[topicId].prompts[0].updatedBy).to.equal(userId);
      expect(stats.aiTopics.modified).to.equal(0);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should update metadata for AI prompts', () => {
      const inputConfig = {
        topics: {
          [topicId]: {
            prompts: [{ prompt: 'AI Prompt', origin: 'ai' }],
          },
        },
      };
      const oldConfig = {};

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal(userId);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should handle deleted prompts', () => {
      const inputConfig = {
        deleted: {
          prompts: {
            'del-1': { prompt: 'Deleted', origin: 'human' },
          },
        },
      };
      const oldConfig = {};

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.deleted.prompts['del-1'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should handle deleted prompts when old config has no deleted section', () => {
      const inputConfig = {
        deleted: {
          prompts: {
            'del-1': { prompt: 'Deleted', origin: 'human' },
          },
        },
      };
      const oldConfig = { categories: {} }; // No deleted section

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.deleted.prompts['del-1'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should update metadata when adding a new deleted prompt', () => {
      const oldConfig = {
        deleted: {
          prompts: {
            'del-1': {
              prompt: 'Deleted',
              origin: 'human',
              updatedBy: 'old',
              updatedAt: '2023',
            },
          },
        },
      };
      const inputConfig = {
        deleted: {
          prompts: {
            'del-1': {
              prompt: 'Deleted',
              origin: 'human',
              updatedBy: 'old',
              updatedAt: '2023',
            },
            'del-2': { prompt: 'New Deleted', origin: 'human' },
          },
        },
      };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.deleted.prompts['del-1'].updatedBy).to.equal('old');
      expect(newConfig.deleted.prompts['del-1'].updatedAt).to.equal('2023');
      expect(newConfig.deleted.prompts['del-2'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should handle brand aliases', () => {
      const inputConfig = {
        brands: {
          aliases: [{ aliases: ['New Alias'], region: ['us'] }],
        },
      };
      const oldConfig = { brands: { aliases: [] } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.brands.aliases[0].updatedBy).to.equal(userId);
      expect(stats.brandAliases.modified).to.equal(1);
    });

    it('should preserve metadata for existing brand aliases', () => {
      const oldAlias = {
        aliases: ['Alias'],
        region: ['us'],
        updatedBy: 'old-user',
        updatedAt: '2023-01-01',
      };
      const inputConfig = {
        brands: {
          aliases: [{ aliases: ['Alias'], region: ['us'] }, { aliases: ['Alias2'], region: ['us', 'gb'] }],
        },
      };
      const oldConfig = { brands: { aliases: [oldAlias] } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.brands.aliases[0].updatedBy).to.equal('old-user');
      expect(newConfig.brands.aliases[0].updatedAt).to.equal('2023-01-01');
      expect(newConfig.brands.aliases[1].updatedBy).to.equal(userId);
      expect(newConfig.brands.aliases[1].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
      expect(stats.brandAliases.modified).to.equal(1);
    });

    it('should handle competitors', () => {
      const inputConfig = {
        competitors: {
          competitors: [{ name: 'New Comp', region: ['us'] }],
        },
      };
      const oldConfig = { competitors: { competitors: [] } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.competitors.competitors[0].updatedBy).to.equal(userId);
      expect(stats.competitors.modified).to.equal(1);
    });

    it('should preserve metadata for existing competitors', () => {
      const oldComp = {
        name: 'Comp',
        region: ['us'],
        updatedBy: 'old-user',
        updatedAt: '2023-01-01',
      };
      const inputConfig = {
        competitors: {
          competitors: [{ name: 'Comp', region: ['us'] }],
        },
      };
      const oldConfig = { competitors: { competitors: [oldComp] } };

      const { newConfig, stats } = updateModifiedByDetails(inputConfig, oldConfig, userId);

      expect(newConfig.competitors.competitors[0].updatedBy).to.equal('old-user');
      expect(stats.competitors.modified).to.equal(0);
    });

    it('should count category URLs', () => {
      const inputConfig = {
        categories: {
          [categoryId]: {
            name: 'Cat',
            urls: [{ value: 'url1' }, { value: 'url2' }],
          },
        },
      };
      const { stats } = updateModifiedByDetails(inputConfig, {}, userId);
      expect(stats.categoryUrls.total).to.equal(2);
    });

    it('should handle a complex large configuration update correctly', () => {
      const oldConfig = {
        entities: {},
        categories: {
          '0b7c2cf5-a26d-4268-8ee5-81c9153b8ab4': {
            name: 'Test category 2',
            region: ['hr'],
            origin: 'human',
          },
          'bc6d47fb-cc84-46f1-9e1e-60881efef9f8': {
            name: 'Test category 3',
            region: ['us'],
            origin: 'human',
          },
          '0c3d4c48-92cd-45f2-9bf9-3ef5acd2f807': {
            name: 'Test category 4',
            region: ['gb', 'us'],
            origin: 'human',
          },
          '428ab882-9071-4edd-bf32-90d0a13011c9': {
            name: 'New category: Meaning of Names',
            region: ['ch'],
            origin: 'ai',
          },
        },
        topics: {
          '8c84907e-f83b-45d7-8520-acf677ffd986': {
            name: 'topic 1 under category 2',
            prompts: [
              {
                prompt: 'prompt 2',
                regions: ['hr'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
            ],
            category: '0b7c2cf5-a26d-4268-8ee5-81c9153b8ab4',
          },
          '1b91a3a0-adeb-4961-b408-da6a158c51f0': {
            name: 'topic under category 4',
            prompts: [
              {
                prompt: 'p1',
                regions: ['gb'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
              {
                prompt: 'p2',
                regions: ['gb', 'us'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
            ],
            category: '0c3d4c48-92cd-45f2-9bf9-3ef5acd2f807',
          },
          '581bc03b-0b96-4d2e-8081-a95e5806230d': {
            name: 'topic 2 under category 2',
            prompts: [
              {
                prompt: 'prompt 1',
                regions: ['hr'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
            ],
            category: '0b7c2cf5-a26d-4268-8ee5-81c9153b8ab4',
          },
          'c31ce269-a1b9-402d-9348-f208a918fdbe': {
            name: 'Content Strategy2',
            prompts: [
              {
                prompt: 'What type of content performs worst for our audience?',
                regions: ['gb'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
              {
                prompt: 'What type of content performs worst for our audience?',
                regions: ['gb'],
                origin: 'human',
                source: 'config',
                status: 'processing',
              },
            ],
            category: '0c3d4c48-92cd-45f2-9bf9-3ef5acd2f807',
          },
        },
        aiTopics: {
          '791f4e7a-51bf-4742-87a1-9aa89c889226': {
            name: 'combine pdfs',
            prompts: [
              {
                prompt: 'How do I combine multiple PDFs into one PDF?',
                regions: ['us'],
                origin: 'ai',
                source: 'flow',
              },
            ],
            category: '428ab882-9071-4edd-bf32-90d0a13011c9',
          },
        },
        brands: {
          aliases: [
            {
              aliases: ['Test brand aliase 1', 'Test brand aliase 2'],
              category: '428ab882-9071-4edd-bf32-90d0a13011c9',
              region: ['us'],
              aliasMode: 'extend',
            },
            {
              aliases: ['more alias'],
              category: 'bc6d47fb-cc84-46f1-9e1e-60881efef9f8',
              region: ['us'],
              aliasMode: 'extend',
            },
            {
              aliases: ['and more...'],
              aliasMode: 'extend',
            },
          ],
        },
        competitors: {
          competitors: [
            {
              category: 'bc6d47fb-cc84-46f1-9e1e-60881efef9f8',
              region: 'us',
              name: 'Adobe 1',
              aliases: ['Adobe 1'],
              urls: ['https://adobe.com'],
            },
          ],
        },
        deleted: {
          prompts: {
            'a0643aea-2d8f-46a9-8d79-7df4bf10355a': {
              prompt: 'How can I edit photos using AI?',
              regions: ['us'],
              origin: 'human',
              source: 'sheet',
              topic: 'TEST_AI_Photo/Image/Editor_Unweighted_V1',
              category: 'Firefly',
            },
            '8aafbc5b-7b7d-4364-9c50-3989b68dfb1f': {
              prompt: 'Advice on an AI image editor that doesn\'t overwhelm beginners.',
              regions: ['us'],
              origin: 'human',
              source: 'sheet',
              topic: 'TEST_AI_Photo/Image/Editor_Weighted',
              category: 'Firefly',
            },
            '4dd73661-cf64-4096-ad8e-96afdb4493d4': {
              prompt: 'Meilleur logiciel d\'IA de texte en vecteur',
              regions: ['fr'],
              origin: 'ai',
              source: 'sheet',
              topic: 'AI Text To Vector',
              category: 'Firefly',
            },
          },
        },
        cdnBucketConfig: {
          bucketName: 'cdn-logs-8c6043f15f43b6390a49401a',
          allowedPaths: ['8C6043F15F43B6390A49401AAdobeOrg/raw/byocdn-akamai/'],
          cdnProvider: 'byocdn-akamai',
        },
      };

      const newConfig = JSON.parse(JSON.stringify(oldConfig));
      newConfig.categories['0b7c2cf5-a26d-4268-8ee5-81c9153b8ab4'].name = 'Test category 2 Modified';
      newConfig.topics['8c84907e-f83b-45d7-8520-acf677ffd986'].prompts[0].prompt = 'prompt 2 modified';
      newConfig.aiTopics['791f4e7a-51bf-4742-87a1-9aa89c889226'].prompts[0].prompt = 'How do I combine multiple PDFs into one PDF? Modified';
      newConfig.brands.aliases[0].aliases.push('Test brand aliase 3');
      newConfig.competitors.competitors[0].name = 'Adobe 1 Modified';
      newConfig.deleted.prompts['new-deleted-id'] = {
        prompt: 'New deleted prompt',
        origin: 'human',
      };

      const { newConfig: resultConfig, stats } = updateModifiedByDetails(
        newConfig,
        oldConfig,
        userId,
      );

      expect(resultConfig.categories['0b7c2cf5-a26d-4268-8ee5-81c9153b8ab4'].updatedBy).to.equal(userId);
      expect(stats.categories.modified).to.equal(1);
      expect(resultConfig.topics['8c84907e-f83b-45d7-8520-acf677ffd986'].prompts[0].updatedBy).to.equal(userId);
      expect(resultConfig.topics['8c84907e-f83b-45d7-8520-acf677ffd986'].prompts[0].updatedAt).to.exist;
      expect(resultConfig.aiTopics['791f4e7a-51bf-4742-87a1-9aa89c889226'].prompts[0].updatedBy).to.equal(userId);
      expect(resultConfig.aiTopics['791f4e7a-51bf-4742-87a1-9aa89c889226'].prompts[0].updatedAt).to.exist;
      expect(stats.prompts.modified).to.equal(2);
      expect(resultConfig.brands.aliases[0].updatedBy).to.equal(userId);
      expect(stats.brandAliases.modified).to.equal(1);
      expect(resultConfig.competitors.competitors[0].updatedBy).to.equal(userId);
      expect(stats.competitors.modified).to.equal(1);
      expect(resultConfig.deleted.prompts['new-deleted-id'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should handle undefined oldConfig', () => {
      const updates = {
        categories: {
          'cat-1': { name: 'New Cat', region: ['us'] },
        },
      };
      const { newConfig, stats } = updateModifiedByDetails(updates, undefined, userId);

      expect(newConfig.categories['cat-1']).to.deep.include(updates.categories['cat-1']);
      expect(newConfig.categories['cat-1'].updatedBy).to.equal(userId);
      expect(stats.categories.modified).to.equal(1);
    });
  });
});
