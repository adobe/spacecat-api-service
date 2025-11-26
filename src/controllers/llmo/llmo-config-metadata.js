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

/* eslint-disable no-param-reassign */

/**
 * Deeply compares two objects for equality.
 * @param {any} obj1 - The first object.
 * @param {any} obj2 - The second object.
 * @returns {boolean} True if objects are deeply equal.
 */
export const deepEqual = (obj1, obj2) => {
  if (obj1 === obj2) return true;
  if (obj1 === null || obj2 === null || typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

  const isArray1 = Array.isArray(obj1);
  const isArray2 = Array.isArray(obj2);

  if (isArray1 !== isArray2) return false;

  if (isArray1) {
    if (obj1.length !== obj2.length) return false;
    const copy2 = [...obj2];
    for (const item1 of obj1) {
      const index = copy2.findIndex((item2) => deepEqual(item1, item2));
      if (index === -1) return false;
      copy2.splice(index, 1);
    }
    return true;
  }

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false;
  }
  return true;
};

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
 * Generates a deterministic string key for an object, independent of key order.
 * Arrays are sorted to match deepEqual's set-like behavior.
 * @param {any} obj - The object to hash.
 * @returns {string} A deterministic string representation.
 */
const getDeterministicKey = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);

  if (Array.isArray(obj)) {
    return JSON.stringify(obj.map(getDeterministicKey).sort());
  }

  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map((key) => `${JSON.stringify(key)}:${getDeterministicKey(obj[key])}`);
  return `{${parts.join(',')}}`;
};

/**
 * Updates metadata for a single entity based on comparison with its old version.
 * @param {object} newEntity - The new entity object.
 * @param {object} oldEntity - The old entity object.
 * @param {string} userId - The user ID performing the update.
 * @param {string} timestamp - The ISO timestamp of the update.
 * @returns {boolean} True if the entity was modified/created.
 */
const updateEntityMetadata = (newEntity, oldEntity, userId, timestamp) => {
  const cleanNew = stripMetadata(newEntity);
  const cleanOld = stripMetadata(oldEntity);

  if (oldEntity && deepEqual(cleanNew, cleanOld)) {
    // Content hasn't changed, preserve old metadata
    if (oldEntity.updatedBy) newEntity.updatedBy = oldEntity.updatedBy;
    if (oldEntity.updatedAt) newEntity.updatedAt = oldEntity.updatedAt;
    return false;
  }
  // Content changed or new, set new metadata
  newEntity.updatedBy = userId;
  newEntity.updatedAt = timestamp;
  return true;
};

/**
 * Updates metadata for the entire LLMO configuration.
 * @param {object} updates - The new configuration updates.
 * @param {object} oldConfig - The previous configuration object.
 * @param {string} userId - The user ID performing the update.
 * @returns {object} An object containing the new config and change statistics.
 */
