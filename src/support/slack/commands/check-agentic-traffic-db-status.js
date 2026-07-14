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

// Upper bound (days after the traffic date) for crediting a raw import without a
// matching daily refresh — wide enough to cover weekend and slow-pipeline delays.
const RAW_FALLBACK_WINDOW_DAYS = 7;
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
      // A refresh covering a date is projected on/after it, so a lower bound suffices
      // (no upper bound — backfills run arbitrarily later). Match the exact date via
      // jsonb metadata containment so result sets stay small even across all sites.
      const rawProjectableAt = `${formatUtcDate(addUtcDays(targetDate, 1))}T00:00:00Z`;
      const rawWindowEnd = `${formatUtcDate(addUtcDays(targetDate, RAW_FALLBACK_WINDOW_DAYS))}T00:00:00Z`;

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

      const siteIds = enabledSites.map((s) => s.getId());

      // jsonb containment must be a JSON string for postgrest-js (an array arg
      // would emit a Postgres array literal `cs.{..}`, not jsonb `cs.[..]`).
      const dailyContains = JSON.stringify([dateStr]);
      const weeklyContains = JSON.stringify([weekStartStr]);

      const ran = new Set();
      /* eslint-disable no-await-in-loop */
      for (let i = 0; i < siteIds.length; i += SITE_ID_CHUNK_SIZE) {
        const chunk = siteIds.slice(i, i + SITE_ID_CHUNK_SIZE);
        const query = (decorate) => withRetry(async () => {
          const { data, error } = await decorate(postgrestClient
            .from('projection_audit')
            .select('scope_prefix')
            .in('scope_prefix', chunk)
            .eq('skipped', false));
          if (error) {
            throw new Error(`projection_audit: ${error.message}`);
          }
          return data ?? [];
        });

        // The three per-handler queries are independent — run them in parallel.
        const [dailyRows, weeklyRows, rawRows] = await Promise.all([
          // Daily refresh for dateStr is a post-success message of the raw import,
          // so a daily-for-X row proves raw succeeded for X too.
          query((q) => q
            .eq('handler_name', HANDLERS.daily)
            .gte('projected_at', `${dateStr}T00:00:00Z`)
            .contains('metadata->dailyRefreshDates', dailyContains)),
          weeklyExpected
            ? query((q) => q
              .eq('handler_name', HANDLERS.weekly)
              .gte('projected_at', `${weekStartStr}T00:00:00Z`)
              .contains('metadata->weeklyRefreshWeeks', weeklyContains))
            : Promise.resolve([]),
          // Fallback for "raw OK, daily not run yet": raw carries no per-date
          // metadata, so credit it within the post-traffic window (RAW_FALLBACK_WINDOW_DAYS,
          // covers weekend/pipeline delays) with positive output.
          query((q) => q
            .eq('handler_name', HANDLERS.raw)
            .gte('projected_at', rawProjectableAt)
            .lt('projected_at', rawWindowEnd)
            .gt('output_count', 0)),
        ]);

        for (const row of dailyRows) {
          ran.add(`${row.scope_prefix}:${HANDLERS.daily}`);
          ran.add(`${row.scope_prefix}:${HANDLERS.raw}`);
        }
        for (const row of weeklyRows) {
          ran.add(`${row.scope_prefix}:${HANDLERS.weekly}`);
        }
        for (const row of rawRows) {
          ran.add(`${row.scope_prefix}:${HANDLERS.raw}`);
        }
      }
      /* eslint-enable no-await-in-loop */

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
