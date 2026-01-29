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
import { mergeCustomerConfigV2 } from '../../src/support/customer-config-v2-metadata.js';

describe('Customer Config V2 Metadata', () => {
  describe('mergeCustomerConfigV2', () => {
    const userId = 'test-user@example.com';

    it('should merge new brands with existing config', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-2',
              name: 'Brand Two',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands).to.have.lengthOf(1);
      expect(mergedConfig.customer.brands[0].id).to.equal('brand-2');
      expect(mergedConfig.customer.brands[0].updatedBy).to.equal(userId);
      expect(stats.brands.total).to.equal(1);
      expect(stats.brands.modified).to.equal(1);
    });

    it('should preserve metadata for unchanged brands', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.brands[0].updatedAt).to.equal('2026-01-01T00:00:00.000Z');
      expect(stats.brands.modified).to.equal(0);
    });

    it('should update metadata for modified brands', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One Updated',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].name).to.equal('Brand One Updated');
      expect(mergedConfig.customer.brands[0].updatedBy).to.equal(userId);
      expect(mergedConfig.customer.brands[0].updatedAt).to.not.equal('2026-01-01T00:00:00.000Z');
      expect(stats.brands.modified).to.equal(1);
    });

    it('should merge categories', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            {
              id: 'cat-1',
              name: 'Category One',
              status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          categories: [
            {
              id: 'cat-2',
              name: 'Category Two',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.categories).to.have.lengthOf(1);
      expect(mergedConfig.customer.categories[0].id).to.equal('cat-2');
      expect(stats.categories.total).to.equal(1);
      expect(stats.categories.modified).to.equal(1);
    });

    it('should merge brand prompts', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'prompt-1',
                  prompt: 'What is this?',
                  status: 'active',
                  updatedBy: 'old-user@example.com',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'prompt-1',
                  prompt: 'What is this?',
                  status: 'active',
                },
                {
                  id: 'prompt-2',
                  prompt: 'New prompt',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].prompts).to.have.lengthOf(2);
      expect(mergedConfig.customer.brands[0].prompts[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.brands[0].prompts[1].updatedBy).to.equal(userId);
      expect(stats.prompts.total).to.equal(2);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should preserve existing customer fields when not in updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          availableVerticals: ['Software & Technology'],
          brands: [],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.customerName).to.equal('Test Customer');
      expect(mergedConfig.customer.imsOrgID).to.equal('TEST123@AdobeOrg');
      expect(mergedConfig.customer.availableVerticals).to.deep.equal(['Software & Technology']);
    });

    it('should handle null existing config', () => {
      const updates = {
        customer: {
          customerName: 'New Customer',
          imsOrgID: 'NEW123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, null, userId);

      expect(mergedConfig.customer.customerName).to.equal('New Customer');
      expect(mergedConfig.customer.brands).to.have.lengthOf(1);
      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle empty arrays in updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands).to.have.lengthOf(0);
      expect(stats.brands.total).to.equal(0);
    });

    it('should preserve categories when not in updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            {
              id: 'cat-1',
              name: 'Category One',
              status: 'active',
            },
          ],
          brands: [],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.categories).to.have.lengthOf(1);
      expect(mergedConfig.customer.categories[0].name).to.equal('Category One');
    });

    it('should count existing prompts when brands not in updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                { id: 'p1', prompt: 'Q1', status: 'active' },
                { id: 'p2', prompt: 'Q2', status: 'active' },
              ],
            },
          ],
        },
      };

      const updates = {
        customer: {
          categories: [
            {
              id: 'cat-1',
              name: 'Category One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands).to.have.lengthOf(1);
      expect(stats.prompts.total).to.equal(2);
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should handle brands without prompts', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      // When prompts is not in the update, it should be undefined/not set
      expect(mergedConfig.customer.brands[0].prompts).to.be.undefined;
      expect(stats.prompts.total).to.equal(0);
    });

    it('should handle updates without customer object', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [],
        },
      };

      const updates = {};

      const { mergedConfig } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.customerName).to.equal('Test Customer');
      expect(mergedConfig.customer.imsOrgID).to.equal('TEST123@AdobeOrg');
    });

    it('should preserve topics when not in updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          topics: [
            {
              id: 'topic-1',
              name: 'Topic One',
              categoryId: 'cat-1',
              status: 'active',
            },
          ],
          brands: [],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.topics).to.have.lengthOf(1);
      expect(mergedConfig.customer.topics[0].name).to.equal('Topic One');
      expect(stats.topics.total).to.equal(1);
    });

    it('should merge topics', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          topics: [
            {
              id: 'topic-1',
              name: 'Topic One',
              categoryId: 'cat-1',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      const updates = {
        customer: {
          topics: [
            {
              id: 'topic-1',
              name: 'Topic One Updated',
              categoryId: 'cat-1',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.topics[0].name).to.equal('Topic One Updated');
      expect(mergedConfig.customer.topics[0].updatedBy).to.equal(userId);
      expect(stats.topics.modified).to.equal(1);
    });

    it('should preserve metadata for unchanged array items', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            {
              id: 'cat-1',
              name: 'Category One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      // Same content, should preserve metadata
      const updates = {
        customer: {
          categories: [
            {
              id: 'cat-1',
              name: 'Category One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.categories[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.categories[0].updatedAt).to.equal('2026-01-01T00:00:00.000Z');
      expect(stats.categories.modified).to.equal(0);
    });

    it('should handle array comparisons with different lengths', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['US', 'GB'],
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      // Same content but different region array should update
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['US'], // Changed array length
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].region).to.deep.equal(['US']);
      expect(mergedConfig.customer.brands[0].updatedBy).to.equal(userId);
      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle array comparisons with different order', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['US', 'GB', 'DE'],
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      // Same items but different order should NOT update (order-independent comparison)
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['GB', 'DE', 'US'], // Same items, different order
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.brands[0].updatedAt).to.equal('2026-01-01T00:00:00.000Z');
      expect(stats.brands.modified).to.equal(0);
    });

    it('should handle nested objects in arrays', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              urls: [
                { value: 'https://example.com', regions: ['US'] },
              ],
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      };

      // Same nested objects should preserve metadata
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              urls: [
                { value: 'https://example.com', regions: ['US'] },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].updatedBy).to.equal('old-user@example.com');
      expect(stats.brands.modified).to.equal(0);
    });

    it('should update prompts and preserve brand metadata when only prompts change', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              updatedBy: 'old-user@example.com',
              updatedAt: '2026-01-01T00:00:00.000Z',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                  updatedBy: 'old-user@example.com',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          ],
        },
      };

      // Update prompt but not brand
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1 Updated',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      // Brand metadata should be preserved
      expect(mergedConfig.customer.brands[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.brands[0].updatedAt).to.equal('2026-01-01T00:00:00.000Z');

      // But prompt should be updated
      expect(mergedConfig.customer.brands[0].prompts[0].prompt).to.equal('Question 1 Updated');
      expect(mergedConfig.customer.brands[0].prompts[0].updatedBy).to.equal(userId);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should preserve prompt metadata when prompt is unchanged', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                  regions: ['US', 'GB'],
                  updatedBy: 'old-user@example.com',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          ],
        },
      };

      // Same prompt content
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                  regions: ['US', 'GB'],
                },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].prompts[0].updatedBy).to.equal('old-user@example.com');
      expect(mergedConfig.customer.brands[0].prompts[0].updatedAt).to.equal('2026-01-01T00:00:00.000Z');
      expect(stats.prompts.modified).to.equal(0);
    });

    it('should handle adding new prompts to existing brand', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      // Add a new prompt
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                },
                {
                  id: 'p2',
                  prompt: 'Question 2',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].prompts).to.have.lengthOf(2);
      expect(stats.prompts.total).to.equal(2);
      expect(stats.prompts.modified).to.equal(1); // Only the new prompt
    });

    it('should handle brands with prompts when old brand has no prompts', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              // No prompts field
            },
          ],
        },
      };

      // Add prompts to existing brand
      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Question 1',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].prompts).to.have.lengthOf(1);
      expect(mergedConfig.customer.brands[0].prompts[0].id).to.equal('p1');
      expect(stats.prompts.total).to.equal(1);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should handle null/undefined arrays gracefully', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
        },
      };

      // Updates with null/undefined should be handled gracefully
      const updates = {
        customer: {
          categories: null, // This should be treated as no update
          brands: undefined, // This should be treated as no update
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.customerName).to.equal('Test Customer');
      expect(stats.categories.total).to.equal(0);
      expect(stats.brands.total).to.equal(0);
    });

    it('should handle reduce operation when counting prompts from preserved brands', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                { id: 'p1', prompt: 'Q1', status: 'active' },
                { id: 'p2', prompt: 'Q2', status: 'active' },
              ],
            },
            {
              id: 'brand-2',
              name: 'Brand Two',
              status: 'active',
              prompts: [
                { id: 'p3', prompt: 'Q3', status: 'active' },
              ],
            },
            {
              id: 'brand-3',
              name: 'Brand Three',
              status: 'active',
              // No prompts
            },
          ],
        },
      };

      // Update something else, brands should be preserved
      const updates = {
        customer: {
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      // All brands should be preserved
      expect(mergedConfig.customer.brands).to.have.lengthOf(3);
      // Should correctly count prompts across all brands
      expect(stats.prompts.total).to.equal(3); // 2 + 1 + 0
    });

    it('should handle complex nested updates with mixed changes', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' },
          ],
          topics: [
            {
              id: 'topic-1', name: 'Topic One', categoryId: 'cat-1', status: 'active',
            },
          ],
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1', prompt: 'Q1', status: 'active', regions: ['US'],
                },
              ],
            },
          ],
        },
      };

      // Complex update: add category, update topic, add brand, update prompt
      const updates = {
        customer: {
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' }, // unchanged
            { id: 'cat-2', name: 'Category Two', status: 'active' }, // new
          ],
          topics: [
            {
              id: 'topic-1', name: 'Topic One Modified', categoryId: 'cat-1', status: 'active',
            }, // changed
          ],
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1', prompt: 'Q1 Updated', status: 'active', regions: ['US', 'GB'],
                }, // changed
              ],
            },
            {
              id: 'brand-2',
              name: 'Brand Two',
              status: 'active', // new brand
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      // Verify categories
      expect(stats.categories.total).to.equal(2);
      expect(stats.categories.modified).to.equal(1); // Only cat-2 is new

      // Verify topics
      expect(stats.topics.total).to.equal(1);
      expect(stats.topics.modified).to.equal(1); // topic-1 was modified

      // Verify brands
      expect(stats.brands.total).to.equal(2);
      expect(stats.brands.modified).to.equal(1); // Only brand-2 is new

      // Verify prompts
      expect(stats.prompts.total).to.equal(1);
      expect(stats.prompts.modified).to.equal(1); // p1 was modified

      // Check content
      expect(mergedConfig.customer.categories[1].name).to.equal('Category Two');
      expect(mergedConfig.customer.topics[0].name).to.equal('Topic One Modified');
      expect(mergedConfig.customer.brands[0].prompts[0].prompt).to.equal('Q1 Updated');
      expect(mergedConfig.customer.brands[1].name).to.equal('Brand Two');
    });

    it('should handle availableVerticals preservation', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          availableVerticals: ['Technology', 'Finance', 'Healthcare'],
        },
      };

      const updates = {
        customer: {
          brands: [
            { id: 'brand-1', name: 'Brand One', status: 'active' },
          ],
        },
      };

      const { mergedConfig } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.availableVerticals).to.deep.equal(['Technology', 'Finance', 'Healthcare']);
    });

    // Additional edge case tests for deep equality
    it('should handle null comparisons in deepEqual', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              description: null,
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              description: null,
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(0);
    });

    it('should detect when object keys differ', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              newField: 'new value',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
      expect(mergedConfig.customer.brands[0].newField).to.equal('new value');
    });

    it('should handle primitive types in deepEqual', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              priority: 1,
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              priority: 2,
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle comparing non-objects', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              active: true,
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              active: false,
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle array vs non-array comparison', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              tags: ['tag1', 'tag2'],
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              tags: 'tag1',
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle key existence check', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              metadata: { key1: 'value1', key2: 'value2' },
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              metadata: { key1: 'value1', key3: 'value3' },
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle items without id field', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            { name: 'Category One', status: 'active' },
          ],
        },
      };

      const updates = {
        customer: {
          categories: [
            { name: 'Category Two', status: 'active' },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.categories.total).to.equal(1);
      expect(stats.categories.modified).to.equal(1);
    });

    it('should handle identical primitive values in arrays', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['US'],
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              region: ['US'],
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(0);
    });

    it('should handle typeof checks for non-objects', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              count: 5,
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              count: '5',
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle brands with existing prompts being updated', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'Old Question',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                {
                  id: 'p1',
                  prompt: 'New Question',
                  status: 'active',
                },
              ],
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.prompts.modified).to.equal(1);
      expect(stats.brands.modified).to.equal(0);
    });

    it('should handle new brand without prompts field in existing config', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.total).to.equal(1);
      expect(stats.brands.modified).to.equal(1);
      // Should not have prompts field unless explicitly added
      expect(mergedConfig.customer.brands[0].prompts).to.be.undefined;
    });

    it('should update topics without categories', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          topics: [
            {
              id: 'topic-1',
              name: 'Topic One',
              categoryId: 'cat-1',
              status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          topics: [
            {
              id: 'topic-1',
              name: 'Topic One Updated',
              categoryId: 'cat-1',
              status: 'active',
            },
            {
              id: 'topic-2',
              name: 'Topic Two',
              categoryId: 'cat-1',
              status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.topics).to.have.lengthOf(2);
      expect(stats.topics.total).to.equal(2);
      expect(stats.topics.modified).to.equal(2);
    });

    it('should handle empty existing config with full updates', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
        },
      };

      const updates = {
        customer: {
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' },
          ],
          topics: [
            {
              id: 'topic-1', name: 'Topic One', categoryId: 'cat-1', status: 'active',
            },
          ],
          brands: [
            { id: 'brand-1', name: 'Brand One', status: 'active' },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.categories.total).to.equal(1);
      expect(stats.topics.total).to.equal(1);
      expect(stats.brands.total).to.equal(1);
      expect(mergedConfig.customer.customerName).to.equal('Test Customer');
    });

    it('should handle object with different number of keys', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              extraField: 'some value',
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.modified).to.equal(1);
    });

    it('should handle updates with null values in customer object', () => {
      const existingConfig = null;

      const updates = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: null,
        },
      };

      const { mergedConfig } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.customerName).to.equal('Test Customer');
    });

    it('should handle prompts array with forEach iteration', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                { id: 'p1', prompt: 'Q1', status: 'active' },
                { id: 'p2', prompt: 'Q2', status: 'active' },
                { id: 'p3', prompt: 'Q3', status: 'active' },
              ],
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                { id: 'p1', prompt: 'Q1', status: 'active' },
                { id: 'p2', prompt: 'Q2 Updated', status: 'active' },
                { id: 'p4', prompt: 'Q4', status: 'active' },
              ],
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.prompts.total).to.equal(3);
      expect(stats.prompts.modified).to.equal(2);
    });

    it('should handle categories forEach with existing old items', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' },
            { id: 'cat-2', name: 'Category Two', status: 'active' },
            { id: 'cat-3', name: 'Category Three', status: 'active' },
          ],
        },
      };

      const updates = {
        customer: {
          categories: [
            { id: 'cat-1', name: 'Category One', status: 'active' },
            { id: 'cat-2', name: 'Category Two Updated', status: 'active' },
            { id: 'cat-4', name: 'Category Four', status: 'active' },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.categories.total).to.equal(3);
      expect(stats.categories.modified).to.equal(2);
    });

    it('should handle topics forEach with map building', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          topics: [
            {
              id: 'topic-1', name: 'Topic One', categoryId: 'cat-1', status: 'active',
            },
            {
              id: 'topic-2', name: 'Topic Two', categoryId: 'cat-1', status: 'active',
            },
          ],
        },
      };

      const updates = {
        customer: {
          topics: [
            {
              id: 'topic-1', name: 'Topic One', categoryId: 'cat-1', status: 'active',
            },
            {
              id: 'topic-3', name: 'Topic Three', categoryId: 'cat-2', status: 'active',
            },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.topics.total).to.equal(2);
      expect(stats.topics.modified).to.equal(1);
    });

    it('should handle brands forEach with map building', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            { id: 'brand-1', name: 'Brand One', status: 'active' },
            { id: 'brand-2', name: 'Brand Two', status: 'active' },
            { id: 'brand-3', name: 'Brand Three', status: 'active' },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            { id: 'brand-1', name: 'Brand One', status: 'active' },
            { id: 'brand-2', name: 'Brand Two Modified', status: 'active' },
            { id: 'brand-4', name: 'Brand Four', status: 'active' },
          ],
        },
      };

      const { stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.total).to.equal(3);
      expect(stats.brands.modified).to.equal(2);
    });

    it('should handle undefined oldConfig topics triggering || [] fallback', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          // topics field is completely missing (undefined)
        },
      };

      const updates = {
        customer: {
          topics: [
            {
              id: 'topic-1', name: 'Topic One', categoryId: 'cat-1', status: 'active',
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.topics.total).to.equal(1);
      expect(stats.topics.modified).to.equal(1);
      expect(mergedConfig.customer.topics).to.have.lengthOf(1);
    });

    it('should handle brand with undefined prompts triggering || [] fallback', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              // prompts field completely missing (undefined)
            },
          ],
        },
      };

      const updates = {
        customer: {
          brands: [
            {
              id: 'brand-1',
              name: 'Brand One',
              status: 'active',
              prompts: [
                { id: 'p1', prompt: 'New Prompt', status: 'active' },
              ],
            },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(mergedConfig.customer.brands[0].prompts).to.have.lengthOf(1);
      expect(stats.prompts.total).to.equal(1);
      expect(stats.prompts.modified).to.equal(1);
    });

    it('should handle undefined oldBrands triggering || [] fallback', () => {
      const existingConfig = {
        customer: {
          customerName: 'Test Customer',
          imsOrgID: 'TEST123@AdobeOrg',
          // brands field completely missing (undefined)
        },
      };

      const updates = {
        customer: {
          brands: [
            { id: 'brand-1', name: 'Brand One', status: 'active' },
          ],
        },
      };

      const { mergedConfig, stats } = mergeCustomerConfigV2(updates, existingConfig, userId);

      expect(stats.brands.total).to.equal(1);
      expect(stats.brands.modified).to.equal(1);
      expect(mergedConfig.customer.brands).to.have.lengthOf(1);
    });
  });
});
