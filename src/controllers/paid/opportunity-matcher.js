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

import { filterHighTrafficPoorCwv } from './paid-traffic-data.js';

/**
 * Normalize URL for comparison
 */
function normalizeUrl(url) {
  return url
    .replace(/^https?:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

/**
 * Extract only the fields we need from an opportunity to avoid storing large DynamoDB entities
 */
function extractOpportunityData(opportunity) {
  return {
    id: opportunity.getId(),
    type: opportunity.getType(),
    title: opportunity.getTitle(),
    description: opportunity.getDescription(),
    tags: opportunity.getTags(),
    data: opportunity.getData(),
    // Keep reference to original for final DTO conversion
    original: opportunity,
  };
}

function isValidOpportunity(opportunityData) {
  const {
    title, description, data,
  } = opportunityData;

  // Must have description
  if (!description) return false;

  // Exclude reports
  if (title?.toLowerCase().includes('report')) return false;

  // Must have positive value metric
  // CWV opportunities use projectedTrafficValue
  // Forms opportunities use projectedConversionValue
  const projectedTrafficValue = data.projectedTrafficValue || 0;
  const projectedConversionValue = data.projectedConversionValue || 0;

  const hasValue = projectedTrafficValue > 0 || projectedConversionValue > 0;
  if (!hasValue) return false;

  return true;
}

/**
 * Configuration for opportunity type handlers.
 * Each handler defines how to categorize opportunities and what data filtering they need.
 * requiresUrlMatching: if true, opportunities need to match URLs from Athena paid traffic data
 */
const OPPORTUNITY_TYPE_CONFIGS = [
  {
    // Paid media opportunities - included directly without URL matching
    category: 'paidMedia',
    displayName: 'paid media',
    requiresUrlMatching: false,
    matcher: (oppData) => {
      const { tags, type, data } = oppData;
      return tags.some((tag) => tag?.toLowerCase() === 'paid media')
        || type === 'consent-banner'
        || data?.opportunityType === 'no-cta-above-the-fold';
    },
  },
  {
    // CWV opportunities - require URL matching with poor CWV from paid traffic
    category: 'cwv',
    displayName: 'CWV',
    requiresUrlMatching: true,
    matcher: (oppData) => oppData.type === 'cwv',
    // Custom data filter - only match URLs with poor CWV scores
    dataFilter: (trafficData, pageViewThreshold, log) => filterHighTrafficPoorCwv(
      trafficData,
      pageViewThreshold,
      log,
    ),
  },
  {
    // Forms opportunities - require URL matching with any paid traffic
    category: 'forms',
    displayName: 'forms',
    requiresUrlMatching: true,
    matcher: (oppData) => {
      const formTypes = [
        'high-form-views-low-conversions',
        'high-page-views-low-form-nav',
        'high-page-views-low-form-views',
        'form-accessibility',
      ];
      return formTypes.includes(oppData.type);
    },
    // No custom filter - use all paid traffic data
    dataFilter: null,
  },
];

async function matchOpportunitiesWithPaidUrls(
  opportunities,
  paidTrafficData,
  Suggestion,
  log,
  opportunityTypeName = 'opportunities',
) {
  if (opportunities.length === 0 || paidTrafficData.length === 0) {
    log.info(`No matching needed: ${opportunityTypeName}=${opportunities.length}, paidTrafficData=${paidTrafficData.length}`);
    return { matched: [], paidUrlsMap: new Map() };
  }

  const paidUrls = paidTrafficData.map((item) => item.url);
  log.info(`Matching ${opportunities.length} ${opportunityTypeName} against ${paidUrls.length} URLs from paid traffic`);

  // Create a map of normalized URL -> { url, pageviews } for fast lookup
  const normalizedUrlToDataMap = new Map();
  paidTrafficData.forEach((item) => {
    const normalized = normalizeUrl(item.url);
    const pageviews = parseInt(item.pageviews, 10);
    normalizedUrlToDataMap.set(normalized, { url: item.url, pageviews });
  });

  const suggestionsPromises = opportunities.map(
    (opportunity) => Suggestion.allByOpportunityIdAndStatus(opportunity.getId(), 'NEW'),
  );
  const allSuggestions = await Promise.all(suggestionsPromises);

  const matched = [];
  const paidUrlsMap = new Map();

  opportunities.forEach((opportunity, index) => {
    const suggestions = allSuggestions[index];
    const opportunityId = opportunity.getId();

    // Collect all URLs from paid traffic that match NEW suggestions only
    const matchedPaidUrlsMap = new Map();
    const urlFields = ['url', 'url_from', 'urlFrom', 'url_to', 'urlTo'];

    suggestions.forEach((suggestion) => {
      const suggestionData = suggestion.getData();
      urlFields.forEach((field) => {
        if (suggestionData[field]) {
          const suggestionUrl = suggestionData[field];
          const normalized = normalizeUrl(suggestionUrl);
          if (normalizedUrlToDataMap.has(normalized)) {
            const paidUrlData = normalizedUrlToDataMap.get(normalized);
            // Store suggestion URL with pageviews from paid traffic
            matchedPaidUrlsMap.set(suggestionUrl, paidUrlData.pageviews);
          }
        }
      });
    });

    if (matchedPaidUrlsMap.size > 0) {
      // Sort by pageviews descending
      const urlsWithPageviews = Array.from(matchedPaidUrlsMap.entries())
        .map(([url, pageviews]) => ({ url, pageviews }))
        .sort((a, b) => b.pageviews - a.pageviews);

      const sortedUrls = urlsWithPageviews.map((item) => item.url);
      const totalPageViews = urlsWithPageviews.reduce((sum, item) => sum + item.pageviews, 0);

      paidUrlsMap.set(opportunityId, { urls: sortedUrls, pageViews: totalPageViews });
      matched.push(opportunity);
    }
  });

  log.info(`Matched ${matched.length} ${opportunityTypeName} with URLs from paid traffic`);
  return { matched, paidUrlsMap };
}

/**
 * Categorize opportunities by type
 * Applies global validation filter first, then categorizes by type
 */
function categorizeOpportunities(allOpportunities) {
  const categorizedOpportunities = new Map();
  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    categorizedOpportunities.set(config.category, []);
  });

  for (const opportunity of allOpportunities) {
    const oppData = extractOpportunityData(opportunity);
    if (isValidOpportunity(oppData)) {
      const matchingConfig = OPPORTUNITY_TYPE_CONFIGS.find((config) => config.matcher(oppData));
      if (matchingConfig) {
        categorizedOpportunities.get(matchingConfig.category).push(oppData);
      }
    }
  }

  return categorizedOpportunities;
}

