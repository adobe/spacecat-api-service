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
 * @import { FixEntity, Suggestion } from "@adobe/spacecat-shared-data-access"
 */

import { SuggestionDto } from './suggestion.js';

/**
 * Data transfer object for Fix.
 */
export const FixDto = {

  /**
   * Converts a FixEntity object into a JSON object.
   * @param {Readonly<FixEntity>} fix - FixEntity object.
   * @returns {{
   *  id: string
   *  opportunityId: string
   *  type: string
   *  createdAt: string
   *  updatedAt: string
   *  executedBy: string
   *  executedAt: string
   *  publishedAt: string
   *  changeDetails: object
   *  status: string
   *  suggestions?: Array<object>
   * }} JSON object.
   */
  toJSON(fix) {
    const result = {
      id: fix.getId(),
      opportunityId: fix.getOpportunityId(),
      type: fix.getType(),
      createdAt: fix.getCreatedAt(),
      updatedAt: fix.getUpdatedAt(),
      executedBy: fix.getExecutedBy(),
      executedAt: fix.getExecutedAt(),
      publishedAt: fix.getPublishedAt(),
      changeDetails: fix.getChangeDetails(),
      status: fix.getStatus(),
    };

    // Include suggestions if they are attached to the fix entity
    // eslint-disable-next-line no-underscore-dangle
    if (fix._suggestions && Array.isArray(fix._suggestions)) {
      // eslint-disable-next-line no-underscore-dangle
      result.suggestions = fix._suggestions.map((suggestion) => SuggestionDto.toJSON(suggestion));
    }

    return result;
  },
};
