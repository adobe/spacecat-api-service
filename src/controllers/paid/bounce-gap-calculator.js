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

/**
 * Calculates bounce gap loss for consent banner analysis.
 * Formula: sum of (pageViews × max(0, bounceRate_treatment - bounceRate_control)) per group
 *
 * @param {Object} grouped - Data grouped by dimension, e.g.:
 *   { paid: { show: { pageViews, bounceRate }, hidden: { pageViews, bounceRate } } }
 * @param {Object} log - Logger instance
 * @param {string} treatment - Treatment key (default: 'show')
 * @param {string} control - Control key (default: 'hidden')
 * @returns {Object} { totalLoss, byGroup }
 */
export function calculateGenericBounceGapLoss(grouped, log, treatment = 'show', control = 'hidden') {
  const byGroup = {};
  let totalLoss = 0;
  let skippedCount = 0;

  Object.entries(grouped).forEach(([group, variants]) => {
    const t = variants[treatment];
    const c = variants[control];

    if (!t || !c) {
      skippedCount += 1;
      return;
    }

    const delta = Math.max(0, t.bounceRate - c.bounceRate);
    const loss = t.pageViews * delta;

    byGroup[group] = { loss, delta };
    totalLoss += loss;
  });

  if (skippedCount > 0) {
    log.debug(`[bounce-gap] Skipped ${skippedCount} dimension group(s) with incomplete data`);
  }

  return { totalLoss, byGroup };
}

/**
 * Groups Athena query results by dimensions and consent state.
 *
 * @param {Array} results - Raw Athena query results with consent field
 * @param {Array<string>} dimensions - Dimension fields to group by (e.g., ['path', 'trf_type'])
 * @returns {Object} Grouped data structure
 */
export function groupByDimensionsAndConsent(results, dimensions) {
  const grouped = {};

  results.forEach((row) => {
    // Create a composite key from all dimensions
    const dimensionKey = dimensions.map((dim) => row[dim] || 'unknown').join('|');
    const { consent } = row;

    if (!grouped[dimensionKey]) {
      grouped[dimensionKey] = {};
    }

    grouped[dimensionKey][consent] = {
      pageViews: parseInt(row.pageviews, 10) || 0,
      bounceRate: parseFloat(row.bounce_rate) || 0,
      ...Object.fromEntries(dimensions.map((dim) => [dim, row[dim]])),
    };
  });

  return grouped;
}

/**
 * Calculates bounce gap loss from Athena results for consent banner analysis.
 *
 * @param {Array} results - Athena query results with consent dimension
 * @param {Array<string>} dimensions - Dimensions used in the query (excluding 'consent')
 * @param {Object} log - Logger instance
 * @returns {Object} { projectedTrafficLost, hasShowData, hasHiddenData, byDimension }
 */
export function calculateConsentBounceGapLoss(results, dimensions, log) {
  const TREATMENT = 'show';
  const CONTROL = 'hidden';

  // Check if we have data for both consent states
  const hasShowData = results.some((row) => row.consent === TREATMENT);
  const hasHiddenData = results.some((row) => row.consent === CONTROL);

  if (!hasShowData || !hasHiddenData) {
    log.warn(`[bounce-gap] Missing consent data - show:${hasShowData} hidden:${hasHiddenData}`);
    return {
      projectedTrafficLost: 0,
      hasShowData,
      hasHiddenData,
      byDimension: {},
    };
  }

  // Group by dimensions and consent
  const grouped = groupByDimensionsAndConsent(results, dimensions);

  // Calculate bounce gap loss
  const result = calculateGenericBounceGapLoss(grouped, log, TREATMENT, CONTROL);

  return {
    projectedTrafficLost: result.totalLoss,
    hasShowData,
    hasHiddenData,
    byDimension: result.byGroup,
  };
}
