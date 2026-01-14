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

/**
 * Valid projection views for suggestions.
 * @type {string[]}
 */
export const SUGGESTION_VIEWS = ['minimal', 'summary', 'full'];

/**
 * Extracts URL from suggestion data.
 * Handles both flat structures and nested recommendations.
 * @param {object} data - Suggestion data object.
 * @returns {string|null} URL or null if not found.
 */
const extractUrl = (data) => {
  if (!data) return null;

  // Check top-level URL fields (most common)
  if (data.url) return data.url;
  if (data.pageUrl) return data.pageUrl;
  if (data.url_from) return data.url_from;
  if (data.urlFrom) return data.urlFrom;

  // Check nested recommendations (e.g., alt-text suggestions)
  const hasRecommendations = data.recommendations
    && Array.isArray(data.recommendations)
    && data.recommendations.length > 0;

  if (hasRecommendations) {
    const firstRec = data.recommendations[0];
    if (firstRec.pageUrl) return firstRec.pageUrl;
    if (firstRec.url) return firstRec.url;
  }

  return null;
};

/**
 * Data transfer object for Suggestion.
 */
export const SuggestionDto = {
  /**
   * Converts a Suggestion object into a JSON object with optional projection.
   * @param {Readonly<Suggestion>} suggestion - Suggestion object.
   * @param {string} [view='full'] - Projection view: 'minimal', 'summary', or 'full'.
   * @returns {object} JSON object with fields based on the selected view.
   */
  toJSON: (suggestion, view = 'full') => {
    const data = suggestion.getData();

    // Minimal view: id and url only
    if (view === 'minimal') {
      return {
        id: suggestion.getId(),
        url: extractUrl(data),
      };
    }

    // Summary view: key fields without heavy data
    if (view === 'summary') {
      return {
        id: suggestion.getId(),
        opportunityId: suggestion.getOpportunityId(),
        type: suggestion.getType(),
        rank: suggestion.getRank(),
        status: suggestion.getStatus(),
        url: extractUrl(data),
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
