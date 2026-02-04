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

import { hasText, buildAggregationKeyFromSuggestion } from '@adobe/spacecat-shared-utils';
import { Opportunity as OpportunityModel } from '@adobe/spacecat-shared-data-access';

import BaseCommand from './base.js';
import { triggerA11yCodefixForOpportunity } from '../../utils.js';
import {
  postErrorMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['run a11y codefix', 'run accessibility codefix'];

// Valid opportunity statuses for processing
const VALID_OPPORTUNITY_STATUSES = [
  OpportunityModel.STATUSES.NEW,
  OpportunityModel.STATUSES.IN_PROGRESS,
];

// Supported accessibility opportunity types
const SUPPORTED_OPPORTUNITY_TYPES = ['a11y-assistive', 'a11y-color-contrast'];

// Valid suggestion statuses for counting
const VALID_SUGGESTION_STATUSES = ['NEW', 'APPROVED', 'IN_PROGRESS'];

/**
 * Normalizes the opportunity type input to the full type name.
 * @param {string} input - The opportunity type input (e.g., 'assistive', 'color-contrast')
 * @returns {string} The full opportunity type name (e.g., 'a11y-assistive')
 */
function normalizeOpportunityType(input) {
  if (!hasText(input)) {
    return 'a11y-assistive';
  }

  const normalized = input.toLowerCase().trim();

  // Add a11y- prefix if not present
  if (!normalized.startsWith('a11y-')) {
    return `a11y-${normalized}`;
  }

  return normalized;
}

/**
 * Searches for a site by name (case-insensitive partial match).
 * @param {Array} allSites - All sites from the database
 * @param {string} searchTerm - The search term to match against site name or base URL
 * @returns {Array} Matching sites
 */
function searchSitesByName(allSites, searchTerm) {
  const term = searchTerm.toLowerCase().trim();

  return allSites.filter((site) => {
    const siteName = (site.getName() || '').toLowerCase();
    const baseURL = (site.getBaseURL() || '').toLowerCase();

    return siteName.includes(term) || baseURL.includes(term);
  });
}

/**
 * Factory function to create the RunA11yCodefixCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunA11yCodefixCommand} The RunA11yCodefixCommand object.
 * @constructor
 */
function RunA11yCodefixCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-a11y-codefix',
    name: 'Run A11y Codefix',
    description: 'Triggers accessibility code fix flow for an existing opportunity. '
      + 'Searches for a site by name or URL, finds the latest matching opportunity, '
      + 'and sends its suggestions to Mystique for code fix processing. '
      + 'Optionally filter by aggregation_key to process only matching suggestions.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site_name_or_url} [opportunity_type: assistive|color-contrast] [aggregation_key]`,
  });

  const { dataAccess, log } = context;
  const { Site, Opportunity } = dataAccess;

  /**
   * Finds the latest valid opportunity for a site matching the given type.
   * @param {string} siteId - The site ID
   * @param {string} opportunityType - The opportunity type to find
   * @returns {Promise<Object|null>} The matching opportunity or null
   */
  const findLatestValidOpportunity = async (siteId, opportunityType) => {
    const allOpportunities = await Opportunity.allBySiteId(siteId);

    // Filter by type and valid status
    const validOpportunities = allOpportunities.filter(
      (opp) => opp.getType() === opportunityType
        && VALID_OPPORTUNITY_STATUSES.includes(opp.getStatus()),
    );

    if (validOpportunities.length === 0) {
      return null;
    }

    // Sort by updatedAt descending to get the most recent one
    validOpportunities.sort((a, b) => {
      const dateA = new Date(a.getUpdatedAt() || a.getCreatedAt());
      const dateB = new Date(b.getUpdatedAt() || b.getCreatedAt());
      return dateB - dateA;
    });

    return validOpportunities[0];
  };

  const countMatchingSuggestions = (suggestions, aggregationKey) => {
    if (!aggregationKey) {
      return suggestions.filter(
        (s) => VALID_SUGGESTION_STATUSES.includes(s.getStatus()),
      ).length;
    }

    return suggestions.filter((s) => {
      if (!VALID_SUGGESTION_STATUSES.includes(s.getStatus())) {
        return false;
      }
      const suggestionData = s.getData();
      const suggestionAggKey = buildAggregationKeyFromSuggestion(suggestionData);
      return suggestionAggKey === aggregationKey;
    }).length;
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [siteNameInput, opportunityTypeInput, aggregationKeyInput] = args;

      if (!hasText(siteNameInput)) {
        await say(baseCommand.usage());
        return;
      }

      const opportunityType = normalizeOpportunityType(opportunityTypeInput);
      const aggregationKey = hasText(aggregationKeyInput) ? aggregationKeyInput.trim() : null;

      if (!SUPPORTED_OPPORTUNITY_TYPES.includes(opportunityType)) {
        await say(`:x: Invalid opportunity type: \`${opportunityType}\`. Supported types: ${SUPPORTED_OPPORTUNITY_TYPES.join(', ')}`);
        return;
      }

      await say(`:mag: Searching for site matching: \`${siteNameInput}\`...`);

      // Fetch all sites and search by name
      const allSites = await Site.all();
      const matchingSites = searchSitesByName(allSites, siteNameInput);

      if (matchingSites.length === 0) {
        await say(`:x: No site found matching: \`${siteNameInput}\``);
        return;
      }

      if (matchingSites.length > 1) {
        const siteList = matchingSites
          .slice(0, 10) // Limit to first 10 matches
          .map((s) => `• \`${s.getBaseURL()}\` (${s.getName() || 'No name'})`)
          .join('\n');

        await say(`:warning: Multiple sites found (${matchingSites.length}). Please be more specific:\n${siteList}${matchingSites.length > 10 ? `\n_...and ${matchingSites.length - 10} more_` : ''}`);
        return;
      }

      const site = matchingSites[0];
      const siteId = site.getId();
      const baseURL = site.getBaseURL();

      await say(`:white_check_mark: Found site: \`${baseURL}\`\n:mag: Looking for \`${opportunityType}\` opportunity...`);

      // Find the latest valid opportunity
      const opportunity = await findLatestValidOpportunity(siteId, opportunityType);

      if (!opportunity) {
        await say(`:x: No valid \`${opportunityType}\` opportunity found for site \`${baseURL}\`.\nMake sure the opportunity exists with status NEW or IN_PROGRESS.`);
        return;
      }

      const opportunityId = opportunity.getId();
      const opportunityStatus = opportunity.getStatus();

      const suggestions = await opportunity.getSuggestions();
      const totalSuggestionCount = suggestions.filter(
        (s) => VALID_SUGGESTION_STATUSES.includes(s.getStatus()),
      ).length;
      const matchingSuggestionCount = countMatchingSuggestions(suggestions, aggregationKey);

      // Build the trigger message
      let triggerMessage = `:adobe-run: Triggering A11y codefix for:\n• Site: \`${baseURL}\`\n• Opportunity: \`${opportunityId}\` (${opportunityType})\n• Status: ${opportunityStatus}`;

      if (aggregationKey) {
        triggerMessage += `\n• Aggregation Key: \`${aggregationKey}\`\n• Matching Suggestions: ${matchingSuggestionCount} (of ${totalSuggestionCount} total)`;

        if (matchingSuggestionCount === 0) {
          await say(`:x: No suggestions found matching aggregation key: \`${aggregationKey}\``);
          return;
        }
      } else {
        triggerMessage += `\n• Suggestions: ${totalSuggestionCount}`;
      }

      await say(triggerMessage);

      // Trigger the codefix flow
      await triggerA11yCodefixForOpportunity(
        site,
        opportunityId,
        opportunityType,
        aggregationKey,
        slackContext,
        context,
      );

      const filterNote = aggregationKey
        ? ` Only suggestions matching aggregation key \`${aggregationKey}\` will be processed.`
        : '';
      await say(`:white_check_mark: A11y codefix request sent successfully.${filterNote} Suggestions will be processed and sent to Mystique.`);
    } catch (error) {
      log.error('Error in run-a11y-codefix command:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunA11yCodefixCommand;
