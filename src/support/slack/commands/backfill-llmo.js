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

import { isValidUrl, getLastNumberOfWeeks } from '@adobe/spacecat-shared-utils';
import {
  extractURLFromSlackInput,
  postErrorMessage,
} from '../../../utils/slack/base.js';

import BaseCommand from './base.js';

const PHRASES = ['backfill-llmo'];

const AUDIT_TYPES = {
  CDN_LOGS_ANALYSIS: 'cdn-logs-analysis',
  CDN_LOGS_REPORT: 'cdn-logs-report',
  LLMO_REFERRAL_TRAFFIC: 'llmo-referral-traffic',
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

async function triggerBackfill(
  context,
  configuration,
  siteId,
  auditType,
  timeValue,
  specificDate,
) {
  const { sqs } = context;

  switch (auditType) {
    case AUDIT_TYPES.CDN_LOGS_ANALYSIS: {
      // If specific date/hour provided, run for that hour only
      if (specificDate) {
        const message = {
          type: auditType,
          siteId,
          auditContext: {
            year: specificDate.year,
            month: specificDate.month,
            day: specificDate.day,
            hour: specificDate.hour,
          },
        };
        await sqs.sendMessage(configuration.getQueues().audits, message);
      } else {
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

    case AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC: {
      const weeks = timeValue;
      const weekYearPairs = getLastNumberOfWeeks(weeks);

      for (const { week, year } of weekYearPairs) {
        const message = {
          type: auditType,
          siteId,
          auditContext: {
            week,
            year,
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
        await say(':warning: Required: baseurl={baseURL|all} audit={auditType}');
        await say('Examples:');
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} days=3\` (last 3 days)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} year=2024 month=11 day=15 hour=14\` (specific hour)`);
        await say(`• \`backfill-llmo baseurl=all audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} year=2024 month=11 day=15 hour=14\` (all enabled sites)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} weeks=2\``);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} weeks=0\` (current week)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} weeks=2\``);
        return;
      }

      const auditType = parsed.audit;
      const isAllSites = parsed.baseurl?.toLowerCase() === 'all';
      const baseURL = isAllSites ? 'all' : extractURLFromSlackInput(parsed.baseurl);

      if (!isAllSites && !isValidUrl(baseURL)) {
        await say(':warning: Invalid URL provided');
        return;
      }

      let timeValue;
      let timeDesc;
      let specificDate = null;

      switch (auditType) {
        case AUDIT_TYPES.CDN_LOGS_ANALYSIS:
          // Check if specific date is provided
          if (parsed.year && parsed.month && parsed.day && parsed.hour) {
            specificDate = {
              year: parseInt(parsed.year, 10),
              month: parseInt(parsed.month, 10),
              day: parseInt(parsed.day, 10),
              hour: parseInt(parsed.hour, 10),
            };
            timeValue = 1;
            timeDesc = `${parsed.year}-${parsed.month}-${parsed.day} hour ${parsed.hour}`;
          } else {
            timeValue = parseInt(parsed.days, 10) || 1;

            if (timeValue > 14) {
              await say(`:warning: Max 14 days for ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`);
              return;
            }

            timeDesc = `${timeValue} days`;
          }
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

        case AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC:
          timeValue = parseInt(parsed.weeks, 10);
          if (Number.isNaN(timeValue)) timeValue = 1;

          if (timeValue > 10) {
            await say(`:warning: Max 10 weeks for ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`);
            return;
          }

          timeDesc = `${timeValue} previous ${timeValue === 1 ? 'week' : 'weeks'}`;
          break;

        default:
          await say(`:warning: Supported audits: ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}, ${AUDIT_TYPES.CDN_LOGS_REPORT}, ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`);
          return;
      }

      // Get sites to process
      let sites;
      if (isAllSites) {
        await say(`:gear: Finding sites enabled for ${auditType}...`);
        const allSites = await Site.all();
        const configuration = await Configuration.findLatest();
        sites = allSites.filter((s) => configuration.isHandlerEnabledForSite(auditType, s));
        if (sites.length === 0) {
          await say(`:x: No sites enabled for ${auditType}`);
          return;
        }
      } else {
        const site = await Site.findByBaseURL(baseURL);
        if (!site) {
          await say(`:x: Site '${baseURL}' not found`);
          return;
        }
        sites = [site];
      }

      const target = isAllSites ? `${sites.length} sites` : baseURL;
      await say(`:rocket: Triggering ${auditType} for ${target} (${timeDesc})...`);

      const configuration = await Configuration.findLatest();
      for (const s of sites) {
        // eslint-disable-next-line no-await-in-loop
        await triggerBackfill(
          context,
          configuration,
          s.getId(),
          auditType,
          timeValue,
          specificDate,
        );
      }

      const msgsPerSite = auditType === AUDIT_TYPES.CDN_LOGS_REPORT
        && timeValue === 0 ? 1 : timeValue;
      await say(`:white_check_mark: Done! ${sites.length * msgsPerSite} messages queued.`);
    } catch (error) {
      log.error('Error in LLMO backfill:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default BackfillLlmoCommand;
