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
 * Groups suggestions by URL pathname
 * @param {Array} suggestions - Array of suggestion entities
 * @param {string} baseURL - Base URL for pathname extraction
 * @param {Object} log - Logger instance
 * @returns {Object} - Object with URL paths as keys and arrays of suggestions as values
 */
export function groupSuggestionsByUrlPath(suggestions, baseURL, log) {
  return suggestions.reduce((acc, suggestion) => {
    const data = suggestion.getData();
    const url = data?.url;

    if (!url) {
      log.warn(`Suggestion ${suggestion.getId()} does not have a URL, skipping`);
      return acc;
    }

    let urlPath;
    try {
      urlPath = new URL(url, baseURL).pathname;
    } catch (e) {
      log.warn(`Failed to extract pathname from URL for suggestion ${suggestion.getId()}: ${url}`);
      return acc;
    }

    if (!acc[urlPath]) {
      acc[urlPath] = [];
    }
    acc[urlPath].push(suggestion);
    return acc;
  }, {});
}

/**
 * Filters suggestions into eligible and ineligible based on mapper's canDeploy method
 * @param {Array} suggestions - Array of suggestion entities
 * @param {Object} mapper - Mapper instance with canDeploy method
 * @returns {Object} - { eligible: Array, ineligible: Array<{suggestion, reason}> }
 */
export function filterEligibleSuggestions(suggestions, mapper) {
  const eligible = [];
  const ineligible = [];

  suggestions.forEach((suggestion) => {
    const eligibility = mapper.canDeploy(suggestion);
    if (eligibility.eligible) {
      eligible.push(suggestion);
    } else {
      ineligible.push({
        suggestion,
        reason: eligibility.reason || 'Suggestion cannot be deployed',
      });
    }
  });

  return { eligible, ineligible };
}
