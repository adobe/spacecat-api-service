/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { buildAggregationKeyFromSuggestion } from '@adobe/spacecat-shared-utils';
import { Suggestion } from '@adobe/spacecat-shared-data-access';

/**
 * Valid projection views for suggestions.
 * @type {string[]}
 */
export const SUGGESTION_VIEWS = ['minimal', 'summary', 'full'];

/**
 * Extracts minimal data fields from suggestion data using schema-driven projection.
 * Uses Suggestion.getProjection() from spacecat-shared-data-access.
 *
 * @param {object} data - Suggestion data object.
 * @param {string} opportunityType - Type of opportunity (e.g., 'structured-data').
 * @returns {object|null} Object with only relevant fields, or null if no data.
 */
const extractMinimalData = (data, opportunityType) => {
  if (!data) return null;

  // Get schema-driven projection configuration
  const projection = Suggestion.getProjection(opportunityType, 'minimal');

  const minimalData = {};
  let hasFields = false;

  // Apply projection fields
  for (const field of projection.fields) {
    if (data[field] !== undefined) {
      // Apply transformer if defined (resolve string reference to actual function)
      const transformerName = projection.transformers?.[field];
      const transformer = transformerName ? Suggestion.FIELD_TRANSFORMERS[transformerName] : null;
      minimalData[field] = transformer ? transformer(data[field]) : data[field];
      hasFields = true;
    }
  }

  return hasFields ? minimalData : null;
};

/**
 * Data transfer object for Suggestion.
 */
export const SuggestionDto = {
  /**
   * Converts a Suggestion object into a JSON object with optional projection.
   * @param {Readonly<Suggestion>} suggestion - Suggestion object.
   * @param {string} [view='full'] - Projection view: 'minimal', 'summary', or 'full'.
   * @param {object} [opportunity] - Optional opportunity entity for type-specific filtering.
   * @returns {object} JSON object with fields based on the selected view.
   */
  toJSON: (suggestion, view = 'full', opportunity = null) => {
    const data = suggestion.getData();
    const opportunityType = opportunity?.getType() || null;

    // Minimal view: id, status, and URL-related data fields
    if (view === 'minimal') {
      const minimalData = extractMinimalData(data, opportunityType);
      return {
        id: suggestion.getId(),
        status: suggestion.getStatus(),
        ...(minimalData && { data: minimalData }),
      };
    }

    // Summary view: minimal fields + metadata (superset of minimal, subset of full)
    if (view === 'summary') {
      const minimalData = extractMinimalData(data, opportunityType);
      return {
        id: suggestion.getId(),
        status: suggestion.getStatus(),
        ...(minimalData && { data: minimalData }),
        opportunityId: suggestion.getOpportunityId(),
        type: suggestion.getType(),
        rank: suggestion.getRank(),
        createdAt: suggestion.getCreatedAt(),
        updatedAt: suggestion.getUpdatedAt(),
        updatedBy: suggestion.getUpdatedBy(),
      };
    }

    // Full view: all fields (default, backward compatible)
    const aggregationKey = buildAggregationKeyFromSuggestion(data);
    return {
      id: suggestion.getId(),
      opportunityId: suggestion.getOpportunityId(),
      type: suggestion.getType(),
      rank: suggestion.getRank(),
      status: suggestion.getStatus(),
      data: {
        ...data,
        aggregationKey,
      },
      kpiDeltas: suggestion.getKpiDeltas(),
      createdAt: suggestion.getCreatedAt(),
      updatedAt: suggestion.getUpdatedAt(),
      updatedBy: suggestion.getUpdatedBy(),
    };
  },
};