async function processOpportunityMatching(
  categorizedOpportunities,
  allPaidTrafficData,
  pageViewThreshold,
  Suggestion,
  log,
) {
  // Collect all opportunities that need URL matching
  const opportunitiesByCategory = new Map();
  const allOpportunitiesNeedingMatching = [];

  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      const opportunities = categorizedOpportunities.get(config.category);
      if (opportunities.length > 0) {
        opportunitiesByCategory.set(config.category, opportunities);
        allOpportunitiesNeedingMatching.push(...opportunities);
      }
    }
  });

  // Early exit if no opportunities need matching
  if (allOpportunitiesNeedingMatching.length === 0 || allPaidTrafficData.length === 0) {
    log.info('No opportunities require URL matching or no paid traffic data available');
    return { matchResults: new Map(), paidUrlsMap: new Map() };
  }

  log.info(`Matching ${allOpportunitiesNeedingMatching.length} opportunities against ${allPaidTrafficData.length} paid URLs`);

  // Build normalized URL map ONCE for all paid traffic data
  const normalizedUrlToDataMap = new Map();
  allPaidTrafficData.forEach((item) => {
    const normalized = normalizeUrl(item.url);
    const pageviews = parseInt(item.pageviews, 10);
    normalizedUrlToDataMap.set(normalized, { url: item.url, pageviews });
  });

  // Pre-filter traffic data by opportunity category
  const filteredDataByCategory = new Map();
  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      const filteredData = config.dataFilter
        ? config.dataFilter(allPaidTrafficData, pageViewThreshold, log)
        : allPaidTrafficData;

      // Build a Set of normalized URLs for fast lookup
      const normalizedUrlSet = new Set(filteredData.map((item) => normalizeUrl(item.url)));
      filteredDataByCategory.set(config.category, normalizedUrlSet);
    }
  });

  // Fetch ALL suggestions ONCE for all opportunities
  const suggestionsPromises = allOpportunitiesNeedingMatching.map(
    (oppData) => Suggestion.allByOpportunityIdAndStatus(oppData.id, 'NEW'),
  );
  const allSuggestions = await Promise.all(suggestionsPromises);

  // Match opportunities with URLs and categorize results
  const matchResults = new Map();
  const paidUrlsMap = new Map();

  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      matchResults.set(config.category, []);
    }
  });

  // Process each opportunity ONCE
  allOpportunitiesNeedingMatching.forEach((oppData, index) => {
    const suggestions = allSuggestions[index];
    const opportunityId = oppData.id;

    // Find which category this opportunity belongs to
    const config = OPPORTUNITY_TYPE_CONFIGS.find(
      (c) => c.requiresUrlMatching && c.matcher(oppData),
    );

    if (!config) return;

    // Get the pre-filtered URL set for this category
    const allowedUrls = filteredDataByCategory.get(config.category);

    // Collect all URLs from suggestions OR from opportunity data (for forms)
    const matchedPaidUrlsMap = new Map();

    // Forms opportunities have URL in data.form field, not in suggestions
    if (config.category === 'forms' && oppData.data.form) {
      const formUrl = oppData.data.form;
      const normalized = normalizeUrl(formUrl);

      // Check if URL is in paid traffic AND passes category filter
      if (normalizedUrlToDataMap.has(normalized) && allowedUrls.has(normalized)) {
        const paidUrlData = normalizedUrlToDataMap.get(normalized);
        matchedPaidUrlsMap.set(formUrl, paidUrlData.pageviews);
      }
    } else {
      // For other opportunity types (CWV, etc.), get URLs from suggestions
      const urlFields = ['url', 'url_from', 'urlFrom', 'url_to', 'urlTo'];

      suggestions.forEach((suggestion) => {
        const suggestionData = suggestion.getData();
        urlFields.forEach((field) => {
          if (suggestionData[field]) {
            const suggestionUrl = suggestionData[field];
            const normalized = normalizeUrl(suggestionUrl);

            // Check if URL is in paid traffic AND passes category filter
            if (normalizedUrlToDataMap.has(normalized) && allowedUrls.has(normalized)) {
              const paidUrlData = normalizedUrlToDataMap.get(normalized);
              matchedPaidUrlsMap.set(suggestionUrl, paidUrlData.pageviews);
            }
          }
        });
      });
    }

    if (matchedPaidUrlsMap.size > 0) {
      // Sort by pageviews descending
      const urlsWithPageviews = Array.from(matchedPaidUrlsMap.entries())
        .map(([url, pageviews]) => ({ url, pageviews }))
        .sort((a, b) => b.pageviews - a.pageviews);

      const sortedUrls = urlsWithPageviews.map((item) => item.url);
      const totalPageViews = urlsWithPageviews.reduce((sum, item) => sum + item.pageviews, 0);

      paidUrlsMap.set(opportunityId, { urls: sortedUrls, pageViews: totalPageViews });
      matchResults.get(config.category).push(oppData);
    }
  });

  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      const matched = matchResults.get(config.category);
      const total = opportunitiesByCategory.get(config.category)?.length || 0;
      log.info(`Matched ${matched.length}/${total} ${config.displayName} opportunities with paid URLs`);
    }
  });

  return { matchResults, paidUrlsMap };
}

