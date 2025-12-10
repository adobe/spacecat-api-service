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

/**
 * Generates a unique key for a patch based on its structure
 * Individual patches (one suggestion per patch):
 *    → Key: opportunityId:suggestionId
 * Patches with no suggestionId:
 *    → Key: opportunityId
 */
export function getPatchKey(patch) {
  // Heading patch (no suggestionId): use special key
  if (!patch.suggestionId) {
    return `${patch.opportunityId}`;
  }

  // Individual patches include suggestionId in key
  // This ensures each suggestion gets its own separate patch
  return `${patch.opportunityId}:${patch.suggestionId}`;
}

/**
 * Merges new patches into existing patches based on patch keys
 * - If a patch with the same key exists, it's updated
 * - If a patch with a new key is found, it's added
 * @param {Array} existingPatches - Array of existing patches
 * @param {Array} newPatches - Array of new patches to merge
 * @returns {Object} - { patches: Array, updateCount: number, addCount: number }
 */
export function mergePatches(existingPatches, newPatches) {
  // Create a map of existing patches by their key
  const patchMap = new Map();
  existingPatches.forEach((patch, index) => {
    const key = getPatchKey(patch);
    patchMap.set(key, { patch, index });
  });

  // Process new patches
  const mergedPatches = [...existingPatches];
  let updateCount = 0;
  let addCount = 0;

  newPatches.forEach((newPatch) => {
    const key = getPatchKey(newPatch);
    const existing = patchMap.get(key);

    if (existing) {
      mergedPatches[existing.index] = newPatch;
      updateCount += 1;
    } else {
      mergedPatches.push(newPatch);
      addCount += 1;
    }
  });

  return { patches: mergedPatches, updateCount, addCount };
}

/**
 * Removes patches matching the given suggestion IDs from a config
 * Works with flat config structure
 * @param {Object} config - Tokowaka configuration object
 * @param {Array<string>} suggestionIds - Array of suggestion IDs to remove
 * @param {Array<string>} additionalPatchKeys - Optional array of additional patch keys to remove
 * @returns {Object} - Updated configuration with patches removed
 */
export function removePatchesBySuggestionIds(config, suggestionIds, additionalPatchKeys = []) {
  if (!config || !config.patches) {
    return config;
  }

  const suggestionIdSet = new Set(suggestionIds);
  const patchKeysToRemove = new Set(additionalPatchKeys);
  let removedCount = 0;

  // Filter out patches with matching suggestionIds or additional patch keys
  const filteredPatches = config.patches.filter((patch) => {
    const shouldRemoveBySuggestionId = suggestionIdSet.has(patch.suggestionId);
    const patchKey = getPatchKey(patch);
    const shouldRemoveByPatchKey = patchKeysToRemove.has(patchKey);

    if (shouldRemoveBySuggestionId || shouldRemoveByPatchKey) {
      removedCount += 1;
      return false;
    }
    return true;
  });

  return {
    ...config,
    patches: filteredPatches,
    removedCount,
  };
}
