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
   *  projectedTrafficValue: number
   * }} JSON object.
   */
  toJSON: (opportunity, suggestions = [], paidUrlsData = null, topUrlsLimit = 20) => {
    // Extract unique URLs from suggestions
    const urls = new Set();
    let totalPageViews = 0;

    // If paidUrlsData provided, use those URLs and pageViews
    // (for CWV opportunities from paid traffic)
    if (paidUrlsData && paidUrlsData.urls) {
      paidUrlsData.urls.forEach((url) => urls.add(url));
      totalPageViews = paidUrlsData.pageViews || 0;
    } else {
      // Otherwise, extract all URLs from suggestion data (for paid media opportunities)
      suggestions.forEach((suggestion) => {
        const data = suggestion.getData();
        // Handle different URL field names in suggestion data
        if (data.url_from) urls.add(data.url_from);
        if (data.url_to) urls.add(data.url_to);
        if (data.urlFrom) urls.add(data.urlFrom);
        if (data.urlTo) urls.add(data.urlTo);
        if (data.url) urls.add(data.url);
      });

      // Aggregate page views from rank (which often represents traffic)
      suggestions.forEach((suggestion) => {
        const data = suggestion.getData();
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

    // Get projected traffic data from opportunity data
    const opportunityData = opportunity.getData() || {};
    const projectedTrafficLost = opportunityData.projectedTrafficLost || 0;
    const projectedTrafficValue = opportunityData.projectedTrafficValue || 0;

    return {
      opportunityId: opportunity.getId(),
      urls: Array.from(urls).slice(0, topUrlsLimit),
      name: opportunity.getTitle(),
      type: null,
      description: null,
      status: opportunity.getStatus(),
      system_type: opportunity.getType(),
      system_description: opportunity.getDescription(),
      pageViews: totalPageViews,
      projectedTrafficLost,
      projectedTrafficValue,
    };
  },
};
