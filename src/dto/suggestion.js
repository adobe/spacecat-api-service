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
 * Accessibility-related opportunity types that need special issue handling.
 * @type {Set<string>}
 */
const ACCESSIBILITY_OPPORTUNITY_TYPES = new Set([
  'form-accessibility',
  'a11y-color-contrast',
  'a11y-assistive',
]);

/**
 * Common URL-related fields that should always be included in minimal view.
 * @type {string[]}
 */
const COMMON_URL_FIELDS = [
  'url',
  'urls',
  'urlFrom',
  'urlTo',
  'url_from',
  'url_to',
  'urlsSuggested',
  'sitemapUrl',
  'pageUrl',
  'pattern',
  'link',
  'type',
];

/**
 * Mapping of opportunity types to their specific data fields for minimal view.
 * Only fields relevant to each opportunity type are included.
 * @type {Object<string, string[]>}
 */
const OPPORTUNITY_TYPE_FIELDS = {
  'alt-text': ['recommendations'],
  'security-vulnerabilities': ['cves'],
  'security-csp': ['findings'],
  'security-permissions': ['path'],
  'redirect-chains': ['sourceUrl', 'destinationUrl'],
  'form-opportunities': ['form', 'page'],
  'form-accessibility': ['issues', 'form', 'page', 'accessibility'],
  'a11y-color-contrast': ['issues'],
  'a11y-assistive': ['issues'],
  'cwv-lcp': ['metrics', 'pageviews', 'issues'],
  'cwv-cls': ['metrics', 'pageviews', 'issues'],
  'cwv-inp': ['metrics', 'pageviews', 'issues'],
};

/**
 * Fallback fields for unknown opportunity types.
 * @type {string[]}
 */
const FALLBACK_DATA_FIELDS = [
  'path',
  'sourceUrl',
  'destinationUrl',
  'metrics',
  'pageviews',
  'issues',
  'recommendations',
  'cves',
  'findings',
  'form',
  'page',
  'accessibility',
];

/**
 * Filters issues array to only include occurrences count for accessibility types.
 * @param {Array} issues - Issues array from suggestion data.
 * @returns {Array} Filtered issues array with only occurrences.
 */
const filterAccessibilityIssues = (issues) => {
  if (!Array.isArray(issues)) return issues;
  return issues.map((issue) => ({
    occurrences: issue.occurrences,
  }));
};

/**
 * Extracts minimal data fields from suggestion data with type-specific filtering.
 * @param {object} data - Suggestion data object.
 * @param {string} opportunityType - Type of opportunity (e.g., 'form-accessibility').
 * @returns {object|null} Object with only relevant fields, or null if no data.
 */
const extractMinimalData = (data, opportunityType) => {
  if (!data) return null;

  const minimalData = {};
  let hasFields = false;

  // Determine which fields to include based on opportunity type
  const typeSpecificFields = opportunityType && OPPORTUNITY_TYPE_FIELDS[opportunityType]
    ? OPPORTUNITY_TYPE_FIELDS[opportunityType]
    : FALLBACK_DATA_FIELDS;

  // Combine common URL fields with type-specific fields
  const fieldsToInclude = [...COMMON_URL_FIELDS, ...typeSpecificFields];

  for (const field of fieldsToInclude) {
    if (data[field] !== undefined) {
      // Special handling for issues array in accessibility types
      if (field === 'issues' && ACCESSIBILITY_OPPORTUNITY_TYPES.has(opportunityType)) {
        minimalData[field] = filterAccessibilityIssues(data[field]);
      } else {
        minimalData[field] = data[field];
      }
      hasFields = true;
    }
  }

  return hasFields ? minimalData : null;
};

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
