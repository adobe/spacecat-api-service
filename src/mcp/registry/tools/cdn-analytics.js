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

import { z } from 'zod';
import { CdnAnalyticsService } from '@adobe/spacecat-shared-cdn-analytics';

/* c8 ignore start */
/**
 * Helper function to resolve site from either siteId or baseURL
 * @param {Object} Site - Site data access object
 * @param {string} siteId - Optional site ID
 * @param {string} baseURL - Optional base URL
 * @returns {Promise<Object>} Site object
 * @throws {Error} If site not found or neither parameter provided
 */
async function resolveSite(Site, siteId, baseURL) {
  if (siteId) {
    const site = await Site.findById(siteId);
    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }
    return site;
  }

  if (baseURL) {
    const site = await Site.findByBaseURL(baseURL);
    if (!site) {
      throw new Error(`Site with base URL ${baseURL} not found`);
    }
    return site;
  }

  throw new Error('Either siteId or baseURL must be provided');
}

/**
 * Provide contextual insights based on analysis type
 */
function getAnalysisInsights(analysisType, result) {
  const insights = {
    'agentic-traffic': 'This analysis shows AI bot and crawler activity patterns. Look for dominant user agents, unusual spikes, or changes in bot behavior over time.',
    'popular-content': 'This shows your most accessed content. High traffic URLs indicate popular pages, while trends show seasonal or promotional impacts.',
    'url-patterns': 'This reveals general URL access patterns. Look for traffic distribution, successful vs failed requests, and access trends.',
    'error-analysis': 'This focuses on failed requests. High 404s may indicate broken links, while 403s suggest access control issues.',
    'country-patterns': 'This shows traffic distribution by country/region. Useful for understanding your global audience and regional access patterns.',
  };

  return {
    description: insights[analysisType],
    resultCount: result?.results?.length || 0,
    analysisType,
  };
}

export function createCdnAnalyticsTools(sitesController, context) {
  if (!sitesController) {
    return {};
  }

  const { dataAccess } = context;
  const { Site } = dataAccess;

  const analyzeCdnTrafficTool = {
    annotations: {
      title: 'Analyze agentic traffic patterns',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `
      <use_case>Analyze agentic traffic patterns to understand agentic behavior, user agent activity, content performance, and traffic trends. Perfect for identifying which AI agents are accessing your site, what content is popular, and where issues occur.</use_case>
      <agent_guidance>
        Use when users ask about:
        - "Show me agentic traffic" or "What AI agents visit my site" → use analysisType: "agentic-traffic"
        - "What's popular on my site" or "Most visited pages" → use analysisType: "popular-content"  
        - "Analyze URL patterns" or "Content access trends" → use analysisType: "url-patterns"
        - "Show me errors" or "Find 404s" → use analysisType: "error-analysis" with statusFilter: "404"
        - "Where are visitors from" → use analysisType: "country-patterns"
      </agent_guidance>
      <important_notes>
        1. Current date reference: ${new Date().toLocaleDateString()}.
        2. DATE HANDLING: Uses Monday-Sunday week boundaries. Specify numberOfWeeks for analysis period.
        3. ANALYSIS TYPES: bot-traffic, popular-content, url-patterns, error-analysis, geographic-patterns
        4. FILTERING: Use agentFilter for specific AI agents, statusFilter for HTTP status codes
      </important_notes>
      `,
    inputSchema: z.object({
      analysisType: z.enum(['agentic-traffic', 'popular-content', 'url-patterns', 'error-analysis', 'country-patterns'])
        .describe('Type of analysis to perform based on user intent'),
      numberOfWeeks: z.number().min(1).max(12).default(4)
        .describe('Number of weeks to analyze. Limited to 12 weeks for performance. Defaults to 4 weeks.'),
      agentFilter: z.enum(['chatgpt', 'perplexity', 'claude', 'gemini', 'copilot']).optional()
        .describe('Filter for specific AI agent. Omit to see all agents.'),
      statusFilter: z.enum(['200', '404', '403', '503']).optional()
        .describe('Filter for HTTP status. Omit to see all statuses.'),
      siteId: z.string().uuid().optional().describe('The UUID of the site to analyze (optional if baseURL provided)'),
      baseURL: z.string().url().optional().describe('The base URL of the site to analyze (optional if siteId provided)'),
    }).strict(),
    handler: async ({
      analysisType, numberOfWeeks, agentFilter, statusFilter, siteId, baseURL,
    }) => {
      try {
        const site = await resolveSite(Site, siteId, baseURL);
        const analyticsService = new CdnAnalyticsService(context, site);
        const parameters = {
          numberOfWeeks,
          agentFilter,
          statusFilter,
        };

        const result = await analyticsService.executeAnalysis(analysisType, parameters);

        const response = {
          success: true,
          analysisType,
          parameters,
          data: result,
          siteInfo: {
            id: site.getId(),
            baseURL: site.getBaseURL(),
            customer: site.getOrganizationId(),
          },
          insights: getAnalysisInsights(analysisType, result),
        };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response, null, 2),
          }],
        };
      } catch (error) {
        context.log.error(`CDN Analytics Tool Error: ${error.message}`);
        const errorResponse = {
          success: false,
          error: error.message,
          analysisType,
        };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(errorResponse, null, 2),
          }],
        };
      }
    },
  };

  return {
    analyzeCdnTraffic: analyzeCdnTrafficTool,
  };
}

/* c8 ignore end */
