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

/* eslint-disable no-param-reassign */

import { deepEqual } from '@adobe/spacecat-shared-utils';

/**
 * Removes metadata fields (updatedBy, updatedAt, status) from an object.
 * @param {object} obj - The object to clean.
 * @returns {object} A new object without metadata fields.
 */
const stripMetadata = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const {
    // eslint-disable-next-line no-unused-vars
    updatedAt, updatedBy, status, ...rest
  } = obj;
  return rest;
};

/**
 * Merges arrays of objects by ID, preserving metadata for unchanged items.
 * @param {Array} newItems - New array of items.
 * @param {Array} oldItems - Old array of items.
 * @param {string} userId - User ID performing the update.
 * @param {string} timestamp - ISO timestamp.
 * @returns {object} Object with merged items array and stats.
 */
const mergeArrayById = (newItems, oldItems, userId, timestamp) => {
  const oldItemsMap = new Map();
  oldItems.forEach((item) => {
    if (item.id) {
      oldItemsMap.set(item.id, item);
    }
  });

  let modified = 0;
  const merged = newItems.map((newItem) => {
    const oldItem = oldItemsMap.get(newItem.id);

    if (oldItem) {
      const cleanNew = stripMetadata(newItem);
      const cleanOld = stripMetadata(oldItem);

      if (deepEqual(cleanNew, cleanOld)) {
        // Content unchanged, preserve metadata
        return {
          ...newItem,
          updatedBy: oldItem.updatedBy,
          updatedAt: oldItem.updatedAt,
        };
      }
    }

    // New or modified item
    modified += 1;
    return {
      ...newItem,
      updatedBy: userId,
      updatedAt: timestamp,
    };
  });

  return { items: merged, modified, total: merged.length };
};

/**
 * Merges brand prompts, handling nested prompt arrays.
 * @param {Array} newPrompts - New prompts array.
 * @param {Array} oldPrompts - Old prompts array.
 * @param {string} userId - User ID.
 * @param {string} timestamp - ISO timestamp.
 * @returns {object} Merged prompts with stats.
 */
const mergePrompts = (newPrompts, oldPrompts, userId, timestamp) => {
  const oldPromptsMap = new Map();
  oldPrompts.forEach((prompt) => {
    if (prompt.id) {
      oldPromptsMap.set(prompt.id, prompt);
    }
  });

  let modified = 0;
  const merged = newPrompts.map((newPrompt) => {
    const oldPrompt = oldPromptsMap.get(newPrompt.id);

    if (oldPrompt) {
      const cleanNew = stripMetadata(newPrompt);
      const cleanOld = stripMetadata(oldPrompt);

      if (deepEqual(cleanNew, cleanOld)) {
        return {
          ...newPrompt,
          updatedBy: oldPrompt.updatedBy,
          updatedAt: oldPrompt.updatedAt,
        };
      }
    }

    modified += 1;
    return {
      ...newPrompt,
      updatedBy: userId,
      updatedAt: timestamp,
    };
  });

  return { prompts: merged, modified, total: merged.length };
};

/**
 * Merges brands array, including nested prompts.
 * @param {Array} newBrands - New brands array.
 * @param {Array} oldBrands - Old brands array.
 * @param {string} userId - User ID.
 * @param {string} timestamp - ISO timestamp.
 * @returns {object} Merged brands with stats.
 */
