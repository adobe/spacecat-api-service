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

const PHRASES = ['backfill-llmo'];

const AUDIT_TYPES = {
  CDN_ANALYSIS: 'cdn-analysis',
  CDN_LOGS_REPORT: 'cdn-logs-report',
};

function parseArgs(args) {
  const parsed = {};

  for (const arg of args) {
    if (arg.includes('=')) {
      const [key, value] = arg.split('=');
      parsed[key] = value;
    }
  }

  return parsed;
}

async function triggerBackfill(context, configuration, siteId, auditType, timeValue) {
  const { sqs } = context;

  switch (auditType) {
    case AUDIT_TYPES.CDN_ANALYSIS: {
      const days = timeValue;
      const now = new Date();

      for (let dayOffset = 1; dayOffset <= days; dayOffset += 1) {
        const targetDate = new Date(now);
        targetDate.setDate(now.getDate() - dayOffset);

        const message = {
          type: auditType,
          siteId,
          auditContext: {
            year: targetDate.getUTCFullYear(),
            month: targetDate.getUTCMonth() + 1,
            day: targetDate.getUTCDate(),
            hour: 23,
            processFullDay: true,
          },
        };
        // eslint-disable-next-line no-await-in-loop
        await sqs.sendMessage(configuration.getQueues().audits, message);
      }
      break;
    }

    case AUDIT_TYPES.CDN_LOGS_REPORT: {
      const weeks = timeValue;

      // Determine weekOffset values: [0] for current week, [-1, -2, -3, -4] for previous weeks
      const weekOffsets = weeks === 0 ? [0] : Array.from({ length: weeks }, (_, i) => -(i + 1));

      for (const weekOffset of weekOffsets) {
        const message = {
          type: auditType,
          siteId,
          auditContext: {
            weekOffset,
          },
        };
        // eslint-disable-next-line no-await-in-loop
        await sqs.sendMessage(configuration.getQueues().audits, message);
      }
      break;
    }
    /* c8 ignore start */
    default:
      throw new Error(`Unsupported audit type: ${auditType}`);
    /* c8 ignore end */
  }
}

function BackfillLlmoCommand(context) {
  const baseCommand = BaseCommand({
    id: 'backfill-llmo',
    name: 'Backfill LLMO',
    description: 'Backfills LLMO audits.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} baseurl={baseURL} audit={auditType} [days={days}|weeks={weeks}]`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const parsed = parseArgs(args);

      if (!parsed.baseurl || !parsed.audit) {
        await say(':warning: Required: baseurl={baseURL} audit={auditType}');
        await say('Examples:');
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_ANALYSIS} days=3\``);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} weeks=2\``);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} weeks=0\` (current week)`);
        return;
      }

      const baseURL = extractURLFromSlackInput(parsed.baseurl);
      const auditType = parsed.audit;

      if (!isValidUrl(baseURL)) {
        await say(':warning: Invalid URL provided');
        return;
      }

      let timeValue;
      let timeDesc;

      switch (auditType) {
        case AUDIT_TYPES.CDN_ANALYSIS:
          timeValue = parseInt(parsed.days, 10) || 1;
          timeDesc = `${timeValue} days`;
          break;

        case AUDIT_TYPES.CDN_LOGS_REPORT:
          timeValue = parseInt(parsed.weeks, 10);
          if (Number.isNaN(timeValue)) timeValue = 4;

          if (timeValue > 4) {
            await say(`:warning: Max 4 weeks for ${AUDIT_TYPES.CDN_LOGS_REPORT}`);
            return;
          }

          if (timeValue === 0) {
            timeDesc = 'current week only';
          } else {
            timeDesc = `${timeValue} previous weeks`;
          }
          break;

        default:
          await say(`:warning: Supported audits: ${AUDIT_TYPES.CDN_ANALYSIS}, ${AUDIT_TYPES.CDN_LOGS_REPORT}`);
          return;
      }

      await say(`:gear: Starting ${auditType} backfill for ${baseURL} (${timeDesc})...`);

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await say(`:x: Site '${baseURL}' not found`);
        return;
      }

      const configuration = await Configuration.findLatest();
      await triggerBackfill(context, configuration, site.getId(), auditType, timeValue);

      let totalMessages;
      switch (auditType) {
        case AUDIT_TYPES.CDN_ANALYSIS:
          totalMessages = timeValue;
          break;
        case AUDIT_TYPES.CDN_LOGS_REPORT:
          totalMessages = timeValue === 0 ? 1 : timeValue;
          break;
        /* c8 ignore start */
        default:
          totalMessages = 1;
          break;
        /* c8 ignore end */
      }
      await say(`:white_check_mark: ${auditType} backfill triggered! ${totalMessages} messages queued.`);
    } catch (error) {
      log.error('Error in LLMO backfill:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default BackfillLlmoCommand;