export const updateModifiedByDetails = (updates, oldConfig, userId) => {
  const newConfig = structuredClone({
    ...(oldConfig || {}),
    ...updates,
  });
  const timestamp = new Date().toISOString();
  const oldCategories = oldConfig?.categories || {};
  const oldTopics = oldConfig?.topics || {};
  const oldAiTopics = oldConfig?.aiTopics || {};
  const oldBrandsAliases = oldConfig?.brands?.aliases || [];
  const oldCompetitors = oldConfig?.competitors?.competitors || [];
  const oldDeletedPrompts = oldConfig?.deleted?.prompts || {};

  const stats = {
    categories: { total: 0, modified: 0 },
    topics: { total: 0, modified: 0 },
    aiTopics: { total: 0, modified: 0 },
    prompts: { total: 0, modified: 0 },
    brandAliases: { total: 0, modified: 0 },
    competitors: { total: 0, modified: 0 },
    deletedPrompts: { total: 0, modified: 0 },
    categoryUrls: { total: 0 },
  };

  // 1. Categories
  if (newConfig.categories) {
    Object.entries(newConfig.categories).forEach(([id, category]) => {
      stats.categories.total += 1;
      if (category.urls) stats.categoryUrls.total += category.urls.length;

      const oldCategory = oldCategories[id];
      const modified = updateEntityMetadata(category, oldCategory, userId, timestamp);

      if (modified) {
        stats.categories.modified += 1;
      }
    });
  }

  // Helper to process topics and aiTopics
  const processTopics = (topics, oldTopicsSource, statsCounter) => {
    Object.entries(topics).forEach(([id, topic]) => {
      statsCounter.total += 1;
      const oldTopic = oldTopicsSource[id];
      if (!oldTopic) statsCounter.modified += 1;

      const oldPrompts = oldTopic?.prompts || [];
      if (topic.prompts) {
        stats.prompts.total += topic.prompts.length;

        const oldPromptsMap = new Map();
        oldPrompts.forEach((p) => {
          const clean = stripMetadata(p);
          const key = getDeterministicKey(clean);
          if (!oldPromptsMap.has(key)) {
            oldPromptsMap.set(key, []);
          }
          oldPromptsMap.get(key).push(p);
        });

        topic.prompts.forEach((prompt) => {
          const cleanPrompt = stripMetadata(prompt);
          const key = getDeterministicKey(cleanPrompt);
          const potentialMatches = oldPromptsMap.get(key);

          let matchFound = false;

          if (potentialMatches && potentialMatches.length > 0) {
            // Found potential matches with same content hash
            const matchIndex = potentialMatches.findIndex(
              (oldP) => deepEqual(cleanPrompt, stripMetadata(oldP)),
            );

            if (matchIndex !== -1) {
              // Found match, preserve metadata
              const match = potentialMatches[matchIndex];
              if (match.updatedBy) prompt.updatedBy = match.updatedBy;
              if (match.updatedAt) prompt.updatedAt = match.updatedAt;
              // Remove from pool to handle duplicates
              potentialMatches.splice(matchIndex, 1);
              matchFound = true;
            }
          }

          if (!matchFound) {
            // No match, it's new or modified
            prompt.updatedBy = userId;
            prompt.updatedAt = timestamp;
            stats.prompts.modified += 1;
          }
        });
      }
    });
  };

  // 2. Topics
  if (newConfig.topics) {
    processTopics(newConfig.topics, oldTopics, stats.topics);
  }

  // 2.1 AI Topics
  if (newConfig.aiTopics) {
    processTopics(newConfig.aiTopics, oldAiTopics, stats.aiTopics);
  }

  // 3. Brand Aliases
  if (newConfig.brands && newConfig.brands.aliases) {
    const remainingOldAliases = [...oldBrandsAliases];
    newConfig.brands.aliases.forEach((alias) => {
      stats.brandAliases.total += 1;
      const cleanAlias = stripMetadata(alias);
      const matchIndex = remainingOldAliases.findIndex(
        (oldA) => deepEqual(cleanAlias, stripMetadata(oldA)),
      );

      if (matchIndex !== -1) {
        const match = remainingOldAliases[matchIndex];
        if (match.updatedBy) alias.updatedBy = match.updatedBy;
        if (match.updatedAt) alias.updatedAt = match.updatedAt;
        remainingOldAliases.splice(matchIndex, 1);
      } else {
        alias.updatedBy = userId;
        alias.updatedAt = timestamp;
        stats.brandAliases.modified += 1;
      }
    });
  }

  // 4. Competitors
  if (newConfig.competitors && newConfig.competitors.competitors) {
    const remainingOldCompetitors = [...oldCompetitors];
    newConfig.competitors.competitors.forEach((competitor) => {
      stats.competitors.total += 1;
      const cleanComp = stripMetadata(competitor);
      const matchIndex = remainingOldCompetitors.findIndex(
        (oldC) => deepEqual(cleanComp, stripMetadata(oldC)),
      );

      if (matchIndex !== -1) {
        const match = remainingOldCompetitors[matchIndex];
        if (match.updatedBy) competitor.updatedBy = match.updatedBy;
        if (match.updatedAt) competitor.updatedAt = match.updatedAt;
        remainingOldCompetitors.splice(matchIndex, 1);
      } else {
        competitor.updatedBy = userId;
        competitor.updatedAt = timestamp;
        stats.competitors.modified += 1;
      }
    });
  }

  // 5. Deleted Prompts
  if (newConfig.deleted && newConfig.deleted.prompts) {
    Object.entries(newConfig.deleted.prompts).forEach(([id, prompt]) => {
      stats.deletedPrompts.total += 1;
      const oldPrompt = oldDeletedPrompts[id];

      if (oldPrompt) {
        if (oldPrompt.updatedBy) prompt.updatedBy = oldPrompt.updatedBy;
        if (oldPrompt.updatedAt) prompt.updatedAt = oldPrompt.updatedAt;
      } else {
        prompt.updatedBy = userId;
        prompt.updatedAt = timestamp;
        stats.deletedPrompts.modified += 1;
      }
    });
  }

  return { newConfig, stats };
};
