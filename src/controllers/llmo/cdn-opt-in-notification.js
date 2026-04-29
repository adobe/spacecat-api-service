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

/**
 * Fires an opt-in notification email when a customer enables Tokowaka edge optimization.
 *
 * Design decisions:
 * - Triggered only on the first opt-in (isNewlyOpted=true) — not on subsequent config updates.
 * - CDN type is read from llmo.cdnBucketConfig.cdnProvider (populated by llmo-config-wrapper
 *   in auth-service during provisioning).
 * - Email failures never block the opt-in response — notification is fire-and-forget.
 * - Recipients must be set via OPT_IN_NOTIFICATION_RECIPIENTS in Vault (comma-separated
 *   @adobe.com addresses). If missing, notification is skipped with an error log.
 * - BYOCDN sites: customer-facing onboarding email (header shows To/cc with customer + org).
 * - Adobe-managed sites: internal coordination email (header instructs LLMO team to reply-all
 *   and loop in CSE / Commerce team).
 */

import { sendEmail } from '../../support/email-service.js';
import { CDN_TYPES, CDN_DISPLAY_NAMES } from './llmo-utils.js';

const OPT_IN_NOTIFICATION_TEMPLATE = 'llmo_cdn_opt_in_notification';
const EXCLUDED_MEMBER_STATUSES = new Set(['BLOCKED', 'DELETED']);

const CSE_LOOKUP_TEAM = 'Customer CSE (run `/ams-whois &lt;customer-name&gt;` in Slack to find them)';

const CDN_CONFIG = {
  [CDN_TYPES.BYOCDN_FASTLY]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/fastly-byocdn',
  },
  [CDN_TYPES.BYOCDN_AKAMAI]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/akamai-byocdn',
  },
  [CDN_TYPES.BYOCDN_CLOUDFLARE]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudflare-byocdn',
  },
  [CDN_TYPES.BYOCDN_CLOUDFRONT]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudfront-byocdn',
  },
  [CDN_TYPES.BYOCDN_IMPERVA]: { adobeManaged: false },
  [CDN_TYPES.BYOCDN_OTHER]: { adobeManaged: false },
  [CDN_TYPES.AMS_CLOUDFRONT]: { adobeManaged: true, replyAllTeam: CSE_LOOKUP_TEAM },
  [CDN_TYPES.AMS_FRONTDOOR]: { adobeManaged: true, replyAllTeam: CSE_LOOKUP_TEAM },
  [CDN_TYPES.AEM_CS_FASTLY]: { adobeManaged: true, replyAllTeam: CSE_LOOKUP_TEAM },
  [CDN_TYPES.COMMERCE_FASTLY]: { adobeManaged: true, replyAllTeam: 'Adobe Commerce team' },
};

function parseRecipients(raw) {
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  return raw.split(',').map((s) => s.trim()).filter((e) => /^[^@]+@adobe\.com$/.test(e));
}

function formatOrgMembersCsv(trialUsers) {
  if (!Array.isArray(trialUsers) || trialUsers.length === 0) {
    return '';
  }

  const uniqueEmails = new Set();
  trialUsers.forEach((user) => {
    const status = (user?.getStatus?.() || user?.status || '').toUpperCase();
    if (EXCLUDED_MEMBER_STATUSES.has(status)) {
      return;
    }

    const rawEmail = user?.getEmailId?.() || user?.emailId || '';
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (email) {
      uniqueEmails.add(email);
    }
  });

  return [...uniqueEmails].sort().join(', ');
}

async function getOrgMembersCsv(context, orgId) {
  if (!orgId) {
    return '';
  }

  const trialUserModel = context?.dataAccess?.TrialUser;
  if (!trialUserModel?.allByOrganizationId) {
    return '';
  }

  try {
    const trialUsers = await trialUserModel.allByOrganizationId(orgId);
    return formatOrgMembersCsv(trialUsers);
  } catch (error) {
    context?.log?.warn?.(
      `[cdn-opt-in-notification] Failed to fetch org members for org=${orgId}: ${error.message}`,
    );
    return '';
  }
}

/**
 * @param {Object} context - Request context with env, log, dataAccess.
 * @param {Object} params
 * @param {string} params.siteId
 * @param {string} params.siteBaseURL
 * @param {string} [params.cdnType] - CDN type stored during provisioning.
 * @param {string} [params.orgId] - Organization ID used to load members email list.
 * @param {string} [params.optedBy] - Email of the customer user who triggered the opt-in.
 * @param {boolean} [params.botBlocked] - Whether the site is currently blocking bot traffic.
 * @param {string} [params.botBlockerType] - Detected blocker type (e.g. cloudflare, akamai).
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function notifyOptInIfNeeded(context, params) {
  const { log, env } = context;
  const {
    siteId,
    siteBaseURL,
    cdnType,
    orgId,
    optedBy,
    botBlocked = false,
    botBlockerType = '',
  } = params || {};

  try {
    const recipients = parseRecipients(env?.OPT_IN_NOTIFICATION_RECIPIENTS);
    if (recipients.length === 0) {
      log.error('[cdn-opt-in-notification] OPT_IN_NOTIFICATION_RECIPIENTS is not configured — skipping notification');
      return { sent: false, reason: 'no-recipients' };
    }

    const cdnEntry = CDN_CONFIG[cdnType];
    const cdnDisplayName = CDN_DISPLAY_NAMES[cdnType] || '';
    const cdnKnown = Boolean(cdnDisplayName);
    const docLink = cdnEntry?.docLink || '';
    const adobeManaged = cdnEntry?.adobeManaged === true;
    const replyAllTeam = cdnEntry?.replyAllTeam || '';
    const orgMembers = await getOrgMembersCsv(context, orgId);

    if (!cdnKnown) {
      log.warn(`[cdn-opt-in-notification] Unknown CDN type for site=${siteId} — sending notification without CDN-specific guidance (cdnType="${cdnType ?? ''}")`);
    }

    const templateData = {
      siteBaseURL: siteBaseURL || '',
      cdnDisplayName,
      cdnKnown,
      docLink,
      optedBy: optedBy || '',
      orgMembers,
      adobeManaged,
      replyAllTeam,
      botBlocked: botBlocked === true,
      botBlockerType: botBlockerType || '',
    };

    log.info(`[cdn-opt-in-notification] Sending ${OPT_IN_NOTIFICATION_TEMPLATE} for site=${siteId} cdnType=${cdnType} cdnKnown=${cdnKnown}`);

    const result = await sendEmail(context, {
      recipients,
      templateName: OPT_IN_NOTIFICATION_TEMPLATE,
      templateData,
    });

    if (!result.success) {
      log.warn(`[cdn-opt-in-notification] Email not delivered: ${result.error || `status ${result.statusCode}`}`);
    }

    return { sent: result.success === true, result };
  } catch (error) {
    log.error(`[cdn-opt-in-notification] Unexpected error: ${error.message}`);
    return { sent: false, reason: 'error', error: error.message };
  }
}
