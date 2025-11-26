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
import { updateConfigMetadata, deepEqual } from '../../../src/controllers/llmo/llmo-config-metadata.js';

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

  describe('updateConfigMetadata', () => {
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers(new Date('2024-01-01T00:00:00Z').getTime());
    });

    afterEach(() => {
      clock.restore();
    });

    it('should initialize stats correctly for empty config', () => {
      const stats = updateConfigMetadata({}, {}, userId);
      expect(stats).to.deep.equal({
        categories: { total: 0, modified: 0 },
        topics: { total: 0, modified: 0 },
        prompts: { total: 0, modified: 0 },
        brandAliases: { total: 0, modified: 0 },
        competitors: { total: 0, modified: 0 },
        deletedPrompts: { total: 0, modified: 0 },
        categoryUrls: { total: 0 },
      });
    });

    it('should update metadata for new category', () => {
      const newConfig = {
        categories: {
          [categoryId]: { name: 'New Cat', region: ['us'], urls: [{ value: 'url1' }, { value: 'url2' }] },
        },
      };
      const oldConfig = {};

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = { categories: { [categoryId]: { ...category } } };
      const oldConfig = { categories: { [categoryId]: { ...category } } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = { categories: { [categoryId]: newCategory } };
      const oldConfig = { categories: { [categoryId]: oldCategory } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.equal(userId);
      expect(newConfig.categories[categoryId].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
      expect(stats.categories.modified).to.equal(1);
    });

    it('should skip metadata update for AI category (implied by origin check)', () => {
      const newConfig = {
        categories: {
          [categoryId]: { name: 'AI Cat', region: ['us'], origin: 'ai' },
        },
      };
      const oldConfig = {};

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.categories[categoryId].updatedBy).to.be.undefined;
      expect(stats.categories.modified).to.equal(0);
    });

    it('should handle prompts correctly (new prompt)', () => {
      const newConfig = {
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

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = {
        topics: {
          [topicId]: { prompts: [{ ...prompt }] },
        },
      };
      const oldConfig = {
        topics: {
          [topicId]: { prompts: [{ ...prompt }] },
        },
      };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = {
        topics: {
          [topicId]: { prompts: [newPrompt] },
        },
      };
      const oldConfig = {
        topics: {
          [topicId]: { prompts: [oldPrompt] },
        },
      };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.equal('old-user');
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should skip AI prompts', () => {
      const newConfig = {
        topics: {
          [topicId]: {
            prompts: [{ prompt: 'AI Prompt', origin: 'ai' }],
          },
        },
      };
      const oldConfig = {};

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.topics[topicId].prompts[0].updatedBy).to.be.undefined;
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should handle deleted prompts', () => {
      const newConfig = {
        deleted: {
          prompts: {
            'del-1': { prompt: 'Deleted', origin: 'human' },
          },
        },
      };
      const oldConfig = {};

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.deleted.prompts['del-1'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should handle deleted prompts when old config has no deleted section', () => {
      const newConfig = {
        deleted: {
          prompts: {
            'del-1': { prompt: 'Deleted', origin: 'human' },
          },
        },
      };
      const oldConfig = { categories: {} }; // No deleted section

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = {
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

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.deleted.prompts['del-1'].updatedBy).to.equal('old');
      expect(newConfig.deleted.prompts['del-1'].updatedAt).to.equal('2023');
      expect(newConfig.deleted.prompts['del-2'].updatedBy).to.equal(userId);
      expect(stats.deletedPrompts.modified).to.equal(1);
    });

    it('should handle brand aliases', () => {
      const newConfig = {
        brands: {
          aliases: [{ aliases: ['New Alias'], region: ['us'] }],
        },
      };
      const oldConfig = { brands: { aliases: [] } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = {
        brands: {
          aliases: [{ aliases: ['Alias'], region: ['us'] }, { aliases: ['Alias2'], region: ['us', 'gb'] }],
        },
      };
      const oldConfig = { brands: { aliases: [oldAlias] } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.brands.aliases[0].updatedBy).to.equal('old-user');
      expect(newConfig.brands.aliases[0].updatedAt).to.equal('2023-01-01');
      expect(newConfig.brands.aliases[1].updatedBy).to.equal(userId);
      expect(newConfig.brands.aliases[1].updatedAt).to.equal('2024-01-01T00:00:00.000Z');
      expect(stats.brandAliases.modified).to.equal(1);
    });

    it('should handle competitors', () => {
      const newConfig = {
        competitors: {
          competitors: [{ name: 'New Comp', region: ['us'] }],
        },
      };
      const oldConfig = { competitors: { competitors: [] } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

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
      const newConfig = {
        competitors: {
          competitors: [{ name: 'Comp', region: ['us'] }],
        },
      };
      const oldConfig = { competitors: { competitors: [oldComp] } };

      const stats = updateConfigMetadata(newConfig, oldConfig, userId);

      expect(newConfig.competitors.competitors[0].updatedBy).to.equal('old-user');
      expect(stats.competitors.modified).to.equal(0);
    });

    it('should count category URLs', () => {
      const newConfig = {
        categories: {
          [categoryId]: {
            name: 'Cat',
            urls: [{ value: 'url1' }, { value: 'url2' }],
          },
        },
      };
      const stats = updateConfigMetadata(newConfig, {}, userId);
      expect(stats.categoryUrls.total).to.equal(2);
    });
  });
});
