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

import { ImsClient } from '@adobe/spacecat-shared-ims-client';

/**
 * Email service for sending emails via Adobe Post Office API.
 * Provides reusable email functionality for various use cases.
 */

/**
 * Escape special XML characters in a string.
 *
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
const escapeXml = (str) => {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * Format a number with thousands separators.
 *
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 */
const formatNumber = (num) => {
  if (num === null || num === undefined) return '0';
  return num.toLocaleString('en-US');
};

/**
 * Build XML email payload for Adobe Post Office API.
 *
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {Object} [options.templateParams] - Template parameters as key-value pairs
 * @returns {string} XML email payload
 */
export const buildEmailPayload = ({ to, templateParams = {} }) => {
  // Handle single email or array of emails
  const toList = Array.isArray(to) ? to.join(',') : to;

  // Build template data XML if provided
  // Adobe Post Office expects:
  // <templateData><data><key>...</key><value>...</value></data></templateData>
  let templateDataXml = '';
  if (Object.keys(templateParams).length > 0) {
    const dataEntries = Object.entries(templateParams)
      .map(([key, value]) => `
        <data>
            <key>${escapeXml(key)}</key>
            <value>${escapeXml(String(value))}</value>
        </data>`)
      .join('');
    templateDataXml = `
    <templateData>${dataEntries}
    </templateData>`;
  }

  return `<sendTemplateEmailReq>
    <toList>${escapeXml(toList)}</toList>${templateDataXml}
</sendTemplateEmailReq>`;
};

/**
 * Get IMS access token for email service.
 *
 * @param {Object} context - Request context
 * @returns {Promise<string>} Access token
 */
const getEmailAccessToken = async (context) => {
  const { env } = context;

  // Create a modified env for email-specific IMS credentials
  const emailEnv = {
    ...env,
    IMS_CLIENT_ID: env.EMAIL_IMS_CLIENT_ID,
    IMS_CLIENT_SECRET: env.EMAIL_IMS_CLIENT_SECRET,
    IMS_CLIENT_CODE: env.EMAIL_IMS_CLIENT_CODE,
    IMS_SCOPE: env.EMAIL_IMS_SCOPE,
  };

  // Create IMS client with email-specific credentials
  const imsClient = ImsClient.createFrom({ ...context, env: emailEnv });
  const tokenPayload = await imsClient.getServiceAccessToken();

  return tokenPayload.access_token;
};

/**
 * Send an email using Adobe Post Office API.
 *
 * @param {Object} options - Send options
 * @param {Object} options.context - Request context (contains env, log)
 * @param {string} options.templateName - Post Office template name
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {Object} [options.templateParams] - Template parameters
 * @param {string} [options.locale='en-us'] - Email locale
 * @returns {Promise<{ success: boolean, statusCode: number, error?: string }>}
 */
export const sendEmail = async ({
  context,
  templateName,
  to,
  templateParams = {},
  locale = 'en-us',
}) => {
  const { env, log } = context;
  const postOfficeEndpoint = env.ADOBE_POSTOFFICE_ENDPOINT;

  if (!postOfficeEndpoint) {
    log.error('ADOBE_POSTOFFICE_ENDPOINT not configured');
    return { success: false, statusCode: 500, error: 'Email service not configured' };
  }

  try {
    // Get IMS access token
    const accessToken = await getEmailAccessToken(context);

    // Build email payload
    const emailPayload = buildEmailPayload({ to, templateParams });

    // Debug: log the payload being sent
    log.info(`Email payload XML: ${emailPayload}`);
    log.info(`Template params: ${JSON.stringify(templateParams)}`);

    // Send email
    const url = `${postOfficeEndpoint}/po-server/message?templateName=${templateName}&locale=${locale}`;
    log.info(`Email URL: ${url}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/xml',
        Authorization: `IMS ${accessToken}`,
        'Content-Type': 'application/xml',
      },
      body: emailPayload,
    });

    if (response.status === 200) {
      log.info(`Email sent successfully to ${Array.isArray(to) ? to.join(', ') : to}`);
      return { success: true, statusCode: 200, payloadSent: emailPayload };
    }

    const errorText = await response.text().catch(() => 'Unknown error');
    log.error(`Failed to send email: ${response.status} - ${errorText}`);
    return {
      success: false,
      statusCode: response.status,
      error: `Post Office returned ${response.status}: ${errorText}`,
    };
  } catch (error) {
    log.error(`Error sending email: ${error.message}`);
    return {
      success: false,
      statusCode: 500,
      error: error.message,
    };
  }
};

/**
 * Send a trial user invitation email.
 *
 * @param {Object} options - Send options
 * @param {Object} options.context - Request context
 * @param {string} options.templateName - Post Office template name
 * @param {string} options.emailAddress - Recipient email address
 * @returns {Promise<{ success: boolean, statusCode: number, error?: string }>}
 */
export const sendTrialUserInviteEmail = async ({
  context,
  templateName,
  emailAddress,
}) => sendEmail({
  context,
  templateName,
  to: emailAddress,
});

/**
 * Send a weekly digest email with overview metrics.
 *
 * @param {Object} options - Send options
 * @param {Object} options.context - Request context
 * @param {string} options.templateName - Post Office template name
 * @param {string} options.emailAddress - Recipient email address
 * @param {string} options.customerName - Recipient's display name
 * @param {string} options.brandName - Brand name for the site
 * @param {string} options.orgName - Organization name
 * @param {string} options.dateRange - Date range for the report (e.g., "Jan 13-19, 2026")
 * @param {number} options.visibilityScore - Visibility score percentage
 * @param {string} options.visibilityDelta - Visibility change (e.g., "+5%", "-3%")
 * @param {number} options.mentionsCount - Number of brand mentions
 * @param {string} options.mentionsDelta - Mentions change
 * @param {number} options.citationsCount - Number of citations
 * @param {string} options.citationsDelta - Citations change
 * @param {string} options.overviewUrl - URL to the overview page
 * @param {string} options.settingsUrl - URL to the settings page (for unsubscribe)
 * @returns {Promise<{ success: boolean, statusCode: number, error?: string }>}
 */
export const sendWeeklyDigestEmail = async ({
  context,
  templateName,
  emailAddress,
  customerName,
  brandName,
  orgName,
  dateRange,
  visibilityScore,
  visibilityDelta,
  mentionsCount,
  mentionsDelta,
  citationsCount,
  citationsDelta,
  overviewUrl,
  settingsUrl,
}) => {
  const result = await sendEmail({
    context,
    templateName,
    to: emailAddress,
    templateParams: {
      customer_name: customerName,
      brand_name: brandName,
      org_name: orgName,
      date_range: dateRange,
      visibility_score: `${visibilityScore} %`,
      visibility_delta: visibilityDelta,
      mentions_count: formatNumber(mentionsCount),
      mentions_delta: mentionsDelta,
      citations_count: formatNumber(citationsCount),
      citations_delta: citationsDelta,
      overview_url: overviewUrl,
      settings_url: settingsUrl,
    },
  });

  // Include template name in response for debugging
  return { ...result, templateUsed: templateName };
};
