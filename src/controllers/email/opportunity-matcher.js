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

import { filterHighTrafficPoorCwv } from './email-traffic-data.js';

/**
 * Normalize URL for comparison
 */
function normalizeUrl(url) {
  return url
    .replace(/^https?:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

/**
 * Extract only the fields we need from an opportunity to avoid storing large entities
 */
function extractOpportunityData(opportunity) {
  return {
    id: opportunity.getId(),
    type: opportunity.getType(),
    title: opportunity.getTitle(),
    description: opportunity.getDescription(),
    tags: opportunity.getTags(),
    data: opportunity.getData(),
    original: opportunity,
  };
}

function isValidOpportunity(opportunityData) {
  const {
    title, description, data, original, type,
  } = opportunityData;

  if (!description) {
    return false;
  }

  if (title?.toLowerCase().includes('report')) {
    return false;
  }

  const projectedTrafficValue = data?.projectedTrafficValue || 0;
  const projectedConversionValue = data?.projectedConversionValue || 0;
  const projectedEngagementValue = data?.projectedEngagementValue || 0;

  const hasValue = projectedTrafficValue > 0
    || projectedConversionValue > 0
    || projectedEngagementValue > 0;
  if (!hasValue) {
    return false;
  }

  const formTypes = [
    'high-form-views-low-conversions',
    'high-page-views-low-form-nav',
    'high-page-views-low-form-views',
    'form-accessibility',
  ];
  if (formTypes.includes(type)) {
    if (data?.scrapedStatus === false) {
      return false;
    }

    const recommendations = original.getGuidance?.()?.recommendations;
    const hasInvalidBrief = recommendations?.some(
      (rec) => rec?.brief === null || rec?.brief === undefined,
    );
    if (hasInvalidBrief) {
      return false;
    }
  }

  return true;
}

/**
 * Configuration for email opportunity type handlers.
 * Each handler defines how to categorize opportunities and what data filtering they need.
 * requiresUrlMatching: if true, opportunities need to match URLs from email traffic data.
 */
const OPPORTUNITY_TYPE_CONFIGS = [
  {
    // Email campaign opportunities - included directly without URL matching
    category: 'emailCampaign',
    displayName: 'email campaign',
    requiresUrlMatching: false,
    matcher: (oppData) => {
      const { tags, data } = oppData;
      const lowerTags = tags?.map((tag) => tag?.toLowerCase());
      return lowerTags?.includes('email traffic')
        || lowerTags?.includes('email campaign')
        || data?.opportunityType === 'email-traffic';
    },
  },
  {
    // CWV opportunities - require URL matching with poor CWV from email traffic
    category: 'cwv',
    displayName: 'CWV',
    requiresUrlMatching: true,
    matcher: (oppData) => oppData?.type === 'cwv',
    dataFilter: (trafficData, pageViewThreshold, log) => filterHighTrafficPoorCwv(
      trafficData,
      pageViewThreshold,
      log,
    ),
  },
  {
    // Forms opportunities - require URL matching with any email traffic
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
    dataFilter: null,
  },
];

/**
 * Categorize opportunities by type.
 * Applies global validation filter first, then categorizes by type.
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
  allEmailTrafficData,
  pageViewThreshold,
  suggestionsByOpportunityId,
  log,
) {
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

  if (allOpportunitiesNeedingMatching.length === 0 || allEmailTrafficData.length === 0) {
    log.info('No opportunities require URL matching or no email traffic data available');
    return { matchResults: new Map(), emailUrlsMap: new Map() };
  }

  log.info(`Matching ${allOpportunitiesNeedingMatching.length} opportunities against ${allEmailTrafficData.length} email URLs`);

  // Build normalized URL map ONCE for all email traffic data
  const normalizedUrlToDataMap = new Map();
  allEmailTrafficData.forEach((item) => {
    const normalized = normalizeUrl(item.url);
    const pageviews = parseInt(item.pageviews, 10);
    normalizedUrlToDataMap.set(normalized, { url: item.url, pageviews });
  });

  // Pre-filter traffic data by opportunity category
  const filteredDataByCategory = new Map();
  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      const filteredData = config.dataFilter
        ? config.dataFilter(allEmailTrafficData, pageViewThreshold, log)
        : allEmailTrafficData;

      const normalizedUrlSet = new Set(filteredData.map((item) => normalizeUrl(item.url)));
      filteredDataByCategory.set(config.category, normalizedUrlSet);
    }
  });

  // Use the pre-fetched NEW suggestions from the cached map
  const allSuggestions = allOpportunitiesNeedingMatching.map((oppData) => {
    const cached = suggestionsByOpportunityId.get(oppData.id);
    return cached?.newSuggestions || [];
  });

  const matchResults = new Map();
  const emailUrlsMap = new Map();

  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      matchResults.set(config.category, []);
    }
  });

  allOpportunitiesNeedingMatching.forEach((oppData, index) => {
    const suggestions = allSuggestions[index];
    const opportunityId = oppData.id;

    const config = OPPORTUNITY_TYPE_CONFIGS.find(
      (c) => c.requiresUrlMatching && c.matcher(oppData),
    );

    const allowedUrls = filteredDataByCategory.get(config.category);
    const matchedEmailUrlsMap = new Map();

    if (config.category === 'forms' && oppData.data?.form) {
      const formUrl = oppData.data.form;
      const normalized = normalizeUrl(formUrl);

      if (normalizedUrlToDataMap.has(normalized) && allowedUrls.has(normalized)) {
        const emailUrlData = normalizedUrlToDataMap.get(normalized);
        matchedEmailUrlsMap.set(formUrl, emailUrlData.pageviews);
      }
    } else {
      const urlFields = ['url', 'url_from', 'urlFrom', 'url_to', 'urlTo'];

      suggestions.forEach((suggestion) => {
        const suggestionData = suggestion.getData();
        urlFields.forEach((field) => {
          if (suggestionData[field]) {
            const suggestionUrl = suggestionData[field];
            const normalized = normalizeUrl(suggestionUrl);

            if (normalizedUrlToDataMap.has(normalized) && allowedUrls.has(normalized)) {
              const emailUrlData = normalizedUrlToDataMap.get(normalized);
              matchedEmailUrlsMap.set(suggestionUrl, emailUrlData.pageviews);
            }
          }
        });
      });
    }

    if (matchedEmailUrlsMap.size > 0) {
      const urlsWithPageviews = Array.from(matchedEmailUrlsMap.entries())
        .map(([url, pageviews]) => ({ url, pageviews }))
        .sort((a, b) => b.pageviews - a.pageviews);

      const sortedUrls = urlsWithPageviews.map((item) => item.url);
      const totalPageViews = urlsWithPageviews.reduce((sum, item) => sum + item.pageviews, 0);

      emailUrlsMap.set(opportunityId, { urls: sortedUrls, pageViews: totalPageViews });
      matchResults.get(config.category).push(oppData);
    }
  });

  OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
    if (config.requiresUrlMatching) {
      const matched = matchResults.get(config.category);
      const total = opportunitiesByCategory.get(config.category)?.length || 0;
      log.info(`Matched ${matched.length}/${total} ${config.displayName} opportunities with email URLs`);
    }
  });

  return { matchResults, emailUrlsMap };
}

/**
 * Combine and sort opportunities, converting back to original opportunity objects.
 * Limits to 10 total opportunities with max 2 per type.
 */
function combineAndSortOpportunities(categorizedOpportunities, matchResults) {
  const filteredOpportunitiesData = [];

  for (const config of OPPORTUNITY_TYPE_CONFIGS) {
    if (config.requiresUrlMatching) {
      const matched = matchResults.get(config.category) || [];
      filteredOpportunitiesData.push(...matched);
    } else {
      filteredOpportunitiesData.push(...categorizedOpportunities.get(config.category));
    }
  }

  filteredOpportunitiesData.sort((a, b) => {
    const aValue = a.data.projectedEngagementValue
      || a.data.projectedConversionValue
      || a.data.projectedTrafficValue;
    const bValue = b.data.projectedEngagementValue
      || b.data.projectedConversionValue
      || b.data.projectedTrafficValue;
    return bValue - aValue;
  });

  const typeCount = new Map();
  const limitedOpportunities = [];

  for (const oppData of filteredOpportunitiesData) {
    const { type } = oppData;
    const count = typeCount.get(type) || 0;

    if (count < 2 && limitedOpportunities.length < 10) {
      limitedOpportunities.push(oppData);
      typeCount.set(type, count + 1);
    }
  }

  return limitedOpportunities.map((oppData) => oppData.original);
}

export {
  OPPORTUNITY_TYPE_CONFIGS,
  normalizeUrl,
  isValidOpportunity,
  categorizeOpportunities,
  processOpportunityMatching,
  combineAndSortOpportunities,
};
