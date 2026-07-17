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
  NON_PROD_DOMAIN: 'NON_PROD_DOMAIN',
};

export const DOMAIN_ALREADY_ASSIGNED = 'already assigned to another organization';
export const DOMAIN_ALREADY_ONBOARDED_IN_ORG = 'another domain is already onboarded for this IMS org';
export const NON_PROD_DOMAIN = 'appears to be a non-production domain (contains qa, stage, dev, author, or publish subdomain, or is an hlx/AEM delivery URL).';

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
  if (waitlistReason.includes(NON_PROD_DOMAIN)) {
    return REVIEW_REASONS.NON_PROD_DOMAIN;
  }

  return null;
}

const PLG_STATUS_NOTIFICATION_CONFIG = {
  [STATUSES.ONBOARDED]: { emoji: ':white_check_mark:', label: 'Onboarded' },
  [STATUSES.WAITLISTED]: { emoji: ':warning:', label: 'Waitlisted' },
  [STATUSES.WAITING_FOR_IP_ALLOWLISTING]: { emoji: ':warning:', label: 'Waiting for IP Allowlisting' },
  [STATUSES.ERROR]: { emoji: ':red_circle:', label: 'Error' },
  [STATUSES.INACTIVE]: { emoji: ':zzz:', label: 'Inactive' },
  [STATUSES.REJECTED]: { emoji: ':x:', label: 'Rejected' },
  [STATUSES.OUTDATED]: { emoji: ':arrow_heading_down:', label: 'Outdated' },
};

/**
 * Posts a PLG onboarding status notification to the configured ESE Slack channel.
 * Fires on terminal/actionable status transitions. Fails gracefully.
 */
export async function postPlgOnboardingNotification(onboarding, context, hints = {}) {
  const { env, log } = context;
  const sendSlackMessage = context.postSlackMessage || postSlackMessage;
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
  if (organizationId && siteId) {
    const experienceUrl = env.EXPERIENCE_URL || 'https://experience.adobe.com';
    if (status === STATUSES.ONBOARDED) {
      const asoUrl = `${experienceUrl}/?organizationId=${organizationId}#/sites-optimizer/sites/${siteId}`;
      message += `\n• *ASO Link:* ${asoUrl}`;
    }
    const backofficeUrl = `${experienceUrl}/#/@aem-sites-engineering/custom-apps/24749-EssDeveloperUI/#/sites/${siteId}`;
    message += `\n• *Backoffice Link:* ${backofficeUrl}`;
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

  if ([STATUSES.REJECTED, STATUSES.OUTDATED].includes(status)) {
    const reviews = onboarding.getReviews();
    const lastReview = reviews?.length ? reviews[reviews.length - 1] : null;
    if (lastReview?.justification) {
      message += `\n• *Justification:* ${lastReview.justification}`;
    }
  }

  const error = onboarding.getError();
  if (error?.message) {
    message += `\n• *Error:* ${error.message}`;
  }

  const steps = onboarding.getSteps() || {};
  const notes = [];
  if (hints.fastOnboarded) {
    notes.push(':rocket: Fast onboarding (pre-onboarded site)');
  }
  if (steps.siteOrgReassigned) {
    notes.push(':arrows_counterclockwise: Site moved from internal org to customer org');
  }
  if (steps.authorUrlResolved) {
    notes.push(':link: Author URL auto-resolved (AEM CS)');
  }
  if (notes.length > 0) {
    message += `\n• *Notes:* ${notes.join(' · ')}`;
  }

  try {
    await sendSlackMessage(channelId, message, token);
  } catch (slackError) {
    log.error(`Failed to post PLG onboarding notification to Slack: ${slackError.message}`);
  }
}

/**
 * Persists the onboarding record and posts the Slack notification. The caller is responsible
 * for setting status, waitlistReason, steps, updatedBy, etc. before calling.
 *
 * @param {{ swallowSaveErrors?: boolean, errorLabel?: string, hints?: object }} [opts]
 *   When `swallowSaveErrors` is true, save+notify failures are logged with `errorLabel`
 *   and not rethrown — used in catch handlers where we must not lose the original error.
 *   `hints` is forwarded to postPlgOnboardingNotification (e.g. { fastOnboarded: true }).
 */
export async function persistAndNotify(onboarding, context, opts = {}) {
  const { hints = {} } = opts;
  if (opts.swallowSaveErrors) {
    try {
      await onboarding.save();
      await postPlgOnboardingNotification(onboarding, context, hints);
    } catch (saveError) {
      context.log.error(`Failed to persist ${opts.errorLabel} for onboarding ${onboarding.getId()}: ${saveError.message}`);
    }
    return;
  }
  await onboarding.save();
  await postPlgOnboardingNotification(onboarding, context, hints);
}
