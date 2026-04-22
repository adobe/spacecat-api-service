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
 * - CDN type (cdnLogSource) is stored in edgeOptimizeConfig by provision.js so it is available
 *   here without an extra service call.
 * - Email failures never block the opt-in response — notification is fire-and-forget.
 * - Recipients must be set via OPT_IN_NOTIFICATION_RECIPIENTS in Vault (comma-separated
 *   @adobe.com addresses). If missing, notification is skipped with an error log.
 */

import { sendEmail } from '../../support/email-service.js';

const OPT_IN_NOTIFICATION_TEMPLATE = 'llmo_cdn_opt_in_notification';
const EXCLUDED_MEMBER_STATUSES = new Set(['BLOCKED', 'DELETED']);

const CDN_CONFIG = {
  'byocdn-fastly': {
    displayName: 'Fastly (BYOCDN)',
  },
  'byocdn-akamai': {
    displayName: 'Akamai (BYOCDN)',
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/akamai-byocdn',
    note: 'WAF or Bot Manager blocking the AdobeEdgeOptimize/1.0 user agent is the most common onboarding issue — check WAF connectivity if the customer reports problems.',
  },
  'byocdn-cloudflare': {
    displayName: 'Cloudflare (BYOCDN)',
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudflare-byocdn',
    note: 'Ensure the AdobeEdgeOptimize/1.0 user agent is allowlisted in any WAF or Bot Manager rules.',
  },
  'byocdn-cloudfront': {
    displayName: 'CloudFront (BYOCDN)',
    docLink: 'https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/cloudfront-byocdn',
    note: 'This involves Lambda@Edge and cache policy setup — follow the step-by-step guide closely.',
  },
  'byocdn-imperva': {
    displayName: 'Imperva (BYOCDN)',
  },
  'byocdn-other': {
    displayName: 'Custom BYOCDN',
  },
  'ams-cloudfront': {
    displayName: 'AMS CloudFront',
  },
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
 * @param {string} [params.cdnLogSource] - CDN type stored during provisioning.
 * @param {string} [params.orgId] - Organization ID used to load members email list.
 * @param {string} [params.optedBy] - Email of the customer user who triggered the opt-in.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function notifyOptInIfNeeded(context, params) {
  const { log, env } = context;
  const {
    siteId,
    siteBaseURL,
    cdnLogSource,
    orgId,
    optedBy,
  } = params || {};

  try {
    const recipients = parseRecipients(env?.OPT_IN_NOTIFICATION_RECIPIENTS);
    if (recipients.length === 0) {
      log.error('[cdn-opt-in-notification] OPT_IN_NOTIFICATION_RECIPIENTS is not configured — skipping notification');
      return { sent: false, reason: 'no-recipients' };
    }

    const cdnDisplayName = CDN_CONFIG[cdnLogSource]?.displayName || cdnLogSource || 'Unknown CDN';
    const docLink = CDN_CONFIG[cdnLogSource]?.docLink || '';
    const cdnNote = CDN_CONFIG[cdnLogSource]?.note || '';
    const orgMembers = await getOrgMembersCsv(context, orgId);

    const templateData = {
      siteBaseURL: siteBaseURL || '',
      cdnDisplayName,
      docLink,
      cdnNote,
      optedBy: optedBy || '',
      orgMembers,
    };

    log.info(`[cdn-opt-in-notification] Sending ${OPT_IN_NOTIFICATION_TEMPLATE} for site=${siteId} cdnLogSource=${cdnLogSource}`);

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
