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

import { hasText } from '@adobe/spacecat-shared-utils';
import { TARGET_USER_AGENTS_CATEGORIES } from '../constants.js';
import BaseOpportunityMapper from './base-mapper.js';

/**
 * Mapper for headings opportunity
 * Handles conversion of heading suggestions to Tokowaka patches
 */
export default class HeadingsMapper extends BaseOpportunityMapper {
  constructor(log) {
    super(log);
    this.opportunityType = 'headings';
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
        this.log.warn(`Headings suggestion ${suggestion.getId()} cannot be deployed: ${eligibility.reason}`);
        return;
      }

      const data = suggestion.getData();
      const { checkType, transformRules } = data;

      const patch = {
        ...this.createBasePatch(suggestion, opportunityId),
        op: transformRules.action,
        selector: transformRules.selector,
        value: data.recommendedAction,
        valueFormat: 'text',
        ...(data.currentValue !== null && { currValue: data.currentValue }),
        target: TARGET_USER_AGENTS_CATEGORIES.AI_BOTS,
      };

      if (checkType === 'heading-missing-h1' && transformRules.tag) {
        patch.tag = transformRules.tag;
      }

      patches.push(patch);
    });

    return patches;
  }

  /**
   * Checks if a heading suggestion can be deployed
   * Supports: heading-empty, heading-missing-h1, heading-h1-length
   * @param {Object} suggestion - Suggestion object
   * @returns {Object} { eligible: boolean, reason?: string }
   */
  // eslint-disable-next-line class-methods-use-this
  canDeploy(suggestion) {
    const data = suggestion.getData();
    const checkType = data?.checkType;

    // Check if checkType is eligible
    const eligibleCheckTypes = ['heading-empty', 'heading-missing-h1', 'heading-h1-length', 'heading-order-invalid'];
    if (!eligibleCheckTypes.includes(checkType)) {
      return {
        eligible: false,
        reason: `Only ${eligibleCheckTypes.join(', ')} can be deployed. This suggestion has checkType: ${checkType}`,
      };
    }

    // Validate required fields
    if (!data?.recommendedAction) {
      return { eligible: false, reason: 'recommendedAction is required' };
    }

    if (!hasText(data.transformRules?.selector)) {
      return { eligible: false, reason: 'transformRules.selector is required' };
    }

    // Validate based on checkType
    if (checkType === 'heading-missing-h1') {
      if (!['insertBefore', 'insertAfter'].includes(data.transformRules?.action)) {
        return {
          eligible: false,
          reason: 'transformRules.action must be insertBefore or insertAfter for heading-missing-h1',
        };
      }
      if (!hasText(data.transformRules?.tag)) {
        return {
          eligible: false,
          reason: 'transformRules.tag is required for heading-missing-h1',
        };
      }
    }

    if (checkType === 'heading-h1-length' || checkType === 'heading-empty') {
      if (data.transformRules?.action !== 'replace') {
        return {
          eligible: false,
          reason: `transformRules.action must be replace for ${checkType}`,
        };
      }
    }

    if (checkType === 'heading-order-invalid') {
      if (data.transformRules?.action !== 'replaceWith') {
        return {
          eligible: false,
          reason: `transformRules.action must be replaceWith for ${checkType}`,
        };
      }
      if (data.transformRules?.valueFormat !== 'hast') {
        return {
          eligible: false,
          reason: `transformRules.valueFormat must be hast for ${checkType}`,
        };
      }
    }

    return { eligible: true };
  }
}
