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

import { removePatchesBySuggestionIds } from '../utils/patch-utils.js';

/**
 * Base class for opportunity mappers
 * Each opportunity type should extend this class and implement the abstract methods
 */
export default class BaseOpportunityMapper {
  constructor(log) {
    this.log = log;
  }

  /**
   * Returns the opportunity type this mapper handles
   * @abstract
   * @returns {string} - Opportunity type
   */
  getOpportunityType() {
    this.log.error('getOpportunityType() must be implemented by subclass');
    throw new Error('getOpportunityType() must be implemented by subclass');
  }

  /**
   * Determines if prerendering is required for this opportunity type
   * @abstract
   * @returns {boolean} - True if prerendering is required
   */
  requiresPrerender() {
    this.log.error('requiresPrerender() must be implemented by subclass');
    throw new Error('requiresPrerender() must be implemented by subclass');
  }

  /**
   * Converts suggestions to Tokowaka patches
   * @abstract
   * @param {string} _ - URL path for the suggestions
   * @param {Array} __ - Array of suggestion entities for the same URL
   * @param {string} ___ - Opportunity ID
   * @returns {Array} - Array of Tokowaka patch objects
   */
  // eslint-disable-next-line no-unused-vars
  suggestionsToPatches(_, __, ___) {
    this.log.error('suggestionsToPatches() must be implemented by subclass');
    throw new Error('suggestionsToPatches() must be implemented by subclass');
  }

  /**
   * Checks if a suggestion can be deployed for this opportunity type
   * This method should validate all eligibility and data requirements
   * @abstract
   * @param {Object} _ - Suggestion object
   * @returns {Object} - { eligible: boolean, reason?: string }
   */
  // eslint-disable-next-line no-unused-vars
  canDeploy(_) {
    this.log.error('canDeploy() must be implemented by subclass');
    throw new Error('canDeploy() must be implemented by subclass');
  }

  /**
   * Helper method to create base patch structure
   * @protected
   * @param {Object} suggestion - Suggestion entity with getUpdatedAt() method
   * @param {string} opportunityId - Opportunity ID
   * @returns {Object} - Base patch object
   */
  createBasePatch(suggestion, opportunityId) {
    const data = suggestion.getData();
    const updatedAt = data?.scrapedAt
      || data?.transformRules?.scrapedAt
      || suggestion.getUpdatedAt();

    // Parse timestamp, fallback to Date.now() if invalid
    let lastUpdated = Date.now();
    if (updatedAt) {
      const parsed = new Date(updatedAt).getTime();
      lastUpdated = Number.isNaN(parsed) ? Date.now() : parsed;
    }

    return {
      opportunityId,
      suggestionId: suggestion.getId(),
      prerenderRequired: this.requiresPrerender(),
      lastUpdated,
    };
  }

  /**
   * Removes patches from configuration for given suggestions
   * Default implementation simply removes patches matching the suggestion IDs.
   * Override this method in subclasses if custom rollback logic is needed
   * (e.g., FAQ mapper removes heading patch when no suggestions remain).
   * @param {Object} config - Current Tokowaka configuration
   * @param {Array<string>} suggestionIds - Suggestion IDs to remove
   * @param {string} opportunityId - Opportunity ID
   * @returns {Object} - Updated configuration with patches removed
   */
  // eslint-disable-next-line no-unused-vars
  rollbackPatches(config, suggestionIds, opportunityId) {
    if (!config || !config.patches) {
      return config;
    }

    this.log.debug(`Removing patches for ${suggestionIds.length} suggestions`);
    return removePatchesBySuggestionIds(config, suggestionIds);
  }
}
