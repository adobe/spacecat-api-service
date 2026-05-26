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

// Handler names: mysticat-projector-service/src/config/analytics/index.ts
const HANDLERS = {
  raw: 'wrpc_import_agentic_traffic',
  daily: 'wrpc_refresh_agentic_traffic_daily',
  weekly: 'wrpc_refresh_agentic_traffic_weekly',
};

const PROJECTION_LOOKBACK_DAYS = 1;
const PROJECTION_LOOKAHEAD_DAYS = 7;
const SITE_ID_CHUNK_SIZE = 150;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'EBUSY', 'ETIMEDOUT', 'PGRST002']);
const TRANSIENT_HTTP_STATUS_RE = /^5\d\d$/;
const TRANSIENT_MESSAGE_RE = /\b(?:timeout|gateway|ECONNRESET|ENOTFOUND|EBUSY|ETIMEDOUT|PGRST002)\b/i;

function isTransientError(error) {
  if (!error) {
    return false;
  }
  if (error.code && TRANSIENT_CODES.has(String(error.code))) {
    return true;
  }
  if (TRANSIENT_HTTP_STATUS_RE.test(String(error.status ?? ''))) {
    return true;
  }
  return TRANSIENT_MESSAGE_RE.test(String(error.message || ''));
}

async function withRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === RETRY_ATTEMPTS - 1) {
        throw error;
      }
      const delay = RETRY_BASE_DELAY_MS * (2 ** attempt) * Math.random();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }
  throw lastError;
}

function isCompletedIsoWeek(date, now = new Date()) {
  return startOfUtcIsoWeek(date) < startOfUtcIsoWeek(now);
}

/* c8 ignore next 3 -- only triggered for very long missing-site lists; output is cosmetic */
function renderOmittedSites(omitted) {
  return `... ${omitted} more. Re-run with \`siteId=<siteId>\` for focused details.`;
}

function renderSite(siteStatus) {
  return [
    `• \`${siteStatus.baseURL}\``,
    `  siteId: \`${siteStatus.siteId}\``,
    `  missing: ${siteStatus.missing.join(', ')}`,
  ].join('\n');
}

function CheckAgenticTrafficDbStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-agentic-traffic-db-status',
    name: 'Check Agentic Traffic DB Status',
    description: 'Checks agentic traffic projection runs (raw/daily/weekly) per site via projection_audit.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>|baseUrl=<url>]`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const parsedArgs = parseStatusCommandArgs(args);
      /* c8 ignore next 4 -- arg validation tested in status-command-helpers */
      if (parsedArgs.error) {
        await say(parsedArgs.error);
        return;
      }

      const { dateArg } = parsedArgs;
      let targetDate;
      if (dateArg) {
        targetDate = parseUtcDateArg(dateArg);
        /* c8 ignore next 4 -- parseUtcDateArg failure tested in status-command-helpers */
        if (!targetDate) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = addUtcDays(new Date(), -1);
      }
      /* c8 ignore next 4 -- isFutureUtcDate tested in status-command-helpers */
      if (isFutureUtcDate(targetDate)) {
        await say(':warning: Cannot check a future traffic date.');
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':warning: PostgREST client is unavailable; cannot check projection_audit.');
        return;
      }

      const dateStr = formatUtcDate(targetDate);
      const weeklyExpected = isCompletedIsoWeek(targetDate);
      const weekStartStr = formatUtcDate(startOfUtcIsoWeek(targetDate));
      const windowStart = formatUtcDate(addUtcDays(targetDate, -PROJECTION_LOOKBACK_DAYS));
      const windowEnd = formatUtcDate(addUtcDays(targetDate, PROJECTION_LOOKAHEAD_DAYS));

      /* c8 ignore next 6 -- cosmetic per-scope prefix; logic tested via resolveSiteScope */
      let siteScopeText = '';
      if (parsedArgs.siteId) {
        siteScopeText = ` for site \`${parsedArgs.siteId}\``;
      } else if (parsedArgs.baseURL) {
        siteScopeText = ` for site \`${parsedArgs.baseURL}\``;
      }

      await say(`:hourglass_flowing_sand: Checking agentic traffic projections for *${dateStr}*${siteScopeText}...`);

      const scope = await resolveSiteScope(Site, parsedArgs);
      /* c8 ignore next 4 -- scope error tested in resolveSiteScope */
      if (scope.error) {
        await say(scope.error);
        return;
      }
      const configuration = await Configuration.findLatest();
      const enabledSites = scope.candidateSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_REPORT_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(siteScopeText
          ? `:information_source: Site${siteScopeText.replace(/^ for site/, '')} does not have cdn-logs-report enabled.`
          : ':information_source: No sites have cdn-logs-report enabled.');
        return;
      }

      const expectedHandlers = weeklyExpected
        ? [HANDLERS.raw, HANDLERS.daily, HANDLERS.weekly]
        : [HANDLERS.raw, HANDLERS.daily];
      const siteIds = enabledSites.map((s) => s.getId());

      const ran = new Set();
      for (let i = 0; i < siteIds.length; i += SITE_ID_CHUNK_SIZE) {
        const chunk = siteIds.slice(i, i + SITE_ID_CHUNK_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const { data, error } = await withRetry(() => postgrestClient
          .from('projection_audit')
          .select('scope_prefix,handler_name,projected_at,output_count,metadata')
          .in('scope_prefix', chunk)
          .in('handler_name', expectedHandlers)
          .gte('projected_at', `${windowStart}T00:00:00Z`)
          .lt('projected_at', `${windowEnd}T00:00:00Z`)
          .eq('skipped', false));

        if (error) {
          throw new Error(`projection_audit: ${error.message}`);
        }
        // Raw audit rows for `wrpc_import_agentic_traffic` do not carry per-date
        // metadata, so a row alone cannot prove that *the requested* dateStr was
        // covered (the same row may correspond to an earlier date inside the
        // lookup window). We infer raw coverage from two date-specific signals:
        //   1. Daily refresh metadata: dailyRefreshDates includes dateStr.
        //      Daily refresh is a post-success message from the raw import
        //      (see projector agenticTrafficAnalyticsConfig), so a daily-for-X
        //      row proves raw succeeded for X.
        //   2. Fallback for "raw OK, daily not run yet": a raw row whose
        //      `projected_at` lands on or after dateStr+1 day UTC (the raw
        //      projector runs the day after the traffic day) with a positive
        //      `output_count`.
        const rawProjectableAt = `${formatUtcDate(addUtcDays(targetDate, 1))}T00:00:00Z`;
        for (const row of data ?? []) {
          if (row.handler_name === HANDLERS.daily) {
            const dates = row.metadata?.dailyRefreshDates ?? [];
            if (dates.includes(dateStr)) {
              ran.add(`${row.scope_prefix}:${HANDLERS.daily}`);
              ran.add(`${row.scope_prefix}:${HANDLERS.raw}`);
            }
          } else if (row.handler_name === HANDLERS.weekly) {
            const weeks = row.metadata?.weeklyRefreshWeeks ?? [];
            if (weeks.includes(weekStartStr)) {
              ran.add(`${row.scope_prefix}:${HANDLERS.weekly}`);
            }
          } else if (row.handler_name === HANDLERS.raw) {
            if (
              row.projected_at >= rawProjectableAt
              && Number(row.output_count ?? 0) > 0
            ) {
              ran.add(`${row.scope_prefix}:${HANDLERS.raw}`);
            }
          }
        }
      }

      const siteStatuses = enabledSites.map((site) => {
        const id = site.getId();
        const missing = [];
        if (!ran.has(`${id}:${HANDLERS.raw}`)) {
          missing.push('raw');
        }
        if (!ran.has(`${id}:${HANDLERS.daily}`)) {
          missing.push('daily');
        }
        if (weeklyExpected && !ran.has(`${id}:${HANDLERS.weekly}`)) {
          missing.push('weekly');
        }
        return { siteId: id, baseURL: site.getBaseURL(), missing };
      });

      const dashboardReady = siteStatuses.filter((s) => s.missing.length === 0);
      const rawMissing = siteStatuses.filter((s) => s.missing.includes('raw'));
      const dailyMissing = siteStatuses.filter((s) => s.missing.includes('daily'));
      const weeklyMissing = siteStatuses.filter((s) => s.missing.includes('weekly'));

      let outcome;
      if (dashboardReady.length === enabledSites.length) {
        outcome = 'DASHBOARD_READY';
      } else if (ran.size === 0) {
        outcome = 'NO_DB_ROWS_FOR_DATE';
      } else {
        outcome = 'ACTION_REQUIRED';
      }

      const lines = [
        `*Agentic Traffic Projection Status — ${dateStr}*`,
        `Outcome: *${outcome}*`,
        `:white_check_mark: Dashboard-ready: *${dashboardReady.length}/${enabledSites.length}*`,
        `:hourglass_flowing_sand: Missing raw projection: *${rawMissing.length}*`,
        `:arrows_counterclockwise: Missing daily refresh: *${dailyMissing.length}*`,
        weeklyExpected ? `:calendar: Missing weekly refresh (week of ${weekStartStr}): *${weeklyMissing.length}*` : '',
        '',
        '*Actionable insight:*',
      ].filter(Boolean);

      if (outcome === 'DASHBOARD_READY') {
        lines.push(`All ${enabledSites.length} site(s) have completed projections for ${dateStr}.`);
      } else {
        if (rawMissing.length > 0) {
          lines.push(`${rawMissing.length} site(s) missing \`wrpc_import_agentic_traffic\`. Action: check the projector for backlog or failures.`);
        }
        if (dailyMissing.length > 0) {
          lines.push(`${dailyMissing.length} site(s) missing \`wrpc_refresh_agentic_traffic_daily\`. Action: re-run the daily refresh.`);
        }
        if (weeklyExpected && weeklyMissing.length > 0) {
          lines.push(`${weeklyMissing.length} site(s) missing \`wrpc_refresh_agentic_traffic_weekly\` (week of ${weekStartStr}). Action: re-run the weekly refresh.`);
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

      addDetails('*Missing raw projection:*', rawMissing);
      addDetails('*Missing daily refresh:*', dailyMissing);
      if (weeklyExpected) {
        addDetails('*Missing weekly refresh:*', weeklyMissing);
      }

      await postReport(
        slackContext,
        lines,
        `agentic-traffic-db-status-${dateStr}`,
        `Agentic Traffic Projection Status ${dateStr}`,
        `Agentic traffic projection status report for ${dateStr}`,
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
