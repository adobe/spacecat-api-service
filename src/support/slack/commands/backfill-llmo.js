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
import {
  addUtcDays,
  formatUtcDate,
  startOfUtcDay,
  startOfUtcIsoWeek,
} from './status-command-helpers.js';

const PHRASES = ['backfill-llmo'];

const AUDIT_TYPES = {
  CDN_LOGS_ANALYSIS: 'cdn-logs-analysis',
  CDN_LOGS_REPORT: 'cdn-logs-report',
  LLMO_REFERRAL_TRAFFIC: 'llmo-referral-traffic',
  LLM_ERROR_PAGES: 'llm-error-pages',
};
const CDN_LOGS_ANALYSIS_DELAY_SECONDS = 30;
const SQS_MAX_DELAY_SECONDS = 900;

// cdn-logs-report daily backfill knobs
const CDN_LOGS_REPORT_DELAY_SECONDS = 5;
const CDN_LOGS_REPORT_MAX_WEEKS = 4;
const CDN_LOGS_REPORT_DEFAULT_WEEKS = 2;
const CDN_LOGS_REPORT_MAX_DAYS = 31;

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

const pad2 = (n) => String(n).padStart(2, '0');

function isWeeklyDbRefreshMode(parsed) {
  return parsed.mode?.toLowerCase() === 'weekly-db';
}

function hasDateInput(parsed) {
  return Boolean(parsed.date || (parsed.year && parsed.month && parsed.day));
}

