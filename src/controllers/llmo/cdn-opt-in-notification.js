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
 * Fires an internal notification email when a customer opts into Tokowaka edge optimization,
 * so the LLMO team can proactively assist with CDN configuration and routing setup.
 *
 * Design decisions:
 * - Triggered only on the first opt-in (isNewlyOpted=true) — not on subsequent config updates.
 * - CDN type is read from llmo.cdnBucketConfig.cdnProvider (populated by llmo-config-wrapper
 *   in auth-service during provisioning).
 * - Email failures never block the opt-in response — notification is fire-and-forget.
 * - Recipients must be set via OPT_IN_NOTIFICATION_RECIPIENTS in Vault (comma-separated
 *   @adobe.com addresses). If missing, notification is skipped with an error log.
 * - BYOCDN sites use llmo_cdn_opt_in_notification template (IT/CDN team action required).
 * - Adobe-managed CDN sites use llmo_cdn_opt_in_notification_adobe_managed template
 *   (no customer action required).
 */

import { sendEmail } from '../../support/email-service.js';
import { CDN_TYPES, CDN_DISPLAY_NAMES } from './llmo-utils.js';

const OPT_IN_NOTIFICATION_TEMPLATE = 'llmo_cdn_opt_in_notification';
const OPT_IN_NOTIFICATION_TEMPLATE_ADOBE_MANAGED = 'llmo_cdn_opt_in_notification_adobe_managed';
const EXCLUDED_MEMBER_STATUSES = new Set(['BLOCKED', 'DELETED']);

const CDN_CONFIG = {
  [CDN_TYPES.BYOCDN_FASTLY]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/fastly-byocdn',
  },
  [CDN_TYPES.BYOCDN_AKAMAI]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/akamai-byocdn',
    note: 'Apply the routing rule only to agentic HTML page traffic (match html and extensionless URLs) — exclude API endpoints. If property activation fails, ensure the SSL verification mode on the Optimize at Edge rule matches your default rule.',
  },
  [CDN_TYPES.BYOCDN_CLOUDFLARE]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudflare-byocdn',
    note: 'If an existing Cloudflare Worker is already deployed on this domain, use Option 2 (manual setup) to merge the Edge Optimize routing logic into it — do not use the one-click deploy. The worker route must be linked to the domain manually regardless of setup option.',
  },
  [CDN_TYPES.BYOCDN_CLOUDFRONT]: {
    adobeManaged: false,
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudfront-byocdn',
    note: 'Requires AWS IAM permissions for Lambda, IAM roles, CloudFront distributions, and cache policies. Cache policy setup varies by scenario (legacy/custom/managed) — follow the step-by-step guide closely.',
  },
  [CDN_TYPES.BYOCDN_IMPERVA]: { adobeManaged: false },
  [CDN_TYPES.BYOCDN_OTHER]: { adobeManaged: false },
  [CDN_TYPES.AMS_CLOUDFRONT]: { adobeManaged: true },
  [CDN_TYPES.AMS_FRONTDOOR]: { adobeManaged: true },
  [CDN_TYPES.AEM_CS_FASTLY]: { adobeManaged: true },
  [CDN_TYPES.COMMERCE_FASTLY]: { adobeManaged: true },
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
  } = params || {};

  try {
    const recipients = parseRecipients(env?.OPT_IN_NOTIFICATION_RECIPIENTS);
    if (recipients.length === 0) {
      log.error('[cdn-opt-in-notification] OPT_IN_NOTIFICATION_RECIPIENTS is not configured — skipping notification');
      return { sent: false, reason: 'no-recipients' };
    }

    const cdnEntry = CDN_CONFIG[cdnType];
    const cdnDisplayName = CDN_DISPLAY_NAMES[cdnType] || cdnType || 'A CDN';
    const docLink = cdnEntry?.docLink || '';
    const cdnNote = cdnEntry?.note || '';
    const isAdobeManaged = cdnEntry?.adobeManaged === true;
    const orgMembers = await getOrgMembersCsv(context, orgId);

    const templateName = isAdobeManaged
      ? OPT_IN_NOTIFICATION_TEMPLATE_ADOBE_MANAGED
      : OPT_IN_NOTIFICATION_TEMPLATE;

    const templateData = {
      siteBaseURL: siteBaseURL || '',
      cdnDisplayName,
      docLink,
      cdnNote,
      optedBy: optedBy || '',
      orgMembers,
    };

    log.info(`[cdn-opt-in-notification] Sending ${templateName} for site=${siteId} cdnType=${cdnType}`);

    const result = await sendEmail(context, {
      recipients,
      templateName,
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
