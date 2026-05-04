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
 * Data transfer object for Opportunity Summary.
 * Used for organization-level opportunity aggregation.
 */
export const OpportunitySummaryDto = {

  /**
   * Converts an Opportunity object with its suggestions into a summary JSON object.
   * @param {Readonly<Opportunity>} opportunity - Opportunity object.
   * @param {Array<Readonly<Suggestion>>} suggestions - Array of suggestion objects.
   * @param {Object} paidUrlsData - Optional object with urls and pageViews for CWV opportunities.
   * @returns {{
   *  opportunityId: string,
   *  urls: Array<string>,
   *  name: string,
   *  type: null,
   *  description: null,
   *  status: string,
   *  system_type: string,
   *  system_description: string,
   *  pageViews: number,
   *  projectedTrafficLost: number,
   *  projectedTrafficValue: number,
   *  projectedConversionValue: number,
   *  projectedEngagementValue: number,
   *  impact: number,
   *  impactFieldName: string|null
   * }} JSON object.
   */
  toJSON: (opportunity, suggestions = [], paidUrlsData = null, topUrlsLimit = 20) => {
    // Extract unique URLs from suggestions
    const urls = new Set();
    let totalPageViews = 0;

    const opportunityType = opportunity.getType();
    const isSiteWideOpportunity = opportunityType === 'consent-banner';

    // Get opportunity data early to check for page-specific URLs
    const opportunityData = opportunity.getData() || {};

    // If paidUrlsData provided, use those URLs and pageViews
    // (for CWV opportunities from paid traffic)
    if (paidUrlsData && paidUrlsData.urls && !isSiteWideOpportunity) {
      paidUrlsData.urls.forEach((url) => urls.add(url));
      totalPageViews = paidUrlsData.pageViews || 0;
    } else {
      // Check if opportunity data has a page-specific URL
      // (e.g., no-cta-above-the-fold, high-organic-low-ctr)
      if (opportunityData.page && !isSiteWideOpportunity) {
        urls.add(opportunityData.page);
      }

      // Extract all URLs from suggestion data (for paid media opportunities)
      if (!isSiteWideOpportunity) {
        suggestions.forEach((suggestion) => {
          const data = suggestion.getData();
          if (!data) {
            return; // Skip if data is null/undefined
          }
          // Handle different URL field names in suggestion data
          if (data.url_from) {
            urls.add(data.url_from);
          }
          if (data.url_to) {
            urls.add(data.url_to);
          }
          if (data.urlFrom) {
            urls.add(data.urlFrom);
          }
          if (data.urlTo) {
            urls.add(data.urlTo);
          }
          if (data.url) {
            urls.add(data.url);
          }
          // Handle no-cta-above-the-fold contentFix structure
          if (data.contentFix?.page_patch?.original_page_url) {
            urls.add(data.contentFix.page_patch.original_page_url);
          }
        });
      }

      // Use pageViews from opportunity data if available
      if (opportunityData.pageViews && typeof opportunityData.pageViews === 'number') {
        totalPageViews = opportunityData.pageViews;
      } else {
        // Otherwise, aggregate page views from rank (which often represents traffic)
        suggestions.forEach((suggestion) => {
          const data = suggestion.getData();
          if (!data) {
            return; // Skip if data is null/undefined
          }
          const rank = suggestion.getRank();
          if (rank && typeof rank === 'number') {
            totalPageViews += rank;
          }

          // Also check for traffic_domain or trafficDomain in data
          if (data.traffic_domain && typeof data.traffic_domain === 'number') {
            totalPageViews += data.traffic_domain;
          }
          if (data.trafficDomain && typeof data.trafficDomain === 'number') {
            totalPageViews += data.trafficDomain;
          }
        });
      }
    }
    const projectedTrafficLost = opportunityData.projectedTrafficLost || 0;
    const projectedTrafficValue = opportunityData.projectedTrafficValue || 0;
    const projectedConversionValue = opportunityData.projectedConversionValue || 0;
    const projectedEngagementValue = opportunityData.projectedEngagementValue || 0;

    // Determine impact value and field name
    // Priority: projectedEngagementValue > projectedConversionValue > projectedTrafficValue
    let impact = 0;
    let impactFieldName = null;

    if (projectedEngagementValue > 0) {
      impact = projectedEngagementValue;
      impactFieldName = 'projectedEngagementValue';
    } else if (projectedConversionValue > 0) {
      impact = projectedConversionValue;
      impactFieldName = 'projectedConversionValue';
    } else if (projectedTrafficValue > 0) {
      impact = projectedTrafficValue;
      impactFieldName = 'projectedTrafficValue';
    }

    return {
      opportunityId: opportunity.getId(),
      urls: Array.from(urls).slice(0, topUrlsLimit),
      name: opportunity.getTitle(),
      type: null,
      description: null,
      status: opportunity.getStatus(),
      system_type: opportunityType,
      system_description: opportunity.getDescription(),
      pageViews: totalPageViews,
      projectedTrafficLost,
      projectedTrafficValue,
      projectedConversionValue,
      projectedEngagementValue,
      impact,
      impactFieldName,
    };
  },
};
