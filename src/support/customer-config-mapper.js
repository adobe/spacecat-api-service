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

import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import crypto from 'crypto';

/**
 * Default verticals list for migration/initialization.
 * In production, verticals should be managed in the stored S3 config.
 */
const DEFAULT_VERTICALS = [
  'News & Entertainment',
  'Software & Technology',
  'IT Services',
  'Manufacture',
  'Healthcare',
  'Pharmaceutical',
  'Foods & Nutrition',
  'Transportation',
  'Hospitality',
  'Travel & Tourism',
  'Automotive',
  'Freight & Logistics',
  'Retail',
  'FSI (Financial Services & Insurance)',
  'Energy',
  'NGO',
  'Education',
  'Real Estate & Construction',
  'Legal Services',
  'Telecommunications',
  'Professional Services',
  'Government & Public Services',
];

/**
 * Generates a deterministic hash from a string.
 * @param {string} input - Input string to hash
 * @returns {string} 8-character hash
 */
function generateHash(input) {
  return crypto.createHash('md5').update(input).digest('hex').substring(0, 8);
}

/**
 * Generates a brand ID from brand name (slug format).
 * @param {string} brandName - Brand name
 * @returns {string} Brand ID (e.g., "adobe" for "Adobe")
 */
function generateBrandId(brandName) {
  return brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Generates a deterministic prompt ID from brand name and prompt text.
 * @param {string} brandName - Brand name
 * @param {string} promptText - Prompt text
 * @returns {string} Prompt ID (e.g., "adobe-a1b2c3d4")
 */
function generatePromptId(brandName, promptText) {
  const brandSlug = brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const hash = generateHash(`${brandSlug}:${promptText}`);
  return `${brandSlug}-${hash}`;
}

/**
 * Converts LLMO config (V1) to Customer Config (V2)
 * @param {object} llmoConfig - V1 LLMO configuration
 * @param {string} brandName - Brand name to use
 * @param {string} imsOrgId - IMS Organization ID
 * @returns {object} V2 Customer configuration
 */
export function convertV1ToV2(llmoConfig, brandName, imsOrgId) {
  if (!isNonEmptyObject(llmoConfig)) {
    throw new Error('LLMO config is required');
  }

  if (!hasText(brandName) || !hasText(imsOrgId)) {
    throw new Error('Brand name and IMS Org ID are required');
  }

  const brands = [];

  // Collect all unique regions from V1 config
  const allRegions = new Set();
  const allUrls = new Set();

  // From brand aliases
  const brandAliases = llmoConfig.brands?.aliases || [];
  brandAliases.forEach((alias) => {
    const regions = alias.region || alias.regions || [];
    regions.forEach((r) => allRegions.add(r.toLowerCase()));
  });

  // From competitors
  (llmoConfig.competitors?.competitors || []).forEach((comp) => {
    (comp.regions || []).forEach((r) => allRegions.add(r.toLowerCase()));
  });

  // From categories
  const categories = llmoConfig.categories || {};
  Object.values(categories).forEach((category) => {
    let regions = [];
    if (Array.isArray(category.region)) {
      regions = category.region;
    } else if (category.region) {
      regions = [category.region];
    }
    regions.forEach((r) => allRegions.add(r.toLowerCase()));

    // Collect URLs from categories
    (category.urls || []).forEach((urlObj) => {
      if (urlObj.value) {
        allUrls.add(urlObj.value);
      }
    });
  });

  // From topics/prompts
  const topics = llmoConfig.topics || {};
  Object.values(topics).forEach((topic) => {
    (topic.prompts || []).forEach((prompt) => {
      (prompt.regions || []).forEach((r) => allRegions.add(r.toLowerCase()));
    });
  });

  const brandRegions = allRegions.size > 0 ? Array.from(allRegions) : ['gl'];
  const brandUrls = Array.from(allUrls).map((url) => ({ value: url, type: 'url' }));

  // Only create a brand if we have brand aliases
  if (brandAliases.length === 0) {
    return {
      customer: {
        customerName: brandName,
        imsOrgID: imsOrgId,
        categories: [],
        topics: [],
        brands: [],
        cdnBucketConfigs: [],
        availableVerticals: DEFAULT_VERTICALS,
      },
    };
  }

  const primaryAlias = brandAliases[0];
  const actualBrandName = primaryAlias.name
    || (primaryAlias.aliases && primaryAlias.aliases[0])
    || brandName;
  const brandId = generateBrandId(actualBrandName);

  const brand = {
    id: brandId,
    v1SiteId: null,
    baseUrl: null, // Will be set by script from mapping
    name: actualBrandName,
    status: primaryAlias.status || 'active',
    origin: 'system',
    region: brandRegions,
    description: '',
    updatedAt: primaryAlias.updatedAt || new Date().toISOString(),
    updatedBy: 'system',
    vertical: '',
    urls: brandUrls,
    socialAccounts: [],
    brandAliases: brandAliases.map((alias) => ({
      name: alias.name || (alias.aliases && alias.aliases[0]) || brandName,
      regions: alias.region || alias.regions || ['gl'],
    })),
    competitors: (llmoConfig.competitors?.competitors || []).map((comp) => ({
      name: comp.name,
      url: comp.url || '',
      regions: comp.regions || ['gl'],
    })),
    relatedBrands: [],
    earnedContent: [],
    prompts: [], // Flat list of prompts with categoryId/topicId references
  };

  // Build top-level categories collection
  const categoriesCollection = [];
  Object.entries(categories).forEach(([categoryUuid, category]) => {
    categoriesCollection.push({
      id: categoryUuid,
      name: category.name,
      status: 'active',
      origin: category.origin || 'human',
      updatedBy: category.updatedBy || 'system',
      updatedAt: category.updatedAt || new Date().toISOString(),
    });
  });

  // Build top-level topics collection
  const topicsCollection = [];

  // Flatten all prompts from categories/topics into brand.prompts[]
  Object.entries(categories).forEach(([categoryUuid]) => {
    // Process regular topics
    Object.entries(topics).forEach(([topicUuid, topic]) => {
      if (topic.category === categoryUuid) {
        // Add topic to collection (only once)
        if (!topicsCollection.find((t) => t.id === topicUuid)) {
          topicsCollection.push({
            id: topicUuid,
            name: topic.name,
            status: 'active',
            categoryId: categoryUuid,
          });
        }

        // Add prompts with ID references
        (topic.prompts || []).forEach((prompt) => {
          brand.prompts.push({
            id: prompt.id || generatePromptId(brandName, prompt.prompt),
            prompt: prompt.prompt,
            status: prompt.status || 'active',
            regions: prompt.regions || ['gl'],
            origin: prompt.origin || 'human',
            source: prompt.source || 'config',
            updatedBy: prompt.updatedBy || 'system',
            updatedAt: prompt.updatedAt || new Date().toISOString(),
            categoryId: categoryUuid,
            topicId: topicUuid,
          });
        });
      }
    });

    // Process AI topics
    const aiTopics = llmoConfig.aiTopics || {};
    Object.entries(aiTopics).forEach(([topicUuid, topic]) => {
      if (topic.category === categoryUuid) {
        // Add topic to collection (only once)
        if (!topicsCollection.find((t) => t.id === topicUuid)) {
          topicsCollection.push({
            id: topicUuid,
            name: topic.name,
            status: 'active',
            categoryId: categoryUuid,
          });
        }

        // Add prompts with ID references
        (topic.prompts || []).forEach((prompt) => {
          brand.prompts.push({
            id: prompt.id || generatePromptId(brandName, prompt.prompt),
            prompt: prompt.prompt,
            status: prompt.status || 'active',
            regions: prompt.regions || ['gl'],
            origin: 'ai',
            source: prompt.source || 'flow',
            updatedBy: prompt.updatedBy || 'system',
            updatedAt: prompt.updatedAt || new Date().toISOString(),
            categoryId: categoryUuid,
            topicId: topicUuid,
          });
        });
      }
    });
  });

  // Add deleted prompts - create categories/topics with status 'deleted' if they don't exist
  const deletedPrompts = llmoConfig.deleted?.prompts || {};
  Object.entries(deletedPrompts).forEach(([promptId, prompt]) => {
    // Find category UUID by name
    const categoryEntry = Object.entries(categories).find(
      ([, cat]) => cat.name === prompt.category,
    );
    const categoryUuid = categoryEntry
      ? categoryEntry[0]
      : `deleted-category-${prompt.category.toLowerCase().replace(/\s+/g, '-')}`;

    // Generate topic UUID from name
    const topicUuid = `deleted-topic-${prompt.topic.toLowerCase().replace(/\s+/g, '-')}`;

    // Add deleted category if it doesn't exist (mark as deleted)
    if (!categoryEntry && !categoriesCollection.find((c) => c.id === categoryUuid)) {
      categoriesCollection.push({
        id: categoryUuid,
        name: prompt.category,
        status: 'deleted',
        origin: 'human',
        updatedBy: 'system',
        updatedAt: new Date().toISOString(),
      });
    }

    // Add deleted topic if it doesn't exist (mark as deleted)
    if (!topicsCollection.find((t) => t.id === topicUuid)) {
      topicsCollection.push({
        id: topicUuid,
        name: prompt.topic,
        status: 'deleted',
        categoryId: categoryUuid,
      });
    }

    brand.prompts.push({
      id: promptId,
      prompt: prompt.prompt,
      status: 'deleted',
      regions: prompt.regions || ['gl'],
      origin: prompt.origin || 'human',
      source: prompt.source || 'config',
      updatedBy: prompt.updatedBy || 'system',
      updatedAt: prompt.updatedAt || new Date().toISOString(),
      categoryId: categoryUuid,
      topicId: topicUuid,
    });
  });

  brands.push(brand);

  return {
    customer: {
      customerName: brandName, // Will be overwritten by script
      imsOrgID: imsOrgId,
      categories: categoriesCollection,
      topics: topicsCollection,
      brands,
      cdnBucketConfigs: [], // Will be populated by script from all V1 configs
      availableVerticals: DEFAULT_VERTICALS,
    },
  };
}

export { generateBrandId };

export default {
  convertV1ToV2,
};
