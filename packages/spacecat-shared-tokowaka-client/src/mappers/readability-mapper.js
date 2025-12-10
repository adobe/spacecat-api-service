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

import { hasText, isValidUrl, isBoolean } from '@adobe/spacecat-shared-utils';
import { TARGET_USER_AGENTS_CATEGORIES } from '../constants.js';
import BaseOpportunityMapper from './base-mapper.js';

/**
 * Mapper for readability opportunity
 * Handles conversion of readability suggestions to Tokowaka patches
 */
export default class ReadabilityMapper extends BaseOpportunityMapper {
  constructor(log) {
    super(log);
    this.opportunityType = 'readability';
    this.prerenderRequired = true;
  }

  getOpportunityType() {
    return this.opportunityType;
  }

  requiresPrerender() {
    return this.prerenderRequired;
  }

  /**
   * Converts suggestions to Tokowaka patches
   * @param {string} urlPath - URL path for the suggestions
   * @param {Array} suggestions - Array of suggestion entities for the same URL
   * @param {string} opportunityId - Opportunity ID
   * @returns {Array} - Array of Tokowaka patch objects
   */
  suggestionsToPatches(urlPath, suggestions, opportunityId) {
    const patches = [];

    suggestions.forEach((suggestion) => {
      const eligibility = this.canDeploy(suggestion);
      if (!eligibility.eligible) {
        this.log.warn(`Readability suggestion ${suggestion.getId()} cannot be deployed: ${eligibility.reason}`);
        return;
      }

      const data = suggestion.getData();
      const { transformRules } = data;

      const patch = {
        ...this.createBasePatch(suggestion, opportunityId),
        op: transformRules.op,
        selector: transformRules.selector,
        value: transformRules.value,
        valueFormat: 'text',
        ...(
          isBoolean(transformRules.prerenderRequired)
           && { prerenderRequired: transformRules.prerenderRequired }
        ),
        ...(hasText(data.textPreview) && { currValue: data.textPreview }),
        target: transformRules.target || TARGET_USER_AGENTS_CATEGORIES.AI_BOTS,
      };

      patches.push(patch);
    });

    return patches;
  }

  /**
   * Checks if a readability suggestion can be deployed
   * @param {Object} suggestion - Suggestion object
   * @returns {Object} { eligible: boolean, reason?: string }
   */
  // eslint-disable-next-line class-methods-use-this
  canDeploy(suggestion) {
    const data = suggestion.getData();

    // Validate required fields
    if (!data?.transformRules) {
      return { eligible: false, reason: 'transformRules is required' };
    }

    const { transformRules } = data;

    if (!isValidUrl(data.url)) {
      return { eligible: false, reason: `url ${data.url} is not a valid URL` };
    }

    if (!hasText(transformRules.selector)) {
      return { eligible: false, reason: 'transformRules.selector is required' };
    }

    if (transformRules.op !== 'replace') {
      return {
        eligible: false,
        reason: 'transformRules.op must be "replace" for readability suggestions',
      };
    }

    if (!hasText(transformRules.value)) {
      return { eligible: false, reason: 'transformRules.value is required' };
    }

    return { eligible: true };
  }
}
