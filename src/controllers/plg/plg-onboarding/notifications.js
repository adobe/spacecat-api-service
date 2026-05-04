/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { postSlackMessage } from '../../../utils/slack/base.js';
import { STATUSES } from './constants.js';

export const REVIEW_REASONS = {
  DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
  AEM_SITE_CHECK: 'AEM_SITE_CHECK',
  DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
};

export const DOMAIN_ALREADY_ASSIGNED = 'already assigned to another organization';
export const DOMAIN_ALREADY_ONBOARDED_IN_ORG = 'another domain is already onboarded for this IMS org';

/**
 * Derives the review check key from the onboarding record's current state.
 * @param {object} onboarding - The PlgOnboarding record.
 * @returns {string|null} The check key enum value, or null if unknown.
 */
export function deriveCheckKey(onboarding) {
  /* c8 ignore next */
  const waitlistReason = onboarding.getWaitlistReason() || '';
  if (waitlistReason.includes(DOMAIN_ALREADY_ONBOARDED_IN_ORG)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ONBOARDED_IN_ORG;
  }
  if (waitlistReason.includes('is not an AEM site')) {
    return REVIEW_REASONS.AEM_SITE_CHECK;
  }
  if (waitlistReason.includes(DOMAIN_ALREADY_ASSIGNED)) {
    return REVIEW_REASONS.DOMAIN_ALREADY_ASSIGNED;
  }

  return null;
}

const PLG_STATUS_NOTIFICATION_CONFIG = {
  [STATUSES.ONBOARDED]: { emoji: ':white_check_mark:', label: 'Onboarded' },
  [STATUSES.WAITLISTED]: { emoji: ':warning:', label: 'Waitlisted' },
  [STATUSES.WAITING_FOR_IP_ALLOWLISTING]: { emoji: ':warning:', label: 'Waiting for IP Allowlisting' },
  [STATUSES.ERROR]: { emoji: ':red_circle:', label: 'Error' },
  [STATUSES.INACTIVE]: { emoji: ':zzz:', label: 'Inactive' },
};

/**
 * Posts a PLG onboarding status notification to the configured ESE Slack channel.
 * Fires on terminal/actionable status transitions. Fails gracefully.
 */
export async function postPlgOnboardingNotification(onboarding, context) {
  const { env, log } = context;
  const channelId = env.SLACK_PLG_ONBOARDING_CHANNEL_ID;
  const token = env.SLACK_BOT_TOKEN;

  if (!channelId || !token) {
    return;
  }

  const status = onboarding.getStatus();
  const config = PLG_STATUS_NOTIFICATION_CONFIG[status];
  /* c8 ignore next 3 */
  if (!config) {
    return;
  }

  const domain = onboarding.getDomain();
  const imsOrgId = onboarding.getImsOrgId();
  const siteId = onboarding.getSiteId();
  const organizationId = onboarding.getOrganizationId();

  let orgName = null;
  if (organizationId) {
    try {
      const org = await context.dataAccess.Organization.findById(organizationId);
      orgName = org?.getName?.() || null;
    } catch (orgLookupError) {
      log.warn(`Failed to look up org name for onboarding notification: ${orgLookupError.message}`);
    }
  }

  let message = `${config.emoji} *PLG Onboarding — ${config.label}*\n\n`
    + `• *Domain:* \`${domain}\`\n`
    + `• *Onboarding requested on IMS Org:* \`${imsOrgId}\``;

  if (orgName) {
    message += `\n• *IMS Org Name:* ${orgName}`;
  }
  if (organizationId) {
    message += `\n• *SpaceCat Org ID (derived from IMS Org):* \`${organizationId}\``;
  }
  if (siteId) {
    message += `\n• *Site ID:* \`${siteId}\``;
  }

  if ([STATUSES.WAITLISTED, STATUSES.WAITING_FOR_IP_ALLOWLISTING].includes(status)) {
    const waitlistReason = onboarding.getWaitlistReason();
    if (waitlistReason) {
      message += `\n• *Reason:* ${waitlistReason}`;
    }

    const botBlocker = onboarding.getBotBlocker();
    if (botBlocker?.type) {
      message += `\n• *Bot Blocker:* ${botBlocker.type}`;
      if (botBlocker.ipsToAllowlist?.length) {
        message += ` (IPs to allowlist: ${botBlocker.ipsToAllowlist.join(', ')})`;
      }
    }
  }

  const error = onboarding.getError();
  if (error?.message) {
    message += `\n• *Error:* ${error.message}`;
  }

  try {
    await postSlackMessage(channelId, message, token);
  } catch (slackError) {
    log.error(`Failed to post PLG onboarding notification to Slack: ${slackError.message}`);
  }
}

/**
 * Persists the onboarding record (with optional updatedBy stamp) and posts the Slack
 * notification. The caller is responsible for setting status, waitlistReason, steps, etc.
 * before calling.
 *
 * @param {{ swallowSaveErrors?: boolean, errorLabel?: string }} [opts]
 *   When `swallowSaveErrors` is true, save+notify failures are logged with `errorLabel`
 *   and not rethrown — used in catch handlers where we must not lose the original error.
 */
export async function persistAndNotify(onboarding, { updatedBy }, context, opts = {}) {
  if (updatedBy) {
    onboarding.setUpdatedBy(updatedBy);
  }
  if (opts.swallowSaveErrors) {
    try {
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context);
    } catch (saveError) {
      context.log.error(`Failed to persist ${opts.errorLabel} for onboarding ${onboarding.getId()}: ${saveError.message}`);
    }
    return;
  }
  await onboarding.save();
  await postPlgOnboardingNotification(onboarding, context);
}