function parseTrafficDate(parsed) {
  const dateArg = parsed.date
    || (parsed.year && parsed.month && parsed.day
      ? `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`
      : null);

  if (!dateArg) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    throw new Error('Invalid date format. Use date=YYYY-MM-DD.');
  }

  const date = new Date(`${dateArg}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatUtcDate(date) !== dateArg) {
    throw new Error('Invalid date format. Use date=YYYY-MM-DD.');
  }

  return {
    date,
    dateStr: dateArg,
  };
}

function getIsoWeekRange(date) {
  const weekStart = startOfUtcIsoWeek(date);
  return {
    weekStartDate: weekStart,
    weekEndDate: addUtcDays(weekStart, 6),
    weekStart: formatUtcDate(weekStart),
    weekEnd: formatUtcDate(addUtcDays(weekStart, 6)),
  };
}

function isCompletedIsoWeek(weekRange, now = new Date()) {
  return weekRange.weekEndDate < startOfUtcIsoWeek(now);
}

/**
 * Enumerates the UTC traffic days to backfill for cdn-logs-report, oldest first.
 *
 * Backfilling oldest→newest means each completed week's Sunday is imported after
 * its earlier days, so the projector's automatic weekly rollup (which fires when a
 * week's closing Sunday lands) rebuilds the week from a complete set of raw rows.
 *
 * Precedence: date= (single day) > days=M (trailing days) > weeks=N (ISO weeks).
 *
 * @returns {{ days: Date[], desc: string }}
 */
function buildCdnReportTrafficDays(parsed, now = new Date()) {
  const today = startOfUtcDay(now);
  const yesterday = addUtcDays(today, -1);

  // Single explicit traffic day.
  const trafficDate = parseTrafficDate(parsed);
  if (trafficDate) {
    if (trafficDate.date > yesterday) {
      throw new Error('date must be yesterday (UTC) or earlier.');
    }
    return { days: [trafficDate.date], desc: `traffic day ${trafficDate.dateStr}` };
  }

  // Trailing N days ending yesterday.
  if (parsed.days !== undefined) {
    const n = parseInt(parsed.days, 10);
    if (Number.isNaN(n) || n < 1) {
      throw new Error('days must be a positive integer.');
    }
    if (n > CDN_LOGS_REPORT_MAX_DAYS) {
      throw new Error(`Max ${CDN_LOGS_REPORT_MAX_DAYS} days for ${AUDIT_TYPES.CDN_LOGS_REPORT}.`);
    }
    const days = Array.from({ length: n }, (_, i) => addUtcDays(yesterday, -(n - 1 - i)));
    return { days, desc: `last ${n} day${n === 1 ? '' : 's'}` };
  }

  // Last N completed ISO weeks (default). weeks=0 = current week to date.
  const thisMonday = startOfUtcIsoWeek(now);
  let weeks = parseInt(parsed.weeks, 10);
  if (Number.isNaN(weeks)) {
    weeks = CDN_LOGS_REPORT_DEFAULT_WEEKS;
  }
  if (weeks < 0 || weeks > CDN_LOGS_REPORT_MAX_WEEKS) {
    throw new Error(`weeks must be between 0 and ${CDN_LOGS_REPORT_MAX_WEEKS} for ${AUDIT_TYPES.CDN_LOGS_REPORT}.`);
  }

  if (weeks === 0) {
    // Monday of the current (in-progress) ISO week through yesterday.
    const count = Math.round((yesterday - thisMonday) / 86_400_000) + 1;
    if (count <= 0) {
      return { days: [], desc: 'current week to date (no completed days yet)' };
    }
    const days = Array.from({ length: count }, (_, i) => addUtcDays(thisMonday, i));
    return { days, desc: 'current week to date' };
  }

  const firstMonday = addUtcDays(thisMonday, -7 * weeks);
  const lastSunday = addUtcDays(thisMonday, -1);
  const days = Array.from({ length: 7 * weeks }, (_, i) => addUtcDays(firstMonday, i));
  return {
    days,
    desc: `last ${weeks} completed ISO week${weeks === 1 ? '' : 's'} (${formatUtcDate(firstMonday)}..${formatUtcDate(lastSunday)})`,
  };
}

async function refreshAgenticWeeklyRollup(context, siteId, weekRange) {
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.rpc) {
    throw new Error('PostgREST client is unavailable; cannot refresh agentic weekly rollup.');
  }

  const { data, error } = await postgrestClient.rpc('wrpc_refresh_agentic_traffic_weekly', {
    p_site_id: siteId,
    p_start_date: weekRange.weekStart,
    p_end_date: weekRange.weekEnd,
    p_updated_by: 'slack:backfill-llmo-weekly-db',
  });

  if (error) {
    throw new Error(`wrpc_refresh_agentic_traffic_weekly: ${error.message}`);
  }

  if (Array.isArray(data)) {
    return data;
  }
  return data ? [data] : [];
}

function sumRowsInserted(rows) {
  return rows.reduce((sum, row) => sum + Number(row.rows_inserted || 0), 0);
}

/**
 * Queues one date-based daily import message per traffic day. The worker exports
 * the day BEFORE auditContext.date, so we send trafficDay + 1 as the reference.
 */
async function triggerCdnLogsReportBackfill(sqs, configuration, siteId, trafficDays) {
  for (const [index, trafficDay] of trafficDays.entries()) {
    const message = {
      type: AUDIT_TYPES.CDN_LOGS_REPORT,
      siteId,
      auditContext: {
        date: formatUtcDate(addUtcDays(trafficDay, 1)),
      },
    };
    // eslint-disable-next-line no-await-in-loop
    await sqs.sendMessage(
      configuration.getQueues().audits,
      message,
      undefined,
      {
        delaySeconds: Math.min(index * CDN_LOGS_REPORT_DELAY_SECONDS, SQS_MAX_DELAY_SECONDS),
      },
    );
  }
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
          await sqs.sendMessage(
            configuration.getQueues().audits,
            message,
            undefined,
            {
              delaySeconds: Math.min(
                (dayOffset - 1) * CDN_LOGS_ANALYSIS_DELAY_SECONDS,
                SQS_MAX_DELAY_SECONDS,
              ),
            },
          );
        }
      }
      break;
    }

    case AUDIT_TYPES.CDN_LOGS_REPORT: {
      // Daily backfill: one date-based import per traffic day (oldest first).
      // (mode=weekly-db is handled synchronously before triggerBackfill is called.)
      await triggerCdnLogsReportBackfill(
        sqs,
        configuration,
        siteId,
        specificDate?.trafficDays || [],
      );
      break;
    }

    case AUDIT_TYPES.LLM_ERROR_PAGES: {
      const errorPagesWeeks = timeValue;
      const errorPagesOffsets = errorPagesWeeks === 0
        ? [0]
        : Array.from({ length: errorPagesWeeks }, (_, i) => -(i + 1));

      for (const weekOffset of errorPagesOffsets) {
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
    usageText: `${PHRASES[0]} baseurl={baseURL} audit={auditType} [days={days}|weeks={weeks}|date={YYYY-MM-DD}]`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const parsed = parseArgs(args);

      if (parsed.mode
        && parsed.audit
        && parsed.audit !== AUDIT_TYPES.CDN_LOGS_REPORT) {
        await say(`:warning: mode=${parsed.mode} is only supported for audit=${AUDIT_TYPES.CDN_LOGS_REPORT}.`);
        return;
      }

      if (parsed.mode && !isWeeklyDbRefreshMode(parsed)) {
        await say(':warning: Unsupported mode. Use mode=weekly-db for a weekly DB rollup refresh (daily DB import is the default — just pass weeks/days/date).');
        return;
      }

      if (!parsed.baseurl || (!parsed.audit && !isWeeklyDbRefreshMode(parsed))) {
        await say(':warning: Required: baseurl={baseURL|all} audit={auditType}');
        await say('Examples:');
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} days=3\` (last 3 days)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} year=2024 month=11 day=15 hour=14\` (specific hour)`);
        await say(`• \`backfill-llmo baseurl=all audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS} year=2024 month=11 day=15 hour=14\` (all enabled sites)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} weeks=2\` (last 2 completed ISO weeks → DB)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} days=10\` (last 10 days → DB)`);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.CDN_LOGS_REPORT} date=2026-04-27\` (single traffic day → DB)`);
        await say('• `backfill-llmo baseurl=https://example.com mode=weekly-db date=2026-05-03` (force weekly rollup refresh for that completed ISO week)');
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.LLM_ERROR_PAGES} weeks=2\``);
        await say(`• \`backfill-llmo baseurl=https://example.com audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} weeks=2\``);
        return;
      }

      const auditType = isWeeklyDbRefreshMode(parsed)
        ? (parsed.audit || AUDIT_TYPES.CDN_LOGS_REPORT)
        : parsed.audit;
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
          // Force weekly rollup refresh for one completed ISO week (no data import).
          if (isWeeklyDbRefreshMode(parsed)) {
            if (!hasDateInput(parsed)) {
              await say(':warning: mode=weekly-db requires date=YYYY-MM-DD within the ISO week to refresh.');
              return;
            }
            try {
              const trafficDate = parseTrafficDate(parsed);
              const weekRange = getIsoWeekRange(trafficDate.date);
              if (!isCompletedIsoWeek(weekRange)) {
                await say(`:warning: mode=weekly-db only supports completed ISO weeks. Week ${weekRange.weekStart}..${weekRange.weekEnd} is not complete yet.`);
                return;
              }
              specificDate = {
                mode: 'weekly-db',
                anchorDate: trafficDate.dateStr,
                ...weekRange,
              };
              timeValue = 1;
              timeDesc = `weekly DB refresh for ${weekRange.weekStart}..${weekRange.weekEnd} (from ${trafficDate.dateStr})`;
            } catch (e) {
              await say(`:warning: ${e.message}`);
              return;
            }
            break;
          }

          // Daily DB backfill: enumerate traffic days (date | days | weeks).
          try {
            const { days, desc } = buildCdnReportTrafficDays(parsed);
            if (days.length === 0) {
              await say(':warning: No completed traffic days to backfill for the requested range.');
              return;
            }
            specificDate = { trafficDays: days };
            timeValue = days.length;
            timeDesc = `${desc} → ${days.length} daily DB import${days.length === 1 ? '' : 's'}`;
          } catch (e) {
            await say(`:warning: ${e.message}`);
            return;
          }
          break;

        case AUDIT_TYPES.LLM_ERROR_PAGES:
          timeValue = parseInt(parsed.weeks, 10);
          if (Number.isNaN(timeValue)) {
            timeValue = 4;
          }

          if (timeValue > 4) {
            await say(`:warning: Max 4 weeks for ${AUDIT_TYPES.LLM_ERROR_PAGES}`);
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
          if (Number.isNaN(timeValue)) {
            timeValue = 1;
          }

          if (timeValue > 10) {
            await say(`:warning: Max 10 weeks for ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`);
            return;
          }

          timeDesc = `${timeValue} previous ${timeValue === 1 ? 'week' : 'weeks'}`;
          break;

        default:
          await say(`:warning: Supported audits: ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}, ${AUDIT_TYPES.CDN_LOGS_REPORT}, ${AUDIT_TYPES.LLM_ERROR_PAGES}, ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`);
          return;
      }

      if (isAllSites && specificDate?.mode === 'weekly-db') {
        await say(':warning: mode=weekly-db requires a specific baseurl. Run the weekly status check first, then refresh only the missing sites.');
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

      if (specificDate?.mode === 'weekly-db') {
        await say(`:rocket: Running ${auditType} weekly DB refresh for ${baseURL} (${specificDate.weekStart}..${specificDate.weekEnd})...`);
        const rows = await refreshAgenticWeeklyRollup(context, sites[0].getId(), specificDate);
        await say(`:white_check_mark: Done! wrpc_refresh_agentic_traffic_weekly refreshed ${specificDate.weekStart}..${specificDate.weekEnd}; rows_inserted=${sumRowsInserted(rows)}.`);
        return;
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

      const msgsPerSite = (auditType === AUDIT_TYPES.LLM_ERROR_PAGES && timeValue === 0)
        ? 1
        : timeValue;
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
