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
 * Supported localizable fields that can be translated for suggestions.
 * @type {string[]}
 */
export const ALLOWED_I18N_FIELDS = [
  'title',
  'description',
  'rationale',
  'aiRationale',
  'aiSuggestion',
  'actionItems',
  'persona',
];

/**
 * Valid skip reasons when a suggestion is marked as SKIPPED.
 * @type {string[]}
 */
export const SUGGESTION_SKIP_REASONS = Object.values(Suggestion.SKIP_REASONS);

/**
 * Extracts minimal data fields from suggestion data using schema-driven projection.
 * Uses Suggestion.getProjection() from spacecat-shared-data-access.
 *
 * @param {object} data - Suggestion data object.
 * @param {string} opportunityType - Type of opportunity (e.g., 'structured-data').
 * @returns {object|null} Object with only relevant fields, or null if no data.
 */
const extractMinimalData = (data, opportunityType) => {
  if (!data) {
    return null;
  }

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
   *
   * Translations for AI-generated fields (title, rationale, description, etc.) are stored by
   * audit workers in `suggestion.data.i18n` as a map of locale → { field: value, ... }.
   * When `locale` is supplied the matching translation is merged on top of `data` and
   * `data.i18n` is stripped so the response shape stays stable.
   * Falls back to the original English values when the locale is absent or not found.
   *
   * @param {Readonly<Suggestion>} suggestion - Suggestion object.
   * @param {string} [view='full'] - Projection view: 'minimal', 'summary', or 'full'.
   * @param {object} [opportunity] - Optional opportunity entity for type-specific filtering.
   * @param {string|null} [locale] - Optional locale code (e.g. 'fr_fr', 'ja_jp').
   * @returns {object} JSON object with fields based on the selected view.
   */
  toJSON: (suggestion, view = 'full', opportunity = null, locale = null) => {
    const rawData = suggestion.getData();
    const opportunityType = opportunity?.getType() || null;

    // Apply locale projection and strip the internal i18n key from the response
    // eslint-disable-next-line no-unused-vars
    const { i18n, ...baseData } = rawData ?? {};
    let data = baseData;

    if (locale && i18n?.[locale]) {
      const localized = i18n[locale];
      const filteredLocalized = {};
      for (const field of ALLOWED_I18N_FIELDS) {
        if (localized[field] != null) {
          filteredLocalized[field] = localized[field];
        }
      }
      data = { ...baseData, ...filteredLocalized };
    }

    const skipReason = suggestion.getSkipReason?.();
    const skipDetail = suggestion.getSkipDetail?.();
    const skipFields = {};
    if (skipReason != null) {
      skipFields.skipReason = skipReason;
    }
    if (skipDetail != null) {
      skipFields.skipDetail = skipDetail;
    }

    // Minimal view: id, status, timestamps, and URL-related data fields
    if (view === 'minimal') {
      const minimalData = extractMinimalData(data, opportunityType);
      return {
        id: suggestion.getId(),
        status: suggestion.getStatus(),
        ...(minimalData && { data: minimalData }),
        createdAt: suggestion.getCreatedAt(),
        updatedAt: suggestion.getUpdatedAt(),
      };
    }

    // Summary view: minimal fields + metadata (superset of minimal, subset of full)
    if (view === 'summary') {
      const minimalData = extractMinimalData(data, opportunityType);
      return {
        id: suggestion.getId(),
        status: suggestion.getStatus(),
        ...(minimalData && { data: minimalData }),
        ...skipFields,
        opportunityId: suggestion.getOpportunityId(),
        type: suggestion.getType(),
        rank: suggestion.getRank(),
        createdAt: suggestion.getCreatedAt(),
        updatedAt: suggestion.getUpdatedAt(),
        updatedBy: suggestion.getUpdatedBy(),
      };
    }

    const aggregationKey = data.aggregationKey || buildAggregationKeyFromSuggestion(data);

    return {
      id: suggestion.getId(),
      opportunityId: suggestion.getOpportunityId(),
      type: suggestion.getType(),
      rank: suggestion.getRank(),
      status: suggestion.getStatus(),
      ...skipFields,
      data: {
        ...data,
        ...(aggregationKey && { aggregationKey }),
      },
      kpiDeltas: suggestion.getKpiDeltas(),
      createdAt: suggestion.getCreatedAt(),
      updatedAt: suggestion.getUpdatedAt(),
      updatedBy: suggestion.getUpdatedBy(),
    };
  },
};
