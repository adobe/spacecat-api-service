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
 * Acquires an IMS service access token using email-specific credentials.
 * Does NOT mutate context.env.
 * @param {Object} context - The request context with env and log.
 * @returns {Promise<string>} The access token string.
 */
async function getEmailServiceToken(context) {
  const { env } = context;

  const emailEnv = {
    ...env,
    IMS_CLIENT_ID: env.LLMO_EMAIL_IMS_CLIENT_ID,
    IMS_CLIENT_SECRET: env.LLMO_EMAIL_IMS_CLIENT_SECRET,
    IMS_CLIENT_CODE: env.LLMO_EMAIL_IMS_CLIENT_CODE,
    IMS_SCOPE: env.LLMO_EMAIL_IMS_SCOPE,
  };

  const imsClient = ImsClient.createFrom({ ...context, env: emailEnv });

  try {
    const tokenPayload = await imsClient.getServiceAccessToken();
    return tokenPayload.access_token;
  } catch (error) {
    context.log.error('[email-service] Failed to acquire IMS token', { error: error.message });
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
 * @param {string} [options.locale='en_US'] - Locale for the email.
 * @returns {Promise<{success: boolean, statusCode: number, error?: string, templateUsed: string}>}
 *   Result object. Never throws by default.
 */
export async function sendEmail(context, {
  recipients,
  templateName,
  templateData,
  locale = 'en_US',
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

    const body = JSON.stringify({
      toList: recipients.join(','),
      templateData: templateData || {},
    });
    const url = `${postOfficeEndpoint}/po-server/message?templateName=${encodeURIComponent(templateName)}&locale=${encodeURIComponent(locale)}`;

    log.info(`[email-service] Sending ${templateName} email to ${recipients.length} recipient(s)`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `IMS ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    result.statusCode = response.status;
    result.success = response.status === 200;

    if (!result.success) {
      const responseText = await response.text().catch(() => '(unable to read response body)');
      result.error = `Post Office returned ${response.status}: ${responseText}`;
      log.error(`Email send failed for template ${templateName}: ${result.error}`);
    }
  } catch (error) {
    result.error = error.message;
    log.error(`Email send error for template ${templateName}: ${error.message}`);
  }

  return result;
}