/**
 * Combine and sort opportunities, converting back to original opportunity objects
 */
function combineAndSortOpportunities(categorizedOpportunities, matchResults) {
  const filteredOpportunitiesData = [];

  for (const config of OPPORTUNITY_TYPE_CONFIGS) {
    if (config.requiresUrlMatching) {
      // Add matched opportunities from URL filtering
      const matched = matchResults.get(config.category) || [];
      filteredOpportunitiesData.push(...matched);
    } else {
      // Add opportunities that don't require URL matching (e.g., paid media tag)
      filteredOpportunitiesData.push(...categorizedOpportunities.get(config.category));
    }
  }

  // Sort by value descending
  // CWV opportunities use projectedTrafficValue
  // Forms opportunities use projectedConversionValue
  filteredOpportunitiesData.sort((a, b) => {
    const aValue = a.data.projectedTrafficValue || a.data.projectedConversionValue || 0;
    const bValue = b.data.projectedTrafficValue || b.data.projectedConversionValue || 0;
    return bValue - aValue;
  });

  // Convert back to original opportunity objects
  return filteredOpportunitiesData.map((oppData) => oppData.original);
}

export {
  OPPORTUNITY_TYPE_CONFIGS,
  normalizeUrl,
  isValidOpportunity,
  matchOpportunitiesWithPaidUrls,
  categorizeOpportunities,
  processOpportunityMatching,
  combineAndSortOpportunities,
};
