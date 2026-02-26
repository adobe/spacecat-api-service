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
 * Escapes special XML characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds the XML payload for a Post Office templated email.
 * @param {string[]} toList - Array of recipient email addresses.
 * @param {Object<string,string>} [templateData] - Key-value pairs for template variables.
 * @returns {string} XML payload string.
 */
function buildTemplateEmailPayload(toList, templateData) {
  const toListXml = toList.map((email) => `<toList>${escapeXml(email)}</toList>`).join('\n    ');

  let templateDataXml = '';
  if (templateData && Object.keys(templateData).length > 0) {
    const entries = Object.entries(templateData)
      .map(([key, value]) => `<entry><key>${escapeXml(key)}</key><value>${escapeXml(String(value))}</value></entry>`)
      .join('\n        ');
    templateDataXml = `\n    <templateData>\n        ${entries}\n    </templateData>`;
  }

  return `<sendTemplateEmailReq>
    ${toListXml}${templateDataXml}
</sendTemplateEmailReq>`;
}

/**
 * Acquires an IMS service access token using email-specific credentials.
 * Does NOT mutate context.env.
 * @param {Object} context - The request context with env and log.
 * @returns {Promise<string>} The access token string.
 */
async function getEmailServiceToken(context) {
  const { env, log } = context;

  log.info('[email-service] Acquiring email service IMS token (v3 client_credentials)', {
    emailClientId: env.EMAIL_IMS_CLIENT_ID,
    emailClientSecret: env.EMAIL_IMS_CLIENT_SECRET,
    emailClientCode: env.EMAIL_IMS_CLIENT_CODE,
    emailImsScope: env.EMAIL_IMS_SCOPE,
    imsHost: env.IMS_HOST,
    hardcodedScope: 'APO.ST(llmo).SC(email)',
  });

  const emailEnv = {
    ...env,
    IMS_CLIENT_ID: env.EMAIL_IMS_CLIENT_ID,
    IMS_CLIENT_SECRET: env.EMAIL_IMS_CLIENT_SECRET,
    IMS_CLIENT_CODE: env.EMAIL_IMS_CLIENT_CODE,
    IMS_SCOPE: 'APO.ST(llmo).SC(email)',
  };

  const imsClient = ImsClient.createFrom({ ...context, env: emailEnv });

  try {
    const tokenPayload = await imsClient.getServiceAccessTokenV3();
    log.info('[email-service] IMS v3 token acquired successfully', {
      tokenPrefix: tokenPayload.access_token?.substring(0, 10),
      expiresIn: tokenPayload.expires_in,
      tokenType: tokenPayload.token_type,
    });
    return tokenPayload.access_token;
  } catch (error) {
    log.error('[email-service] Failed to acquire IMS token', { error: error.message });
    throw error;
  }
}

/**
 * Sends a templated email via Adobe Post Office.
 *
 * @param {Object} context - The request context (must include env and log).
 * @param {Object} options
 * @param {string[]} options.recipients - Array of email addresses.
 * @param {string} options.templateName - Post Office template name.
 * @param {Object<string,string>} [options.templateData] - Template variable key/value pairs.
 * @param {string} [options.locale='en-us'] - Locale for the email.
 * @returns {Promise<{success: boolean, statusCode: number, error?: string, templateUsed: string}>}
 *   Result object. Never throws by default.
 */
export async function sendEmail(context, {
  recipients,
  templateName,
  templateData,
  locale = 'en-us',
}) {
  const { env, log } = context;
  const result = { success: false, statusCode: 0, templateUsed: templateName };

  try {
    if (!recipients || recipients.length === 0) {
      result.error = 'No recipients provided';
      return result;
    }

    const accessToken = await getEmailServiceToken(context);
    const postOfficeEndpoint = env.ADOBE_POSTOFFICE_ENDPOINT;

    if (!postOfficeEndpoint) {
      result.error = 'ADOBE_POSTOFFICE_ENDPOINT is not configured';
      return result;
    }

    const emailPayload = buildTemplateEmailPayload(recipients, templateData);
    const url = `${postOfficeEndpoint}/po-server/message?templateName=${encodeURIComponent(templateName)}&locale=${encodeURIComponent(locale)}`;

    log.info('[email-service] Sending email via Post Office', {
      url,
      templateName,
      locale,
      recipientCount: recipients.length,
      tokenPrefix: accessToken?.substring(0, 10),
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/xml',
        Authorization: `IMS ${accessToken}`,
        'Content-Type': 'application/xml',
      },
      body: emailPayload,
    });

    result.statusCode = response.status;
    result.success = response.status === 200;

    if (!result.success) {
      const responseText = await response.text().catch(() => '(unable to read response body)');
      result.error = `Post Office returned ${response.status}: ${responseText}`;
      log.error(`Email send failed for template ${templateName}: ${result.error}`);
      if (response.status === 403) {
        log.warn('[email-service] 403 Forbidden - possible scope/template mismatch', {
          templateName,
          hint: 'Verify EMAIL_IMS_CLIENT_ID/SECRET is registered for client_credentials and IMS_SCOPE (APO.ST(llmo).SC(email)) matches the template team.',
        });
      }
    }
  } catch (error) {
    result.error = error.message;
    log.error(`Email send error for template ${templateName}: ${error.message}`);
  }

  return result;
}

export { buildTemplateEmailPayload, escapeXml };
