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

// @ts-check

import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../utils.js';

/**
 * Builds the Slack incoming-webhook message body for a failed workspace
 * provisioning attempt.
 *
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string, reason?: string }} params
 * @returns {{ text: string }}
 */
function buildMessage({
  email, workspaceId, spaceCatId, reason,
}) {
  const workspace = hasText(workspaceId) ? workspaceId : 'not available';
  const lines = [
    ':warning: *Semrush workspace provisioning failed*',
    `• Customer email: ${email}`,
    `• Workspace ID: ${workspace}`,
    `• Organization: ${spaceCatId}`,
  ];
  if (hasText(reason)) {
    lines.push(`• Reason: ${reason}`);
  }
  return { text: lines.join('\n') };
}

/**
 * Alerts the Semrush Slack workspace, via an incoming webhook, that a user
 * could not be automatically granted access to their organization's Semrush
 * workspace — i.e. this is a FAILURE-ONLY alert. It is never called on a
 * successful provisioning call (see `workspace-provisioning.js` /
 * `controllers/onboarding.js`), so a CSM only sees this channel when the
 * automated flow needs manual follow-up.
 *
 * @param {Record<string, string|undefined>} env - Runtime env (context.env).
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string, reason?: string }} payload
 * @returns {Promise<void>}
 * @throws {ErrorWithStatusCode} 500 if the webhook URL is unset; 502 on failure.
 *   Invariant: thrown error messages never contain the webhook URL or other
 *   secrets — they are safe to log. Covered by the "does not leak the webhook
 *   URL" test; keep it green if this function's error text changes.
 */
export async function notifyProvisioningFailure(env, payload) {
  const webhookUrl = env?.SLACK_ONBOARDING_WEBHOOK_URL;
  if (!hasText(webhookUrl)) {
    throw new ErrorWithStatusCode('onboarding notifications not configured', 500);
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildMessage(payload)),
    });
  } catch (e) {
    const reason = e.code || e.name || 'network error';
    throw new ErrorWithStatusCode(`onboarding notification failed: ${reason}`, 502);
  }

  if (!response.ok) {
    throw new ErrorWithStatusCode(
      `onboarding notification rejected with status ${response.status}`,
      502,
    );
  }
}
