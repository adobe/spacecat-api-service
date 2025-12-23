/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Blocks, Message } from 'slack-block-builder';
import { SPACECAT_BOT_USER_AGENT, SPACECAT_BOT_IPS } from '@adobe/spacecat-shared-utils';
import { BUTTON_LABELS } from '../../../controllers/hooks.js';

export function extractURLFromSlackMessage(inputString) {
  // Regular expression to match URLs
  const start = inputString.indexOf('https');
  const end = inputString.indexOf('|', inputString.indexOf('<'));

  return inputString.substring(start, end);
}

export function composeReply(opts) {
  const {
    blocks,
    username,
    isFnF,
    approved,
  } = opts;

  const reaction = approved
    ? `Added by @${username} \`${isFnF ? BUTTON_LABELS.APPROVE_FRIENDS_FAMILY : BUTTON_LABELS.APPROVE_CUSTOMER}\` :checked:`
    : `Ignored by @${username} :cross-x:`;

  const message = Message()
    .blocks(
      Blocks.Section()
        .blockId(blocks[0]?.block_id)
        .text(blocks[0]?.text?.text),
      Blocks.Section().text(reaction),
    )
    .buildToObject();

  return {
    ...message,
    text: blocks[0]?.text?.text,
    replace_original: true,
  };
}

/**
 * Formats bot protection details for Slack notifications
 * @param {Object} options - Options
 * @param {string} options.siteUrl - Site URL
 * @param {Object} options.botProtection - Bot protection details
 * @param {string} [options.environment='prod'] - Environment ('prod' or 'dev')
 * @returns {string} Formatted Slack message
 */
export function formatBotProtectionSlackMessage({
  siteUrl,
  botProtection,
  environment = 'prod',
}) {
  const ips = environment === 'prod'
    ? SPACECAT_BOT_IPS.production
    : SPACECAT_BOT_IPS.development;
  const ipList = ips.map((ip) => `• \`${ip}\``).join('\n');

  const envLabel = environment === 'prod' ? 'Production' : 'Development';
  const isAllowed = botProtection.type && botProtection.type.includes('-allowed');

  let message = `:${isAllowed ? 'information_source' : 'warning'}: *Bot Protection${isAllowed ? ' Infrastructure' : ''} Detected*\n\n`
    + `*Site:* ${siteUrl}\n`
    + `*Protection Type:* ${botProtection.type}\n`
    + `*Confidence:* ${(botProtection.confidence * 100).toFixed(0)}%\n`;

  if (botProtection.reason) {
    message += `*Reason:* ${botProtection.reason}\n`;
  }

  if (isAllowed) {
    // Site is currently accessible - provide informational message
    message += '\n'
      + '*Current Status:*\n'
      + '• SpaceCat can currently access the site\n'
      + '• Bot protection infrastructure is present but allowing requests\n'
      + '• This suggests AWS Lambda IPs may be allowlisted\n'
      + '\n'
      + '*Important Notes:*\n'
      + '• If audits fail or return incorrect results, verify allowlist configuration\n'
      + '• Ensure allowlist is permanent and covers all required IPs\n'
      + '• Some protection types may still affect specific audit types\n'
      + '\n'
      + '*If you need to update allowlist:*\n'
      + '\n'
      + '*User-Agent to allowlist:*\n'
      + `\`${SPACECAT_BOT_USER_AGENT}\`\n`
      + '\n'
      + `*${envLabel} IPs to allowlist:*\n`
      + `${ipList}\n`;
  } else {
    // Site is blocked - provide action required message
    message += '\n'
      + '*Onboarding stopped due to the following reasons:*\n'
      + '• SpaceCat bot cannot access the site due to bot protection\n'
      + '• Scraper would receive challenge pages instead of real content\n'
      + '• Audits and opportunities cannot be generated without site access\n'
      + '\n'
      + '*Action Required:*\n'
      + `Customer must allowlist SpaceCat in their ${botProtection.type} configuration:\n`
      + '\n'
      + '*User-Agent to allowlist:*\n'
      + `\`${SPACECAT_BOT_USER_AGENT}\`\n`
      + '\n'
      + `*${envLabel} IPs to allowlist:*\n`
      + `${ipList}\n`
      + '\n'
      + '_After allowlisting, re-run the onboard command to complete onboarding._';
  }

  return message;
}
