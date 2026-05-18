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

import BaseCommand from './base.js';
import {
  addUtcDays,
  appendStatusDetails,
  formatUtcDate,
  isFutureUtcDate,
  parseStatusCommandArgs,
  parseUtcDateArg,
  postReport,
  resolveSiteScope,
  startOfUtcIsoWeek,
} from './status-command-helpers.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check agentic traffic db status'];
const CDN_LOGS_REPORT_AUDIT = 'cdn-logs-report';
const SITE_CONCURRENCY = 10;
const AGENTIC_TRAFFIC_TABLES = [
  { key: 'raw', table: 'agentic_traffic', dateColumn: 'traffic_date' },
  { key: 'daily', table: 'agentic_traffic_daily', dateColumn: 'traffic_date' },
  { key: 'weekly', table: 'agentic_traffic_weekly', dateColumn: 'week_start' },
];

function isCompletedIsoWeek(date, now = new Date()) {
  return startOfUtcIsoWeek(date) < startOfUtcIsoWeek(now);
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const promise = Promise.resolve().then(() => fn(item));
    results.push(promise);
    const tracked = promise.finally(() => {
      executing.splice(executing.indexOf(tracked), 1);
    });
    executing.push(tracked);
    if (executing.length >= concurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function renderOmittedSites(omitted) {
  return `... ${omitted} more. Re-run with \`siteId=<siteId>\` for focused details.`;
}

function renderSite(siteStatus) {
  return [
    `• \`${siteStatus.baseURL}\``,
    `  siteId: \`${siteStatus.siteId}\``,
    `  raw: ${formatNumber(siteStatus.raw)} rows`,
    `  daily: ${formatNumber(siteStatus.daily)} rows`,
    siteStatus.rawWeek > 0 ? `  raw week: ${formatNumber(siteStatus.rawWeek)} rows for ${siteStatus.weekStart}..${siteStatus.weekEnd}` : '',
    `  weekly: ${formatNumber(siteStatus.weekly)} rows for week ${siteStatus.weekStart}`,
    siteStatus.missing.length > 0 ? `  missing: ${siteStatus.missing.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

async function countTable(postgrestClient, table, siteId, dateColumn, dateValue) {
  const { count, error } = await postgrestClient
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq(dateColumn, dateValue);
  if (error) {
    throw new Error(`${table}: ${error.message}`);
  }
  return count || 0;
}

async function countRawWeek(postgrestClient, siteId, weekStartStr, weekEndStr) {
  const { count, error } = await postgrestClient
    .from('agentic_traffic')
    .select('*', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .gte('traffic_date', weekStartStr)
    .lte('traffic_date', weekEndStr);
  if (error) {
    throw new Error(`agentic_traffic weekly range: ${error.message}`);
  }
  return count || 0;
}

async function countSiteTables(
  postgrestClient,
  siteId,
  dateStr,
  weekStartStr,
  weekEndStr,
  weeklyExpected,
) {
  const tableCounts = await Promise.all(
    AGENTIC_TRAFFIC_TABLES.map((t) => countTable(
      postgrestClient,
      t.table,
      siteId,
      t.dateColumn,
      t.key === 'weekly' ? weekStartStr : dateStr,
    )),
  );
  const [raw, daily, weekly] = tableCounts;
  const rawWeek = weeklyExpected
    ? await countRawWeek(postgrestClient, siteId, weekStartStr, weekEndStr)
    : 0;
  return {
    raw, daily, weekly, rawWeek,
  };
}

/**
 * Factory function to create the CheckAgenticTrafficDbStatusCommand object.
 *
 * Checks whether agentic traffic has reached the raw import table and the
 * serving tables that power the dashboard.
 *
 * @param {Object} context - The context object.
 * @returns {CheckAgenticTrafficDbStatusCommand} The command object.
 */
function CheckAgenticTrafficDbStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-agentic-traffic-db-status',
    name: 'Check Agentic Traffic DB Status',
    description: 'Checks agentic traffic raw, daily, and weekly DB table status per site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>|baseUrl=<url>]`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const parsedArgs = parseStatusCommandArgs(args);
      if (parsedArgs.error) {
        await say(parsedArgs.error);
        return;
      }

      const { dateArg } = parsedArgs;
      let targetDate;
      if (dateArg) {
        targetDate = parseUtcDateArg(dateArg);
        if (!targetDate) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = addUtcDays(new Date(), -1);
      }
      if (isFutureUtcDate(targetDate)) {
        await say(':warning: Cannot check a future traffic date.');
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':warning: PostgREST client is unavailable; cannot check agentic traffic tables.');
        return;
      }

      const dateStr = formatUtcDate(targetDate);
      const weekStartStr = formatUtcDate(startOfUtcIsoWeek(targetDate));
      const weekEndStr = formatUtcDate(addUtcDays(startOfUtcIsoWeek(targetDate), 6));
      const weeklyExpected = isCompletedIsoWeek(targetDate);
      let siteScopeText = '';
      if (parsedArgs.siteId) {
        siteScopeText = ` for site \`${parsedArgs.siteId}\``;
      } else if (parsedArgs.baseURL) {
        siteScopeText = ` for site \`${parsedArgs.baseURL}\``;
      }

      await say(`:hourglass_flowing_sand: Checking agentic traffic DB tables for *${dateStr}*${siteScopeText}...`);

      const scope = await resolveSiteScope(Site, parsedArgs);
      if (scope.error) {
        await say(scope.error);
        return;
      }
      const { candidateSites } = scope;
      const configuration = await Configuration.findLatest();
      const enabledSites = candidateSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_REPORT_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(siteScopeText
          ? `:information_source: Site${siteScopeText.replace(/^ for site/, '')} does not have cdn-logs-report enabled.`
          : ':information_source: No sites have cdn-logs-report enabled.');
        return;
      }

      await say(`:gear: Checking ${enabledSites.length} site${enabledSites.length === 1 ? '' : 's'} with cdn-logs-report enabled...`);

      const siteStatuses = await runWithConcurrency(
        enabledSites,
        SITE_CONCURRENCY,
        async (site) => {
          const siteId = site.getId();
          const counts = await countSiteTables(
            postgrestClient,
            siteId,
            dateStr,
            weekStartStr,
            weekEndStr,
            weeklyExpected,
          );
          const status = {
            siteId,
            baseURL: site.getBaseURL(),
            weekStart: weekStartStr,
            weekEnd: weekEndStr,
            raw: counts.raw,
            daily: counts.daily,
            weekly: counts.weekly,
            rawWeek: counts.rawWeek,
            missing: [],
          };
          if (status.raw === 0) {
            status.missing.push('raw');
          }
          if (status.daily === 0) {
            status.missing.push('daily');
          }
          if (weeklyExpected && status.rawWeek > 0 && status.weekly === 0) {
            status.missing.push('weekly');
          }
          return status;
        },
      );

      const dashboardReady = siteStatuses.filter((s) => s.missing.length === 0);
      const rawMissing = siteStatuses.filter((s) => s.raw === 0);
      const dailyMissing = siteStatuses.filter((s) => s.daily === 0);
      const weeklyMissing = weeklyExpected
        ? siteStatuses.filter((s) => s.rawWeek > 0 && s.weekly === 0)
        : [];

      const rawPresent = siteStatuses.filter((s) => s.raw > 0).length;
      const dailyPresent = siteStatuses.filter((s) => s.daily > 0).length;
      const weeklyPresent = siteStatuses.filter((s) => s.weekly > 0).length;
      const rawTotal = siteStatuses.reduce((sum, s) => sum + s.raw, 0);
      const dailyTotal = siteStatuses.reduce((sum, s) => sum + s.daily, 0);
      const weeklyTotal = siteStatuses.reduce((sum, s) => sum + s.weekly, 0);
      const weeklySourceStatuses = weeklyExpected
        ? siteStatuses.filter((s) => s.rawWeek > 0)
        : [];
      const rawWeekTotal = weeklySourceStatuses.reduce((sum, s) => sum + s.rawWeek, 0);
      const weeklyForRawWeekTotal = weeklySourceStatuses.reduce((sum, s) => sum + s.weekly, 0);
      const weeklyPresentForRawWeek = weeklySourceStatuses.filter((s) => s.weekly > 0).length;

      let outcome = 'ACTION_REQUIRED';
      if (dashboardReady.length === enabledSites.length) {
        outcome = 'DASHBOARD_READY';
      } else if (
        rawPresent === 0 && dailyPresent === 0 && (!weeklyExpected || weeklyPresent === 0)
      ) {
        outcome = 'NO_DB_ROWS_FOR_DATE';
      }

      const lines = [
        `*Agentic Traffic DB Table Status — ${dateStr}*`,
        `Outcome: *${outcome}*`,
        `:white_check_mark: Dashboard-ready: *${dashboardReady.length}*`,
        `:hourglass_flowing_sand: Missing raw import: *${rawMissing.length}*`,
        `:arrows_counterclockwise: Missing daily serving: *${dailyMissing.length}*`,
        weeklyExpected ? `:calendar: Missing weekly serving: *${weeklyMissing.length}*` : '',
        `Sites checked: *${enabledSites.length}*`,
        `Raw table: *${rawPresent}/${enabledSites.length}* sites, ${formatNumber(rawTotal)} rows`,
        `Daily table: *${dailyPresent}/${enabledSites.length}* sites, ${formatNumber(dailyTotal)} rows`,
        weeklyExpected ? `Raw week (${weekStartStr}..${weekEndStr}): *${weeklySourceStatuses.length}/${enabledSites.length}* sites, ${formatNumber(rawWeekTotal)} rows` : '',
        weeklyExpected
          ? `Weekly table (${weekStartStr}): *${weeklyPresentForRawWeek}/${weeklySourceStatuses.length}* raw-week sites, ${formatNumber(weeklyForRawWeekTotal)} rows`
          : `Weekly table (${weekStartStr}): *${weeklyPresent}/${enabledSites.length}* sites, ${formatNumber(weeklyTotal)} rows`,
        '',
        '*Actionable insight:*',
      ].filter(Boolean);

      if (dashboardReady.length === enabledSites.length) {
        lines.push('All checked sites have raw and serving rows for the requested date.');
      } else {
        if (rawMissing.length > 0) {
          lines.push(`${rawMissing.length} site(s) have no \`agentic_traffic\` rows for ${dateStr}. Action: check the DB import/backfill for those sites.`);
        }
        if (dailyMissing.length > 0) {
          lines.push(`${dailyMissing.length} site(s) have raw data missing from \`agentic_traffic_daily\`. Action: run or check the daily refresh.`);
        }
        if (weeklyExpected && weeklyMissing.length > 0) {
          lines.push(`${weeklyMissing.length} site(s) have raw week data but no \`agentic_traffic_weekly\` rows for week ${weekStartStr}. Action: run or check the weekly refresh.`);
        }
      }

      const fullLines = [...lines];
      const addDetails = (header, rows) => appendStatusDetails(
        lines,
        fullLines,
        header,
        rows,
        renderSite,
        renderOmittedSites,
      );

      addDetails('*Dashboard-ready:*', dashboardReady);
      addDetails('*Missing raw import:*', rawMissing);
      addDetails('*Missing daily serving:*', dailyMissing);
      if (weeklyExpected) {
        addDetails('*Missing weekly serving:*', weeklyMissing);
      }

      await postReport(
        slackContext,
        lines,
        `agentic-traffic-db-status-${dateStr}`,
        `Agentic Traffic DB Status ${dateStr}`,
        `Agentic traffic DB status report for ${dateStr}`,
        fullLines,
      );
    } catch (error) {
      log.error('Error in check-agentic-traffic-db-status:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default CheckAgenticTrafficDbStatusCommand;
