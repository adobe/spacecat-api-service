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

/**
 * Generates a brand ID from brand name
 * @param {string} brandName - Brand name
 * @returns {string} Brand ID
 */
function generateBrandId(brandName) {
  return brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Generates a prompt ID
 * @param {string} brandName - Brand name
 * @param {number} index - Prompt index
 * @returns {string} Prompt ID
 */
function generatePromptId(brandName, index) {
  const brandSlug = brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${brandSlug}-prompt-${index}`;
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
        availableVerticals: [
          'News & Entertainment',
          'Software & Technology',
          'Consumer Goods & Services',
          'Finance & Insurance',
          'Healthcare',
          'Travel & Hospitality',
          'Automotive',
          'Real Estate',
          'Energy & Utilities',
          'Telecommunications',
          'Other',
        ],
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
            id: prompt.id || generatePromptId(brandName, Math.random()),
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
            id: prompt.id || generatePromptId(brandName, Math.random()),
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
      availableVerticals: [
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
      ],
    },
  };
}

/**
 * Converts Customer Config (V2) to LLMO config (V1)
 * @param {object} customerConfig - V2 Customer configuration
 * @returns {object} V1 LLMO configuration
 */
export function convertV2ToV1(customerConfig) {
  if (!isNonEmptyObject(customerConfig?.customer)) {
    throw new Error('Customer config is required');
  }

  const { customer } = customerConfig;
  const brands = customer.brands || [];

  if (brands.length === 0) {
    throw new Error('At least one brand is required');
  }

  const brand = brands[0];

  // Build lookup maps from top-level collections OR from inline prompt data
  const categoriesMap = new Map();
  (customer.categories || []).forEach((cat) => {
    categoriesMap.set(cat.id, cat);
  });

  const topicsMap = new Map();
  (customer.topics || []).forEach((topic) => {
    topicsMap.set(topic.id, topic);
  });

  // If categories/topics not in collections, extract from prompts
  if (brands.length > 0) {
    brands[0].prompts?.forEach((prompt) => {
      if (prompt.category && !categoriesMap.has(prompt.category.id)) {
        categoriesMap.set(prompt.category.id, prompt.category);
      }
      if (prompt.topic && !topicsMap.has(prompt.topic.id)) {
        topicsMap.set(prompt.topic.id, prompt.topic);
      }
    });
  }

  const llmoConfig = {
    entities: {},
    categories: {},
    topics: {},
    aiTopics: {},
    deleted: {
      prompts: {},
    },
    brands: {
      aliases: brand.brandAliases.map((alias) => {
        // Find first active category from prompts
        const firstActivePrompt = brand.prompts.find((p) => p.status !== 'deleted');
        const firstCategoryId = firstActivePrompt?.categoryId || null;
        return {
          aliases: [alias.name],
          category: firstCategoryId,
          region: alias.regions,
          aliasMode: 'extend',
          updatedBy: brand.updatedBy || 'system',
          updatedAt: brand.updatedAt || new Date().toISOString(),
        };
      }),
    },
    competitors: {
      competitors: brand.competitors.map((comp) => ({
        name: comp.name,
        url: comp.url,
        regions: comp.regions,
      })),
    },
  };

  // Add cdnBucketConfig from customer level if this brand's baseUrl matches
  if (customer.cdnBucketConfigs
    && customer.cdnBucketConfigs.length > 0
    && brand.baseUrl) {
    const matchingCdnConfig = customer.cdnBucketConfigs.find(
      (config) => config.urls && config.urls.includes(brand.baseUrl),
    );

    if (matchingCdnConfig) {
      // eslint-disable-next-line no-unused-vars
      const { urls: _urls, ...cdnConfig } = matchingCdnConfig;
      llmoConfig.cdnBucketConfig = cdnConfig;
    }
  }

  // Rebuild V1 structure by grouping prompts
  const promptsByTopic = new Map();

  brand.prompts.forEach((prompt) => {
    // Handle both inline objects and ID references
    const categoryId = prompt.categoryId || prompt.category?.id;
    const topicId = prompt.topicId || prompt.topic?.id;

    if (!categoryId || !topicId) return;

    const key = `${categoryId}::${topicId}`;

    if (!promptsByTopic.has(key)) {
      promptsByTopic.set(key, []);
    }
    promptsByTopic.get(key).push(prompt);
  });

  // Process grouped prompts
  promptsByTopic.forEach((prompts, key) => {
    const [categoryId, topicId] = key.split('::');
    const category = categoriesMap.get(categoryId);
    const topic = topicsMap.get(topicId);

    if (!category || !topic) return;

    const isAITopic = prompts.length > 0 && prompts.every((p) => p.origin === 'ai');
    const allDeleted = prompts.every((p) => p.status === 'deleted');

    const activePrompts = prompts.filter((p) => p.status !== 'deleted');
    const deletedPrompts = prompts.filter((p) => p.status === 'deleted');

    // Add category if not already added (only for active topics)
    if (!allDeleted && !llmoConfig.categories[categoryId]) {
      llmoConfig.categories[categoryId] = {
        name: category.name,
        region: prompts[0]?.regions || ['gl'],
        urls: [], // Category URLs are lost in V2
        origin: category.origin || 'human',
        updatedBy: category.updatedBy || 'system',
        updatedAt: category.updatedAt || new Date().toISOString(),
      };
    }

    // Add to appropriate section
    if (isAITopic && !allDeleted) {
      llmoConfig.aiTopics[topicId] = {
        name: topic.name,
        category: categoryId,
        prompts: activePrompts.map((p) => ({
          prompt: p.prompt,
          regions: p.regions,
          origin: p.origin,
          source: p.source,
          updatedBy: p.updatedBy || 'system',
          updatedAt: p.updatedAt || new Date().toISOString(),
        })),
      };
    } else if (!allDeleted) {
      llmoConfig.topics[topicId] = {
        name: topic.name,
        category: categoryId,
        prompts: activePrompts.map((p) => ({
          id: p.id,
          prompt: p.prompt,
          regions: p.regions,
          origin: p.origin,
          source: p.source,
          status: p.status || 'active',
          updatedBy: p.updatedBy || 'system',
          updatedAt: p.updatedAt || new Date().toISOString(),
        })),
      };
    }

    // Add deleted prompts
    deletedPrompts.forEach((p) => {
      llmoConfig.deleted.prompts[p.id] = {
        prompt: p.prompt,
        regions: p.regions,
        origin: p.origin,
        source: p.source,
        updatedBy: p.updatedBy || 'system',
        updatedAt: p.updatedAt || new Date().toISOString(),
        topic: topic.name,
        category: category.name,
      };
    });

    // If all prompts in topic are deleted, add them all to deleted section
    if (allDeleted) {
      activePrompts.forEach((p) => {
        llmoConfig.deleted.prompts[p.id] = {
          prompt: p.prompt,
          regions: p.regions,
          origin: p.origin,
          source: p.source,
          updatedBy: p.updatedBy || 'system',
          updatedAt: p.updatedAt || new Date().toISOString(),
          topic: topic.name,
          category: category.name,
        };
      });
    }
  });

  return llmoConfig;
}

export default {
  convertV1ToV2,
  convertV2ToV1,
};
