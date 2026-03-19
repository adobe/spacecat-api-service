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
 * Returns the audit types that can generate the given opportunity type.
 * @param {string} oppType
 * @returns {string[]}
 */
function getAuditTypesForOpportunity(oppType) {
  return Object.entries(AUDIT_OPPORTUNITY_MAP)
    .filter(([, opps]) => opps.includes(oppType))
    .map(([auditType]) => auditType);
}

/**
 * Computes which audit types are pending vs completed from already-fetched audit records.
 * Uses per-audit lastAuditRunTime stored in site config handlers to determine if the
 * most recent DB record post-dates the last trigger. If lastAuditRunTime is absent for
 * an audit type (e.g. site onboarded before this feature), any existing record is treated
 * as completed — only a missing record counts as pending.
 * Pure function — no DB calls.
 *
 * @param {string[]} auditTypes
 * @param {Object} handlers - site config handlers keyed by audit type
 * @param {Array} latestAudits - records from LatestAudit.allBySiteId
 * @returns {{pendingAuditTypes: string[], completedAuditTypes: string[]}}
 */
export function computeAuditCompletion(auditTypes, handlers, latestAudits) {
  const pendingAuditTypes = [];
  const completedAuditTypes = [];
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
      const lastAuditRunTime = handlers?.[auditType]?.lastAuditRunTime;
      if (lastAuditRunTime) {
        const auditedAt = new Date(audit.getAuditedAt()).getTime();
        if (auditedAt < lastAuditRunTime) {
          pendingAuditTypes.push(auditType);
        } else {
          completedAuditTypes.push(auditType);
        }
      } else {
        // No trigger time recorded — treat existing record as completed.
        completedAuditTypes.push(auditType);
      }
    }
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
    const { Site, LatestAudit } = dataAccess;

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

      // Per-audit trigger timestamps stored by onboard site in site config handlers.
      // Used by computeAuditCompletion to detect audits that haven't completed yet.
      const handlers = site.getConfig()?.getHandlers() || {};

      // Fetch latest audits — derive auditTypes (for opportunity filtering) from records.
      // For the pending check, always compare against ALL map-known audit types so that
      // audits not yet started (no DB record) are correctly identified as pending.
      let auditTypes = [];
      let pendingAuditTypes = [];
      try {
        const latestAudits = await LatestAudit.allBySiteId(siteId);
        if (latestAudits && latestAudits.length > 0) {
          auditTypes = [...new Set(latestAudits.map((a) => a.getAuditType()))];
        }
        const knownTypes = Object.keys(AUDIT_OPPORTUNITY_MAP);
        const audits = latestAudits || [];
        pendingAuditTypes = computeAuditCompletion(knownTypes, handlers, audits)
          .pendingAuditTypes;
      } catch (auditErr) {
        log.warn(`[onboard-status] Could not fetch audit types for site ${siteId}: ${auditErr.message}`);
      }

      // Build expected opportunity types from known audit types
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

      // Fetch opportunities and build status lines.
      // Opportunities whose source audit is still pending show ⏳ instead of stale ✅/ℹ️.
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

        const sourceAuditIsPending = getAuditTypesForOpportunity(oppType)
          .some((auditType) => pendingAuditTypes.includes(auditType));

        if (sourceAuditIsPending) {
          opportunityStatusLines.push(`${getAuditTitle(oppType)} :hourglass_flowing_sand:`);
        } else {
          const suggestions = await opportunity.getSuggestions();
          const hasSuggestions = suggestions && suggestions.length > 0;
          const statusIcon = hasSuggestions ? ':white_check_mark:' : ':information_source:';
          opportunityStatusLines.push(`${getAuditTitle(oppType)} ${statusIcon}`);
        }
      }
      /* eslint-enable no-await-in-loop */

      // Section: Opportunity Statuses
      await say(`*Opportunity Statuses for site ${siteUrl}*`);
      if (opportunityStatusLines.length > 0) {
        await say(opportunityStatusLines.join('\n'));
      } else {
        await say('No opportunities found');
      }

      // Disclaimer: list pending audits, or confirm all complete.
      // pendingAuditTypes is always computed against all map-known types, so this runs
      // unconditionally — audits not yet started (no DB record) correctly appear as pending.
      // Only list types with known opportunity mappings; infrastructure audits are excluded.
      const relevantPendingTypes = pendingAuditTypes.filter(
        (t) => AUDIT_OPPORTUNITY_MAP[t]?.length > 0,
      );
      if (relevantPendingTypes.length > 0) {
        const pendingList = relevantPendingTypes.map(getAuditTitle).join(', ');
        await say(
          `:warning: *Heads-up:* The following audit${relevantPendingTypes.length > 1 ? 's' : ''} `
          + `may still be in progress: *${pendingList}*.\n`
          + 'The statuses above reflect data available at this moment and may be incomplete. '
          + `Run \`onboard status ${siteUrl}\` again once all audits have completed.`,
        );
      } else {
        await say(':white_check_mark: All audits have completed. The statuses above are up to date.');
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
