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
 * Builds the Slack incoming-webhook message body for an onboarding request.
 *
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string }} params
 * @returns {{ text: string }}
 */
function buildMessage({ email, workspaceId, spaceCatId }) {
  const workspace = hasText(workspaceId) ? workspaceId : 'not available';
  return {
    text: [
      ':wave: *New Semrush onboarding request*',
      `• Customer email: ${email}`,
      `• Workspace ID: ${workspace}`,
      `• Organization: ${spaceCatId}`,
    ].join('\n'),
  };
}

/**
 * Sends an onboarding notification to the Semrush Slack workspace via an
 * incoming webhook. This is the seam where a future Styx-authenticated Semrush
 * (SR) API call will be added.
 *
 * @param {Record<string, string|undefined>} env - Runtime env (context.env).
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string }} payload
 * @returns {Promise<void>}
 * @throws {ErrorWithStatusCode} 500 if the webhook URL is unset; 502 on failure.
 */
export async function notifyOnboarding(env, payload) {
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
