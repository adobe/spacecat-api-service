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

import {
  getAuditsForOpportunity,
  getOpportunityTitle,
  AUDIT_OPPORTUNITY_MAP,
  computeAuditCompletion,
} from '@adobe/spacecat-shared-utils';
import { extractURLFromSlackInput, loadProfileConfig } from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

const PHRASES = ['onboard status'];

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

      // Onboard trigger timestamp — same value the task processor reads as onboardStartTime.
      // Used by computeAuditCompletion to detect audits that predate the last onboarding.
      const onboardConfig = site.getConfig()?.getOnboardConfig();
      const lastStartTime = onboardConfig?.lastStartTime;
      const lastProfile = onboardConfig?.lastProfile;

      // Load the profile used during onboarding to restrict which audit types are relevant.
      // Falls back to all map-known types if the profile cannot be resolved.
      let profileAuditTypes = null;
      if (lastProfile) {
        try {
          const profile = loadProfileConfig(lastProfile);
          if (profile?.audits && typeof profile.audits === 'object') {
            profileAuditTypes = Object.keys(profile.audits)
              .filter((t) => AUDIT_OPPORTUNITY_MAP[t]);
          }
        } catch (profileErr) {
          log.warn(`[onboard-status] Could not load profile "${lastProfile}", falling back to all known types: ${profileErr.message}`);
        }
      }
      const scopedTypes = profileAuditTypes || Object.keys(AUDIT_OPPORTUNITY_MAP);

      // Fetch latest audits — derive auditTypes (for opportunity filtering) from records,
      // restricted to the profile's audit types so pre-existing records from prior runs
      // don't bleed non-profile opportunities into the status view.
      let auditTypes = [];
      let pendingAuditTypes = [];
      try {
        const latestAudits = await LatestAudit.allBySiteId(siteId);
        if (latestAudits && latestAudits.length > 0) {
          auditTypes = [...new Set(
            latestAudits
              .map((a) => a.getAuditType())
              .filter((t) => scopedTypes.includes(t)),
          )];
        }
        const audits = latestAudits || [];
        pendingAuditTypes = computeAuditCompletion(scopedTypes, lastStartTime, audits)
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
      const processedTypes = new Set();
      const shouldFilter = auditTypes.length > 0
        && expectedOpportunityTypes.length > 0
        && !hasUnknownAuditTypes;

      const visibleOpportunities = opportunities.filter((opportunity) => {
        const oppType = opportunity.getType();
        if (shouldFilter && !expectedOpportunityTypes.includes(oppType)) return false;
        if (processedTypes.has(oppType)) return false;
        processedTypes.add(oppType);
        return true;
      });

      const opportunityStatusLines = await Promise.all(
        visibleOpportunities.map(async (opportunity) => {
          const oppType = opportunity.getType();
          const sourceAuditIsPending = getAuditsForOpportunity(oppType)
            .some((auditType) => pendingAuditTypes.includes(auditType));
          if (sourceAuditIsPending) {
            return `${getOpportunityTitle(oppType)} :hourglass_flowing_sand:`;
          }
          const suggestions = await opportunity.getSuggestions();
          const statusIcon = suggestions?.length > 0 ? ':white_check_mark:' : ':information_source:';
          return `${getOpportunityTitle(oppType)} ${statusIcon}`;
        }),
      );

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
        // Expand audit types to their opportunity types so titles are accurate.
        // Audit types like 'forms-opportunities' map to multiple distinct opp types.
        const pendingOppTypes = [
          ...new Set(relevantPendingTypes.flatMap((t) => AUDIT_OPPORTUNITY_MAP[t])),
        ];
        const pendingList = pendingOppTypes.map(getOpportunityTitle).join(', ');
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
