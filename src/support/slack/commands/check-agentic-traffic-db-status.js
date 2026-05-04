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
  startOfUtcDay,
} from './status-command-helpers.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check agentic traffic db status'];
const CDN_LOGS_REPORT_AUDIT = 'cdn-logs-report';
const BATCH_SIZE = 25;
const AGENTIC_TRAFFIC_TABLES = [
  {
    key: 'raw',
    label: 'raw import',
    table: 'agentic_traffic',
    dateColumn: 'traffic_date',
    select: 'site_id,hits,updated_at',
  },
  {
    key: 'daily',
    label: 'daily serving',
    table: 'agentic_traffic_daily',
    dateColumn: 'traffic_date',
    select: 'site_id,hits,updated_at',
  },
  {
    key: 'weekly',
    label: 'weekly serving',
    table: 'agentic_traffic_weekly',
    dateColumn: 'week_start',
    select: 'site_id,hits,updated_at',
  },
];

function startOfUtcIsoWeek(date) {
  const midnight = startOfUtcDay(date);
  const day = midnight.getUTCDay();
  const diffToMonday = -((day + 6) % 7);
  return addUtcDays(midnight, diffToMonday);
}

function isClosedSunday(date, now = new Date()) {
  return date.getUTCDay() === 0 && date < startOfUtcIsoWeek(now);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function rowsEmptySummary() {
  return { rows: 0, hits: 0, latestUpdate: null };
}

function addRowSummary(summaries, row) {
  const siteId = row.site_id;
  if (!siteId) {
    return;
  }
  const summary = summaries.get(siteId) || rowsEmptySummary();
  const hits = Number(row.hits || 0);
  summary.rows += 1;
  summary.hits += Number.isFinite(hits) ? hits : 0;
  if (row.updated_at && (!summary.latestUpdate || row.updated_at > summary.latestUpdate)) {
    summary.latestUpdate = row.updated_at;
  }
  summaries.set(siteId, summary);
}

function summarizeRows(rows = []) {
  const summaries = new Map();
  for (const row of rows) {
    addRowSummary(summaries, row);
  }
  return summaries;
}

function getTableSummary(tableSummaries, tableKey, siteId) {
  return tableSummaries[tableKey].get(siteId) || rowsEmptySummary();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatUpdateTime(value) {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function formatTableSummary(summary) {
  return `${formatNumber(summary.rows)} rows / ${formatNumber(summary.hits)} hits`;
}

function sumTable(siteStatuses, tableKey) {
  return siteStatuses.reduce((summary, siteStatus) => {
    const tableSummary = siteStatus[tableKey];
    return {
      rows: summary.rows + tableSummary.rows,
      hits: summary.hits + tableSummary.hits,
      latestUpdate: !summary.latestUpdate || tableSummary.latestUpdate > summary.latestUpdate
        ? tableSummary.latestUpdate
        : summary.latestUpdate,
    };
  }, rowsEmptySummary());
}

function renderOmittedSites(omitted) {
  return `... ${omitted} more. Re-run with \`siteId=<siteId>\` for focused details.`;
}

function renderSite(siteStatus) {
  return [
    `• \`${siteStatus.baseURL}\``,
    `  siteId: \`${siteStatus.siteId}\``,
    `  raw: ${formatTableSummary(siteStatus.raw)} (updated ${formatUpdateTime(siteStatus.raw.latestUpdate)})`,
    `  daily: ${formatTableSummary(siteStatus.daily)} (updated ${formatUpdateTime(siteStatus.daily.latestUpdate)})`,
    `  weekly: ${formatTableSummary(siteStatus.weekly)} for week ${siteStatus.weekStart} (updated ${formatUpdateTime(siteStatus.weekly.latestUpdate)})`,
    siteStatus.missing.length > 0 ? `  missing: ${siteStatus.missing.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

async function queryTable(postgrestClient, tableDef, siteIds, dateValue) {
  const { data, error } = await postgrestClient
    .from(tableDef.table)
    .select(tableDef.select)
    .in('site_id', siteIds)
    .eq(tableDef.dateColumn, dateValue);

  if (error) {
    throw new Error(`${tableDef.table}: ${error.message}`);
  }
  return data || [];
}

async function queryTrafficTables(postgrestClient, siteIds, dateStr, weekStartStr) {
  const summaries = { raw: new Map(), daily: new Map(), weekly: new Map() };

  for (const siteIdBatch of chunkArray(siteIds, BATCH_SIZE)) {
    for (const tableDef of AGENTIC_TRAFFIC_TABLES) {
      const dateValue = tableDef.key === 'weekly' ? weekStartStr : dateStr;
      // eslint-disable-next-line no-await-in-loop
      const rows = await queryTable(postgrestClient, tableDef, siteIdBatch, dateValue);
      summaries[tableDef.key] = new Map([
        ...summaries[tableDef.key],
        ...summarizeRows(rows),
      ]);
    }
  }

  return summaries;
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
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>]`,
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

      const { dateArg, siteId: requestedSiteId } = parsedArgs;
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
      const weeklyExpected = isClosedSunday(targetDate);
      const siteScopeText = requestedSiteId ? ` for site \`${requestedSiteId}\`` : '';

      await say(`:hourglass_flowing_sand: Checking agentic traffic DB tables for *${dateStr}*${siteScopeText}...`);

      const configuration = await Configuration.findLatest();
      const candidateSites = requestedSiteId
        ? [await Site.findById(requestedSiteId)].filter(Boolean)
        : await Site.all();

      if (requestedSiteId && candidateSites.length === 0) {
        await say(`:warning: No site found with siteId \`${requestedSiteId}\`.`);
        return;
      }

      const enabledSites = candidateSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_REPORT_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(requestedSiteId
          ? `:information_source: Site \`${requestedSiteId}\` does not have cdn-logs-report enabled.`
          : ':information_source: No sites have cdn-logs-report enabled.');
        return;
      }

      await say(`:gear: Checking ${enabledSites.length} site${enabledSites.length === 1 ? '' : 's'} with cdn-logs-report enabled...`);

      const tableSummaries = await queryTrafficTables(
        postgrestClient,
        enabledSites.map((site) => site.getId()),
        dateStr,
        weekStartStr,
      );

      const dashboardReady = [];
      const rawMissing = [];
      const dailyMissing = [];
      const weeklyMissing = [];

      const siteStatuses = enabledSites.map((site) => {
        const siteId = site.getId();
        const status = {
          siteId,
          baseURL: site.getBaseURL(),
          weekStart: weekStartStr,
          raw: getTableSummary(tableSummaries, 'raw', siteId),
          daily: getTableSummary(tableSummaries, 'daily', siteId),
          weekly: getTableSummary(tableSummaries, 'weekly', siteId),
          missing: [],
        };

        if (status.raw.rows === 0) {
          status.missing.push('raw');
        }
        if (status.daily.rows === 0) {
          status.missing.push('daily');
        }
        if (weeklyExpected && status.weekly.rows === 0) {
          status.missing.push('weekly');
        }

        if (status.missing.length === 0) {
          dashboardReady.push(status);
        } else {
          if (status.raw.rows === 0) {
            rawMissing.push(status);
          }
          if (status.daily.rows === 0) {
            dailyMissing.push(status);
          }
          if (weeklyExpected && status.weekly.rows === 0) {
            weeklyMissing.push(status);
          }
        }
        return status;
      });

      const rawPresent = siteStatuses.filter((s) => s.raw.rows > 0).length;
      const dailyPresent = siteStatuses.filter((s) => s.daily.rows > 0).length;
      const weeklyPresent = siteStatuses.filter((s) => s.weekly.rows > 0).length;
      const rawTotal = sumTable(siteStatuses, 'raw');
      const dailyTotal = sumTable(siteStatuses, 'daily');
      const weeklyTotal = sumTable(siteStatuses, 'weekly');

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
        `Raw table: *${rawPresent}/${enabledSites.length}* sites, ${formatTableSummary(rawTotal)}`,
        `Daily table: *${dailyPresent}/${enabledSites.length}* sites, ${formatTableSummary(dailyTotal)}`,
        `Weekly table (${weekStartStr}): *${weeklyPresent}/${enabledSites.length}* sites, ${formatTableSummary(weeklyTotal)}`,
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
          lines.push(`${weeklyMissing.length} site(s) are missing \`agentic_traffic_weekly\` rows for week ${weekStartStr}. Action: run or check the weekly refresh.`);
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
