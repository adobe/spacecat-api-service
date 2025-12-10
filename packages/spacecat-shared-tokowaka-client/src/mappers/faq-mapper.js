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

import { hasText, isValidUrl } from '@adobe/spacecat-shared-utils';
import { TARGET_USER_AGENTS_CATEGORIES } from '../constants.js';
import BaseOpportunityMapper from './base-mapper.js';
import { markdownToHast } from '../utils/markdown-utils.js';
import { removePatchesBySuggestionIds } from '../utils/patch-utils.js';

/**
* Mapper for FAQ opportunity
* Handles conversion of FAQ suggestions to Tokowaka patches
*/
export default class FaqMapper extends BaseOpportunityMapper {
  constructor(log) {
    super(log);
    this.opportunityType = 'faq';
    this.prerenderRequired = true;
    this.validActions = ['insertAfter', 'insertBefore', 'appendChild'];
  }

  getOpportunityType() {
    return this.opportunityType;
  }

  requiresPrerender() {
    return this.prerenderRequired;
  }

  /**
  * Builds FAQ item HTML structure (div with h3 and answer)
  * Structure: <div><h3>question</h3>answer-content</div>
  * @param {Object} suggestion - Suggestion entity
  * @returns {Object} - HAST object for the FAQ item
  * @private
  */
  // eslint-disable-next-line class-methods-use-this
  buildFaqItemHast(suggestion) {
    const data = suggestion.getData();
    const { item } = data;

    // Convert answer markdown to HAST
    const answerHast = markdownToHast(item.answer);

    // Build structure: <div><h3>question</h3>answer-hast-children</div>
    return {
      type: 'element',
      tagName: 'div',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'h3',
          properties: {},
          children: [{ type: 'text', value: item.question }],
        },
        ...answerHast.children, // Spread answer HAST children directly
      ],
    };
  }

  /**
  * Creates individual patches for FAQ suggestions
  * Always creates heading (h2) patch with latest timestamp, then individual FAQ divs
  * @param {string} urlPath - URL path for current suggestions
  * @param {Array} suggestions - Array of suggestion entities for the same URL (to be deployed)
  * @param {string} opportunityId - Opportunity ID
  * @returns {Array} - Array of patch objects
  */
  suggestionsToPatches(
    urlPath,
    suggestions,
    opportunityId,
  ) {
    if (!urlPath || !Array.isArray(suggestions) || suggestions.length === 0) {
      this.log.error('Invalid parameters for FAQ mapper.suggestionsToPatches');
      return [];
    }

    // Filter eligible suggestions
    const eligibleSuggestions = suggestions.filter((suggestion) => {
      const eligibility = this.canDeploy(suggestion);
      if (!eligibility.eligible) {
        this.log.warn(`FAQ suggestion ${suggestion.getId()} cannot be deployed: ${eligibility.reason}`);
        return false;
      }
      return true;
    });

    if (eligibleSuggestions.length === 0) {
      this.log.warn('No eligible FAQ suggestions to deploy');
      return [];
    }

    const patches = [];

    // Get transformRules and headingText from first suggestion
    const firstSuggestion = eligibleSuggestions[0];
    const firstData = firstSuggestion.getData();
    const { headingText = 'FAQs', transformRules } = firstData;

    // Calculate the most recent lastUpdated from all eligible suggestions
    // The heading patch should have the same timestamp as the newest FAQ
    const maxLastUpdated = Math.max(...eligibleSuggestions.map((suggestion) => {
      const data = suggestion.getData();
      const updatedAt = data?.scrapedAt
        || data?.transformRules?.scrapedAt
        || suggestion.getUpdatedAt();

      if (updatedAt) {
        const parsed = new Date(updatedAt).getTime();
        return Number.isNaN(parsed) ? Date.now() : parsed;
      }
      return Date.now();
    }));

    // Always create/update heading patch with latest timestamp
    // mergePatches will replace existing heading if it already exists
    this.log.debug(`Creating/updating heading patch for ${urlPath}`);

    const headingHast = {
      type: 'element',
      tagName: 'h2',
      properties: {},
      children: [{ type: 'text', value: headingText }],
    };

    patches.push({
      opportunityId,
      // No suggestionId for FAQ heading patch
      prerenderRequired: this.requiresPrerender(),
      lastUpdated: maxLastUpdated,
      op: transformRules.action,
      selector: transformRules.selector,
      value: headingHast,
      valueFormat: 'hast',
      target: TARGET_USER_AGENTS_CATEGORIES.AI_BOTS,
    });

    // Create individual FAQ patches
    eligibleSuggestions.forEach((suggestion) => {
      try {
        const faqItemHast = this.buildFaqItemHast(suggestion);

        patches.push({
          ...this.createBasePatch(suggestion, opportunityId),
          op: transformRules.action,
          selector: transformRules.selector,
          value: faqItemHast,
          valueFormat: 'hast',
          target: TARGET_USER_AGENTS_CATEGORIES.AI_BOTS,
        });
      } catch (error) {
        this.log.error(`Failed to build FAQ HAST for suggestion ${suggestion.getId()}: ${error.message}`);
      }
    });

    return patches;
  }

  /**
  * Checks if a FAQ suggestion can be deployed
  * @param {Object} suggestion - Suggestion object
  * @returns {Object} { eligible: boolean, reason?: string }
  */
  canDeploy(suggestion) {
    const data = suggestion.getData();

    // Check shouldOptimize flag first
    if (data?.shouldOptimize !== true) {
      return { eligible: false, reason: 'shouldOptimize flag is not true' };
    }

    if (!data?.item?.question || !data?.item?.answer) {
      return { eligible: false, reason: 'item.question and item.answer are required' };
    }

    if (!data.transformRules) {
      return { eligible: false, reason: 'transformRules is required' };
    }

    if (!hasText(data.transformRules.selector)) {
      return { eligible: false, reason: 'transformRules.selector is required' };
    }

    if (!this.validActions.includes(data.transformRules.action)) {
      return { eligible: false, reason: 'transformRules.action must be insertAfter, insertBefore, or appendChild' };
    }

    if (!isValidUrl(data.url)) {
      return { eligible: false, reason: `url ${data.url} is not a valid URL` };
    }

    return { eligible: true };
  }

  /**
   * Removes patches from configuration for FAQ suggestions
   * FAQ-specific logic: Also removes the heading patch when no FAQ suggestions remain
   * @param {Object} config - Current Tokowaka configuration
   * @param {Array<string>} suggestionIds - Suggestion IDs to remove
   * @param {string} opportunityId - Opportunity ID
   * @returns {Object} - Updated configuration with patches removed
   */
  rollbackPatches(config, suggestionIds, opportunityId) {
    if (!config || !config.patches) {
      return config;
    }

    const suggestionIdsSet = new Set(suggestionIds);
    const additionalPatchKeys = [];

    // Find FAQ patches for this opportunity
    const opportunityPatches = config.patches.filter((p) => p.opportunityId === opportunityId);

    // Get FAQ suggestion IDs that will remain after rollback
    const remainingSuggestionIds = opportunityPatches
      .filter((p) => p.suggestionId && !suggestionIdsSet.has(p.suggestionId))
      .map((p) => p.suggestionId);

    // If no FAQ suggestions remain, remove the heading patch too
    if (remainingSuggestionIds.length === 0) {
      this.log.debug('No remaining FAQ suggestions, marking heading patch for removal');
      // Add heading patch key (opportunityId only, no suggestionId)
      additionalPatchKeys.push(opportunityId);
    } else {
      this.log.debug(`${remainingSuggestionIds.length} FAQ suggestions remain, keeping heading patch`);
    }

    // Remove FAQ suggestion patches and any orphaned heading patches
    this.log.debug(
      `Removing ${suggestionIds.length} FAQ suggestion patches `
      + `and ${additionalPatchKeys.length} heading patches`,
    );

    return removePatchesBySuggestionIds(config, suggestionIds, additionalPatchKeys);
  }
}
