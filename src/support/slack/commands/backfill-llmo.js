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
import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const SUPPORTED_STREAMS = {
  agentic: 'cdn-logs-report',
  referral: null, // no-op for now
};

const PHRASES = ['backfill-llmo'];

async function triggerBackfill(context, configuration, siteId, streamType, weeks = 4) {
  const { log, sqs } = context;
  const auditType = SUPPORTED_STREAMS[streamType];

  /* c8 ignore next 3 */
  if (!auditType) {
    throw new Error(`Unsupported stream type: ${streamType}`);
  }

  const weekOffsets = [];
  for (let i = 1; i <= weeks; i += 1) {
    weekOffsets.push(-i);
  }

  for (const week of weekOffsets) {
    const message = {
      type: auditType,
      siteId,
      auditContext: {
        weekOffset: week,
      },
    };
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(configuration.getQueues().audits, message);
    log.info(`Successfully triggered ${streamType} backfill ${auditType} with message: ${JSON.stringify(message)}`);
  }
}

/**
 * Creates the BackfillLlmoCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {BackfillLlmoCommand} - The BackfillLlmoCommand object.
 * @constructor
 */
function BackfillLlmoCommand(context) {
  const baseCommand = BaseCommand({
    id: 'backfill-llmo',
    name: 'Backfill LLMO',
    description: 'Backfills LLMO streams for the last given number of weeks (max: 4 weeks).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} {streamType} [weeks]`,
  });

  const {
    dataAccess, log,
  } = context;
  const { Site, Configuration } = dataAccess;

  /**
   * Handles LLMO stream backfill for a single site.
   *
   * @param {string[]} args - The args provided to the command ([baseURL, streamType, weeks]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      if (args.length < 2) {
        await say(':warning: Missing required arguments. Please provide: `baseURL` and `streamType`.');
        await say(`Usage: _${baseCommand.usage().replace('Usage: _', '').replace('_', '')}_`);
        await say(`Supported stream types: ${Object.keys(SUPPORTED_STREAMS).join(', ')}`);
        return;
      }

      const [baseURLInput, streamType, weeksInput] = args;
      const weeks = weeksInput ? parseInt(weeksInput, 10) : 4;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!isValidUrl(baseURL)) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (!SUPPORTED_STREAMS[streamType]) {
        await say(`:warning: Unsupported stream type: ${streamType}. Supported types: ${Object.keys(SUPPORTED_STREAMS).join(', ')}`);
        return;
      }

      if (weeksInput && (Number.isNaN(weeks) || weeks < 1 || weeks > 4)) {
        await say(':warning: Please provide a valid number of weeks (1-4).');
        return;
      }

      await say(`:gear: Starting ${streamType} backfill for site ${baseURL} (${weeks} weeks)...`);

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`:x: Site '${baseURL}' not found.`);
        return;
      }

      const siteId = site.getId();
      log.info(`Found site ${baseURL} with ID: ${siteId}`);

      const configuration = await Configuration.findLatest();

      await triggerBackfill(context, configuration, siteId, streamType, weeks);

      const message = `:white_check_mark: *${streamType.charAt(0).toUpperCase() + streamType.slice(1)} backfill triggered successfully!*
        
:link: *Site:* ${baseURL}
:identification_card: *Site ID:* ${siteId}
:calendar: *Weeks:* ${weeks}
:ocean: *Stream:* ${streamType}

The ${streamType} backfill for the last ${weeks} week${weeks === 1 ? '' : 's'} has been triggered.`;

      await say(message);
    } catch (error) {
      log.error('Error in LLMO backfill:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default BackfillLlmoCommand;
