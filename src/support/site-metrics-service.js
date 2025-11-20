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
 * Helper function to validate date format (YYYY-MM-DD)
 * @param {string} dateString - Date string to validate
 * @returns {boolean} True if valid date format
 */
function isValidDate(dateString) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;

  const date = new Date(dateString);
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/**
 * Helper function to filter items by date range
 * @param {Array} items - Array of items to filter
 * @param {Function} dateGetter - Function to extract date from item
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Array} Filtered items
 */
function filterByDateRange(items, dateGetter, startDate, endDate) {
  return items.filter((item) => {
    const itemDate = dateGetter(item);
    /* c8 ignore next - Defensive check; ElectroDB entities always have date fields */
    if (!itemDate) return false;
    const dateOnly = itemDate.split('T')[0];
    return dateOnly >= startDate && dateOnly <= endDate;
  });
}

/**
 * Fetches and calculates metrics for a site
 * @param {object} context - Context object with dataAccess and log
 * @param {string} siteId - Site ID to fetch metrics for
 * @param {string} startDate - Start date (YYYY-MM-DD), defaults to '2000-01-01'
 * @param {string} endDate - End date (YYYY-MM-DD), defaults to today
 * @returns {Promise<object>} Metrics object
 */
export async function getSiteMetrics(context, siteId, startDate = '2000-01-01', endDate = null) {
  const { dataAccess, log } = context;
  const { Audit, Opportunity, Suggestion } = dataAccess;

  const effectiveEndDate = endDate || new Date().toISOString().split('T')[0];

  log.info(`Fetching metrics for site ${siteId} from ${startDate} to ${effectiveEndDate}`);

  // Fetch all data for the site
  const allAudits = await Audit.allBySiteId(siteId, { order: 'desc' });
  const allOpportunities = await Opportunity.allBySiteId(siteId);

  // Fetch suggestions for each opportunity
  const allSuggestions = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const opportunity of allOpportunities) {
    // eslint-disable-next-line no-await-in-loop
    const suggestions = await Suggestion.allByOpportunityId(opportunity.getId());
    allSuggestions.push(...suggestions);
  }

  // Filter by date range
  const filteredAudits = filterByDateRange(
    allAudits,
    (audit) => audit.getAuditedAt(),
    startDate,
    effectiveEndDate,
  );
  const filteredOpportunities = filterByDateRange(
    allOpportunities,
    (opp) => opp.getCreatedAt(),
    startDate,
    effectiveEndDate,
  );
  const filteredSuggestions = filterByDateRange(
    allSuggestions,
    (sugg) => sugg.getCreatedAt(),
    startDate,
    effectiveEndDate,
  );

  // Calculate audit metrics
  const totalAudits = filteredAudits.length;
  const successfulAudits = filteredAudits.filter((audit) => !audit.getIsError()).length;
  const failedAudits = totalAudits - successfulAudits;
  const successRate = totalAudits > 0
    ? ((successfulAudits / totalAudits) * 100).toFixed(1)
    : '0.0';

  // Breakdown by audit type
  const auditsByType = {};
  filteredAudits.forEach((audit) => {
    const type = audit.getAuditType();
    if (!auditsByType[type]) {
      auditsByType[type] = { total: 0, successful: 0, failed: 0 };
    }
    auditsByType[type].total += 1;
    if (audit.getIsError()) {
      auditsByType[type].failed += 1;
    } else {
      auditsByType[type].successful += 1;
    }
  });

  // Breakdown opportunities by type
  const opportunitiesByType = {};
  filteredOpportunities.forEach((opp) => {
    const type = opp.getType();
    opportunitiesByType[type] = (opportunitiesByType[type] || 0) + 1;
  });

  // Breakdown suggestions by status
  const suggestionsByStatus = {};
  filteredSuggestions.forEach((sugg) => {
    const status = sugg.getStatus();
    suggestionsByStatus[status] = (suggestionsByStatus[status] || 0) + 1;
  });

  return {
    siteId,
    startDate,
    endDate: effectiveEndDate,
    audits: {
      total: totalAudits,
      successful: successfulAudits,
      failed: failedAudits,
      successRate: parseFloat(successRate),
      byType: auditsByType,
    },
    opportunities: {
      total: filteredOpportunities.length,
      byType: opportunitiesByType,
    },
    suggestions: {
      total: filteredSuggestions.length,
      byStatus: suggestionsByStatus,
    },
  };
}

/**
 * Validates date inputs and returns normalized dates
 * @param {string} startDateInput - Start date input
 * @param {string} endDateInput - End date input
 * @returns {object} Object with startDate, endDate, and error (if any)
 */
export function validateAndNormalizeDates(startDateInput, endDateInput) {
  const startDate = startDateInput || '2000-01-01';
  const endDate = endDateInput || new Date().toISOString().split('T')[0];

  if (startDateInput && !isValidDate(startDate)) {
    return { error: 'Invalid start date format. Use YYYY-MM-DD format.' };
  }
  if (endDateInput && !isValidDate(endDate)) {
    return { error: 'Invalid end date format. Use YYYY-MM-DD format.' };
  }

  if (startDate > endDate) {
    return { error: 'Start date must be before or equal to end date.' };
  }

  return { startDate, endDate, error: null };
}