const mergeBrands = (newBrands, oldBrands, userId, timestamp) => {
  const oldBrandsMap = new Map();
  oldBrands.forEach((brand) => {
    if (brand.id) {
      oldBrandsMap.set(brand.id, brand);
    }
  });

  let brandsModified = 0;
  let promptsModified = 0;
  let promptsTotal = 0;

  const merged = newBrands.map((newBrand) => {
    const oldBrand = oldBrandsMap.get(newBrand.id);

    // Merge prompts if they exist
    let mergedPrompts = newBrand.prompts;
    if (newBrand.prompts) {
      const promptsResult = mergePrompts(
        newBrand.prompts,
        oldBrand?.prompts || [],
        userId,
        timestamp,
      );
      mergedPrompts = promptsResult.prompts;
      promptsModified += promptsResult.modified;
      promptsTotal += promptsResult.total;
    }

    const brandWithoutPrompts = { ...newBrand };
    delete brandWithoutPrompts.prompts;

    if (oldBrand) {
      const oldBrandWithoutPrompts = { ...oldBrand };
      delete oldBrandWithoutPrompts.prompts;

      const cleanNew = stripMetadata(brandWithoutPrompts);
      const cleanOld = stripMetadata(oldBrandWithoutPrompts);

      if (deepEqual(cleanNew, cleanOld)) {
        // Brand metadata unchanged
        return {
          ...newBrand,
          updatedBy: oldBrand.updatedBy,
          updatedAt: oldBrand.updatedAt,
          prompts: mergedPrompts,
        };
      }
    }

    // Brand is new or modified
    brandsModified += 1;
    return {
      ...newBrand,
      updatedBy: userId,
      updatedAt: timestamp,
      prompts: mergedPrompts,
    };
  });

  return {
    brands: merged,
    brandsModified,
    brandsTotal: merged.length,
    promptsModified,
    promptsTotal,
  };
};

/**
 * Merges V2 customer config updates with existing config.
 * @param {object} updates - Partial config updates.
 * @param {object} oldConfig - Existing config from S3.
 * @param {string} userId - User ID performing the update.
 * @returns {object} Merged config and stats.
 */
export function mergeCustomerConfigV2(updates, oldConfig, userId) {
  const timestamp = new Date().toISOString();

  // Start with existing config, then apply updates
  const mergedCustomer = {
    ...(oldConfig?.customer || {}),
    ...(updates.customer || {}),
  };

  const stats = {
    categories: { total: 0, modified: 0 },
    topics: { total: 0, modified: 0 },
    brands: { total: 0, modified: 0 },
    prompts: { total: 0, modified: 0 },
  };

  // Merge categories
  if (updates.customer?.categories) {
    const result = mergeArrayById(
      updates.customer.categories,
      oldConfig?.customer?.categories || [],
      userId,
      timestamp,
    );
    mergedCustomer.categories = result.items;
    stats.categories = { total: result.total, modified: result.modified };
  } else if (oldConfig?.customer?.categories) {
    mergedCustomer.categories = oldConfig.customer.categories;
    stats.categories.total = oldConfig.customer.categories.length;
  }

  // Merge topics
  if (updates.customer?.topics) {
    const result = mergeArrayById(
      updates.customer.topics,
      oldConfig?.customer?.topics || [],
      userId,
      timestamp,
    );
    mergedCustomer.topics = result.items;
    stats.topics = { total: result.total, modified: result.modified };
  } else if (oldConfig?.customer?.topics) {
    mergedCustomer.topics = oldConfig.customer.topics;
    stats.topics.total = oldConfig.customer.topics.length;
  }

  // Merge brands (including nested prompts)
  if (updates.customer?.brands) {
    const result = mergeBrands(
      updates.customer.brands,
      oldConfig?.customer?.brands || [],
      userId,
      timestamp,
    );
    mergedCustomer.brands = result.brands;
    stats.brands = {
      total: result.brandsTotal,
      modified: result.brandsModified,
    };
    stats.prompts = {
      total: result.promptsTotal,
      modified: result.promptsModified,
    };
  } else if (oldConfig?.customer?.brands) {
    mergedCustomer.brands = oldConfig.customer.brands;
    stats.brands.total = oldConfig.customer.brands.length;
    // Count existing prompts
    stats.prompts.total = oldConfig.customer.brands.reduce(
      (sum, brand) => sum + (brand.prompts?.length || 0),
      0,
    );
  }

  // Preserve availableVerticals if not in updates
  if (!updates.customer?.availableVerticals && oldConfig?.customer?.availableVerticals) {
    mergedCustomer.availableVerticals = oldConfig.customer.availableVerticals;
  }

  return {
    mergedConfig: { customer: mergedCustomer },
    stats,
  };
}

// Export stripMetadata for testing
export { stripMetadata };
