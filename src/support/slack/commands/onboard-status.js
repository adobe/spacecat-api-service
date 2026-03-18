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

import { extractURLFromSlackInput } from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

const PHRASES = ['onboard status'];

// Lookback window: audits up to 48h old are considered for a re-check.
// Using site createdAt is preferred (see below), but this caps the fallback.
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Maps audit types to a human-readable title for Slack output.
 * Mirrors the same helper used in opportunity-status-processor.
 * @param {string} auditType
 * @returns {string}
 */
function getAuditTitle(auditType) {
  const titles = {
    cwv: 'Core Web Vitals',
    'meta-tags': 'SEO Meta Tags',
    'broken-backlinks': 'Broken Backlinks',
    'broken-internal-links': 'Broken Internal Links',
    'alt-text': 'Alt Text',
    sitemap: 'Sitemap',
  };
  if (titles[auditType]) return titles[auditType];
  return auditType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Maps audit types to their corresponding opportunity types.
 * Kept in sync with audit-opportunity-map.js in spacecat-task-processor.
 */
const AUDIT_OPPORTUNITY_MAP = {
  cwv: ['cwv'],
  'forms-opportunities': ['form-accessibility', 'forms-opportunities'],
  'meta-tags': ['meta-tags'],
  'experimentation-opportunities': ['high-organic-low-ctr'],
  'broken-backlinks': ['broken-backlinks'],
  'broken-internal-links': ['broken-internal-links'],
  sitemap: ['sitemap'],
  'alt-text': ['alt-text'],
  accessibility: ['accessibility'],
};

/**
 * Checks which audit types have completed since onboardStartTime by querying the database.
 * An audit is considered complete when a record exists with auditedAt >= onboardStartTime.
 *
 * @param {string} siteId
 * @param {string[]} auditTypes
 * @param {number} onboardStartTime - ms timestamp
 * @param {object} dataAccess
 * @param {object} log
 * @returns {Promise<{pendingAuditTypes: string[], completedAuditTypes: string[]}>}
 */
async function checkAuditCompletion(siteId, auditTypes, onboardStartTime, dataAccess, log) {
  const pendingAuditTypes = [];
  const completedAuditTypes = [];
  try {
    const { Audit } = dataAccess;
    const latestAudits = await Audit.allLatestForSite(siteId);
    const auditsByType = {};
    if (latestAudits) {
      for (const audit of latestAudits) {
        auditsByType[audit.getAuditType()] = audit;
      }
    }
    for (const auditType of auditTypes) {
      const audit = auditsByType[auditType];
      if (!audit) {
        pendingAuditTypes.push(auditType);
      } else {
        const auditedAt = new Date(audit.getAuditedAt()).getTime();
        if (onboardStartTime && auditedAt < onboardStartTime) {
          pendingAuditTypes.push(auditType);
        } else {
          completedAuditTypes.push(auditType);
        }
      }
    }
  } catch (error) {
    log.warn(`[onboard-status] Could not check audit completion for site ${siteId}: ${error.message}`);
    pendingAuditTypes.push(...auditTypes.filter((t) => !completedAuditTypes.includes(t)));
  }
  return { pendingAuditTypes, completedAuditTypes };
}

/**
 * Factory function to create the OnboardStatusCommand object.
 *
 * Re-checks audit completion and opportunity statuses for a previously onboarded site,
 * directly from the database — no Step Functions or SQS round-trip required.
 * Use this when the original onboard completion message showed incomplete statuses because
 * some audits were still in progress at the time.
 *
 * @param {Object} context - The context object.
 * @returns {OnboardStatusCommand} - The OnboardStatusCommand object.
 */
function OnboardStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'onboard-status',
    name: 'Onboard Status',
    description: 'Re-checks audit completion and opportunity statuses for a previously onboarded site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} <site-url>

Re-fetches the latest audit and opportunity statuses for a site that has already been onboarded.
Use this when the original onboard completion message showed incomplete statuses because some
audits were still in progress.

Example:
  onboard status https://www.example.com`,
  });

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;
    const { dataAccess, log } = context;
    const { Site } = dataAccess;

    if (!args || args.length === 0) {
      await say(':x: Please provide a site URL. Usage: `onboard status <site-url>`');
      return;
    }

    const rawUrl = args[0];
    const siteUrl = extractURLFromSlackInput(rawUrl) || rawUrl.trim().replace(/\/$/, '');

    if (!siteUrl) {
      await say(':x: Could not parse a valid URL. Usage: `onboard status <site-url>`');
      return;
    }

    try {
      const site = await Site.findByBaseURL(siteUrl);
      if (!site) {
        await say(`:x: No site found for \`${siteUrl}\`. Please verify the URL and try again.`);
        return;
      }

      await say(`:hourglass_flowing_sand: Re-checking audit and opportunity status for \`${siteUrl}\`...`);

      const siteId = site.getId();

      // Determine audit types: use what has actually been run for this site
      let auditTypes = [];
      try {
        const { Audit } = dataAccess;
        const latestAudits = await Audit.allLatestForSite(siteId);
        if (latestAudits && latestAudits.length > 0) {
          auditTypes = [...new Set(latestAudits.map((a) => a.getAuditType()))];
        }
      } catch (auditErr) {
        log.warn(`[onboard-status] Could not fetch audit types for site ${siteId}: ${auditErr.message}`);
      }

      // Use site creation time as the lookback anchor so audit records from the original
      // onboard session are correctly identified. Fall back to LOOKBACK_MS.
      let onboardStartTime;
      try {
        const createdAt = site.getCreatedAt();
        onboardStartTime = createdAt ? new Date(createdAt).getTime() : Date.now() - LOOKBACK_MS;
      } catch {
        onboardStartTime = Date.now() - LOOKBACK_MS;
      }

      // Build expected opportunity types from audit types
      let expectedOpportunityTypes = [];
      let hasUnknownAuditTypes = false;
      for (const auditType of auditTypes) {
        const opps = AUDIT_OPPORTUNITY_MAP[auditType];
        if (!opps || opps.length === 0) {
          hasUnknownAuditTypes = true;
        } else {
          expectedOpportunityTypes.push(...opps);
        }
      }
      expectedOpportunityTypes = [...new Set(expectedOpportunityTypes)];

      // Fetch opportunities and build status lines
      const opportunities = await site.getOpportunities();
      const opportunityStatusLines = [];
      const processedTypes = new Set();

      /* eslint-disable no-await-in-loop */
      for (const opportunity of opportunities) {
        const oppType = opportunity.getType();

        const shouldFilter = auditTypes.length > 0
          && expectedOpportunityTypes.length > 0
          && !hasUnknownAuditTypes;

        if (shouldFilter && !expectedOpportunityTypes.includes(oppType)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (processedTypes.has(oppType)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        processedTypes.add(oppType);

        const suggestions = await opportunity.getSuggestions();
        const hasSuggestions = suggestions && suggestions.length > 0;
        const statusIcon = hasSuggestions ? ':white_check_mark:' : ':information_source:';
        opportunityStatusLines.push(`${getAuditTitle(oppType)} ${statusIcon}`);
      }
      /* eslint-enable no-await-in-loop */

      // Section: Opportunity Statuses
      await say(`*Opportunity Statuses for site ${siteUrl}*`);
      if (opportunityStatusLines.length > 0) {
        await say(opportunityStatusLines.join('\n'));
      } else {
        await say('No opportunities found');
      }

      // Audit completion disclaimer
      if (auditTypes.length > 0) {
        const { pendingAuditTypes } = await checkAuditCompletion(
          siteId,
          auditTypes,
          onboardStartTime,
          dataAccess,
          log,
        );
        if (pendingAuditTypes.length > 0) {
          const pendingList = pendingAuditTypes.map(getAuditTitle).join(', ');
          await say(
            `:warning: *Heads-up:* The following audit${pendingAuditTypes.length > 1 ? 's' : ''} `
            + `may still be in progress: *${pendingList}*.\n`
            + 'The statuses above reflect data available at this moment and may be incomplete. '
            + `Run \`onboard status ${siteUrl}\` again once all audits have completed.`,
          );
        } else {
          await say(':white_check_mark: All audits have completed. The statuses above are up to date.');
        }
      }
    } catch (error) {
      log.error(`[onboard-status] Error for ${siteUrl}: ${error.message}`);
      await say(`:x: Error checking status for \`${siteUrl}\`: ${error.message}`);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default OnboardStatusCommand;
