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

import { isValidUrl } from '@adobe/spacecat-shared-utils';
import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const AGENTIC_TRAFFIC_REPORT_AUDIT = 'cdn-logs-report';

const PHRASES = ['run agentic-traffic-backfill'];

async function triggerAgenticTrafficBackfill(context, configuration, siteId, weeks = 4) {
  const { log, sqs } = context;

  const weekOffsets = [];
  for (let i = 1; i <= weeks; i += 1) {
    weekOffsets.push(-i);
  }

  for (const week of weekOffsets) {
    const message = {
      type: AGENTIC_TRAFFIC_REPORT_AUDIT,
      siteId,
      auditContext: {
        weekOffset: week,
      },
    };
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(configuration.getQueues().audits, message);
    log.info(`Successfully triggered audit ${AGENTIC_TRAFFIC_REPORT_AUDIT} with message: ${JSON.stringify(message)}`);
  }
}

/**
 * Factory function to create the RunAgenticTrafficBackfillCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunAgenticTrafficBackfillCommand} - The RunAgenticTrafficBackfillCommand object.
 * @constructor
 */
function RunAgenticTrafficBackfillCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-agentic-traffic-backfill',
    name: 'Run Agentic Traffic Backfill',
    description: 'Backfills agentic traffic for the last given number of weeks (max: 4 weeks).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} [weeks]`,
  });

  const {
    dataAccess, log,
  } = context;
  const { Site, Configuration } = dataAccess;

  /**
   * Handles agentic traffic backfill for a single site.
   *
   * @param {string[]} args - The args provided to the command ([baseURL, weeks]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      if (args.length < 1) {
        await say(':warning: Missing required arguments. Please provide: `baseURL`.');
        await say(`Usage: _${baseCommand.usage().replace('Usage: _', '').replace('_', '')}_`);
        return;
      }

      const [baseURLInput, weeksInput] = args;
      const weeks = weeksInput ? parseInt(weeksInput, 10) : 4;

      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!isValidUrl(baseURL)) {
        await say(':warning: Please provide a valid site base URL.');
        return;
      }

      if (weeksInput && (Number.isNaN(weeks) || weeks < 1 || weeks > 4)) {
        await say(':warning: Please provide a valid number of weeks (1-4).');
        return;
      }

      await say(`:gear: Starting agentic traffic backfill for site ${baseURL} (${weeks} weeks)...`);

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`:x: Site '${baseURL}' not found.`);
        return;
      }

      const siteId = site.getId();
      log.info(`Found site ${baseURL} with ID: ${siteId}`);

      const configuration = await Configuration.findLatest();

      await triggerAgenticTrafficBackfill(context, configuration, siteId, weeks);

      const message = `:white_check_mark: *Agentic traffic backfill completed successfully!*
        
:link: *Site:* ${baseURL}
:identification_card: *Site ID:* ${siteId}
:calendar: *Weeks:* ${weeks}

The agentic traffic backfill for the last ${weeks} week${weeks === 1 ? '' : 's'} has been triggered.`;

      await say(message);
    } catch (error) {
      log.error('Error in agentic traffic backfill:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default RunAgenticTrafficBackfillCommand;
