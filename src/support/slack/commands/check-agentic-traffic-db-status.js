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

// Projection handlers that write to the agentic_traffic_* tables. Names are
// declared in mysticat-projector-service/src/config/analytics/index.ts.
const HANDLERS = {
  raw: 'wrpc_import_agentic_traffic',
  daily: 'wrpc_refresh_agentic_traffic_daily',
  weekly: 'wrpc_refresh_agentic_traffic_weekly',
};

// Window for "did the projection run for this traffic date?". Projections run
// shortly after analytics events arrive, typically within 24h of the traffic
// date. 2 days is a safe upper bound.
const PROJECTION_WINDOW_DAYS = 2;

// Max site IDs per PostgREST call. The full URL must fit under the smallest
// proxy in the path (API Gateway / ALB / nginx default ~8 KB). Each UUID is
// 36 chars + URL-encoded separator ≈ 40 bytes, so 150 site IDs ≈ 6 KB for
// the IN() list - leaves real headroom for handler/date filters and headers.
const SITE_ID_CHUNK_SIZE = 150;

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

/**
 * Factory function to create the CheckAgenticTrafficDbStatusCommand object.
 *
 * Reports whether the projection service has written agentic_traffic data for
 * each cdn-logs-report-enabled site on a given traffic date, by reading the
 * `projection_audit` table (the projector's own write log).
 *
 * @param {Object} context - The context object.
 * @returns {CheckAgenticTrafficDbStatusCommand} The command object.
 */
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
      const windowEnd = formatUtcDate(addUtcDays(targetDate, PROJECTION_WINDOW_DAYS));

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

      // Which (site, handler) pairs ran for this date? Chunked across N
      // PostgREST calls to stay under proxy URL-length limits when sweeping
      // hundreds of sites. Sequential to avoid concurrent DNS pressure.
      const expectedHandlers = weeklyExpected
        ? [HANDLERS.raw, HANDLERS.daily, HANDLERS.weekly]
        : [HANDLERS.raw, HANDLERS.daily];
      const siteIds = enabledSites.map((s) => s.getId());

      const ran = new Set();
      for (let i = 0; i < siteIds.length; i += SITE_ID_CHUNK_SIZE) {
        const chunk = siteIds.slice(i, i + SITE_ID_CHUNK_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const { data, error } = await postgrestClient
          .from('projection_audit')
          .select('scope_prefix,handler_name,projected_at,output_count')
          .in('scope_prefix', chunk)
          .in('handler_name', expectedHandlers)
          .gte('projected_at', `${dateStr}T00:00:00Z`)
          .lt('projected_at', `${windowEnd}T00:00:00Z`)
          .eq('skipped', false);

        if (error) {
          throw new Error(`projection_audit: ${error.message}`);
        }
        for (const row of data ?? []) {
          ran.add(`${row.scope_prefix}:${row.handler_name}`);
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

      const outcome = dashboardReady.length === enabledSites.length
        ? 'DASHBOARD_READY'
        : 'ACTION_REQUIRED';

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
