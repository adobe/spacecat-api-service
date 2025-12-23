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

import { isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';
import { checkBotProtectionDuringOnboarding } from '../../utils/bot-protection-check.js';

const COMMAND_ID = 'detect-bot-blocker';
const PHRASES = ['detect bot-blocker', 'detect bot blocker', 'check bot blocker'];

function DetectBotBlockerCommand(context) {
  const baseCommand = BaseCommand({
    id: COMMAND_ID,
    name: 'Detect Bot Blocker',
    description: 'Detects bot blocker technology on a website (Cloudflare, Imperva, Akamai, Fastly, CloudFront, HTTP/2 blocks).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const { log } = context;

  const formatResult = (result) => {
    const {
      blocked, type, confidence, reason,
    } = result;
    const crawlable = !blocked;
    const confidencePercent = (typeof confidence === 'number')
      ? `${(confidence * 100).toFixed(0)}%`
      : 'Unknown';
    const crawlableEmoji = crawlable ? ':white_check_mark:' : ':no_entry:';

    let confidenceEmoji = ':question:';
    if (confidence >= 0.95) {
      confidenceEmoji = ':muscle:';
    } else if (confidence >= 0.5) {
      confidenceEmoji = ':thinking_face:';
    }

    let typeLabel = type;
    let crawlableExplanation = '';

    if (type === 'cloudflare') {
      typeLabel = 'Cloudflare';
      crawlableExplanation = ' (Blocked by bot protection)';
    } else if (type === 'imperva') {
      typeLabel = 'Imperva/Incapsula';
      crawlableExplanation = ' (Blocked by bot protection)';
    } else if (type === 'akamai') {
      typeLabel = 'Akamai';
      crawlableExplanation = ' (Blocked by bot protection)';
    } else if (type === 'fastly') {
      typeLabel = 'Fastly';
      crawlableExplanation = ' (Blocked by bot protection)';
    } else if (type === 'cloudfront') {
      typeLabel = 'AWS CloudFront';
      crawlableExplanation = ' (Blocked by bot protection)';
    } else if (type === 'cloudflare-allowed') {
      typeLabel = 'Cloudflare (Allowed)';
      crawlableExplanation = ' (Infrastructure present, allowing requests)';
    } else if (type === 'imperva-allowed') {
      typeLabel = 'Imperva (Allowed)';
      crawlableExplanation = ' (Infrastructure present, allowing requests)';
    } else if (type === 'akamai-allowed') {
      typeLabel = 'Akamai (Allowed)';
      crawlableExplanation = ' (Infrastructure present, allowing requests)';
    } else if (type === 'fastly-allowed') {
      typeLabel = 'Fastly (Allowed)';
      crawlableExplanation = ' (Infrastructure present, allowing requests)';
    } else if (type === 'cloudfront-allowed') {
      typeLabel = 'AWS CloudFront (Allowed)';
      crawlableExplanation = ' (Infrastructure present, allowing requests)';
    } else if (type === 'http2-block') {
      typeLabel = 'HTTP/2 Stream Error';
      crawlableExplanation = ' (Connection rejected)';
    } else if (type === 'http-error') {
      typeLabel = 'HTTP Error (Possible Bot Protection)';
      crawlableExplanation = ' (Access denied)';
    } else if (type === 'none') {
      typeLabel = 'No Blocker Detected';
      crawlableExplanation = ' (No protection infrastructure found)';
    } else if (type === 'unknown') {
      typeLabel = 'Unknown';
      crawlableExplanation = crawlable ? ' (No protection detected)' : ' (Unable to access)';
    }

    let message = `${crawlableEmoji} *Crawlable:* ${crawlable ? 'Yes' : 'No'}${crawlableExplanation}\n`
      + `:shield: *Blocker Type:* ${typeLabel}\n`
      + `${confidenceEmoji} *Confidence:* ${confidencePercent}`;

    // Add confidence explanation
    if (typeof confidence === 'number') {
      if (confidence >= 0.95) {
        message += ' - Very confident in detection';
      } else if (confidence >= 0.7) {
        message += ' - Moderate confidence';
      } else if (confidence > 0) {
        message += ' - Low confidence, may need manual verification';
      }
    }

    if (reason) {
      message += `\n:information_source: *Reason:* ${reason}`;
    }

    if (result.details) {
      message += '\n\n*Details:*';
      if (result.details.httpStatus) {
        message += `\n• HTTP Status: ${result.details.httpStatus}`;
      }
      if (result.details.htmlSize) {
        message += `\n• HTML Size: ${result.details.htmlSize} bytes`;
      }
    }

    return message;
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    if (!args.length) {
      await say(baseCommand.usage());
      return;
    }

    const baseURL = extractURLFromSlackInput(args[0]);
    if (!isValidUrl(baseURL)) {
      await say(':warning: Please provide a valid URL.');
      await say(baseCommand.usage());
      return;
    }

    await say(`:mag: Checking bot blocker for \`${baseURL}\`...`);

    try {
      const result = await checkBotProtectionDuringOnboarding(baseURL, log);
      const formattedResult = formatResult(result);

      await say(`:robot_face: *Bot Blocker Detection Results for* \`${baseURL}\`\n\n${formattedResult}`);
    } catch (error) {
      log.error(`detect-bot-blocker command: failed for URL ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default DetectBotBlockerCommand;
