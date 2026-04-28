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
import { postErrorMessage, sendFile } from '../../../utils/slack/base.js';

const PHRASES = ['check agentic traffic db status'];
const CDN_LOGS_REPORT_AUDIT = 'cdn-logs-report';
const AGENTIC_TRAFFIC_IMPORT_HANDLER = 'wrpc_import_agentic_traffic';
const AGENTIC_TRAFFIC_DAILY_REFRESH_HANDLER = 'wrpc_refresh_agentic_traffic_daily';
const AGENTIC_TRAFFIC_WEEKLY_REFRESH_HANDLER = 'wrpc_refresh_agentic_traffic_weekly';
const AGENTIC_TRAFFIC_HANDLERS = [
  AGENTIC_TRAFFIC_IMPORT_HANDLER,
  AGENTIC_TRAFFIC_DAILY_REFRESH_HANDLER,
  AGENTIC_TRAFFIC_WEEKLY_REFRESH_HANDLER,
];
const AGENTIC_REFRESH_ENABLED_ENV = 'MYSTICAT_AGENTIC_REFRESH_ENABLED';
const BATCH_SIZE = 10;
const STALE_PENDING_THRESHOLD_HOURS = 4;
const STALE_PENDING_THRESHOLD_MS = STALE_PENDING_THRESHOLD_HOURS * 60 * 60 * 1000;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_ID_ARG_RE = /^(siteId|site-id|site_id)=(.*)$/i;
const REPORT_CHUNK_LIMIT = 2800;

const pad2 = (n) => String(n).padStart(2, '0');

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcIsoWeek(date) {
  const midnight = startOfUtcDay(date);
  const day = midnight.getUTCDay();
  const diffToMonday = -((day + 6) % 7);
  return addUtcDays(midnight, diffToMonday);
}

function isFutureUtcDate(date, now = new Date()) {
  return startOfUtcDay(date) > startOfUtcDay(now);
}

function isClosedSunday(date, now = new Date()) {
  return date.getUTCDay() === 0 && date < startOfUtcIsoWeek(now);
}

function isRefreshEnabled(env) {
  return env[AGENTIC_REFRESH_ENABLED_ENV]?.toLowerCase() !== 'false';
}

function projectionKey(handlerName, correlationId) {
  return `${handlerName}:${correlationId}`;
}

function formatProjectedAt(projectedAt) {
  if (!projectedAt) {
    return 'unknown time';
  }
  const date = new Date(projectedAt);
  if (Number.isNaN(date.getTime())) {
    return projectedAt;
  }
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function parseTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isStalePending(since, now) {
  const sinceDate = parseTimestamp(since);
  if (!sinceDate) {
    return false;
  }
  return now.getTime() - sinceDate.getTime() >= STALE_PENDING_THRESHOLD_MS;
}

function formatPendingStatus(stale) {
  return stale ? `stale pending (>${STALE_PENDING_THRESHOLD_HOURS}h)` : 'pending';
}

function getAuditTimestamp(latestAudit) {
  return latestAudit.getAuditedAt?.() || latestAudit.auditedAt;
}

function parseCommandArgs(args) {
  const parsed = {};

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (arg) {
      const siteIdMatch = arg.match(SITE_ID_ARG_RE);
      if (siteIdMatch) {
        parsed.siteId = siteIdMatch[2].trim();
        if (!parsed.siteId) {
          return { error: ':warning: siteId must not be empty.' };
        }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        parsed.dateArg = arg;
      } else if (SITE_ID_RE.test(arg)) {
        parsed.siteId = arg;
      } else {
        return { error: ':warning: Invalid date format. Use YYYY-MM-DD.' };
      }
    }
  }

  return parsed;
}

function formatExportCounts(siteExport) {
  const trafficRows = siteExport.rowCount ?? 'unknown';
  const classificationRows = siteExport.classificationCount;
  if (classificationRows === undefined) {
    return `${trafficRows} traffic rows`;
  }
  return `${trafficRows} traffic rows / ${classificationRows} classifications`;
}

function formatRefreshRow(row) {
  const meta = row.metadata || {};
  if (Array.isArray(meta.dailyRefreshDates) && meta.dailyRefreshDates.length > 0) {
    return `${row.output_count} rows (${meta.dailyRefreshDates.join(', ')})`;
  }
  if (Array.isArray(meta.weeklyRefreshWeeks) && meta.weeklyRefreshWeeks.length > 0) {
    return `${row.output_count} rows (${meta.weeklyRefreshWeeks.join(', ')})`;
  }
  return `${row.output_count} rows`;
}

function getRefreshStatus(row) {
  if (!row) {
    return 'pending';
  }
  return row.skipped ? 'skipped' : 'projected';
}

function formatProjectedStage(row, projectedAt) {
  return `projected (${row.output_count} rows at ${projectedAt})`;
}

function formatRefreshStage(row, stale = false) {
  const status = getRefreshStatus(row);
  if (status === 'pending') {
    return formatPendingStatus(stale);
  }
  if (status !== 'projected') {
    return status;
  }
  return `${status} (${formatRefreshRow(row)})`;
}

async function postReport(slackContext, lines, filenamePrefix, title, initialComment) {
  const { say } = slackContext;
  const fullText = lines.join('\n');
  if (fullText.length > REPORT_CHUNK_LIMIT && slackContext.client) {
    await sendFile(
      slackContext,
      Buffer.from(fullText, 'utf8'),
      `${filenamePrefix}-${Date.now()}.txt`,
      title,
      initialComment,
    );
    return;
  }

  if (fullText.length <= REPORT_CHUNK_LIMIT) {
    await say(fullText);
    return;
  }

  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > REPORT_CHUNK_LIMIT) {
      // eslint-disable-next-line no-await-in-loop
      await say(chunk.trim());
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk.trim()) {
    await say(chunk.trim());
  }
}

/**
 * Factory function to create the CheckAgenticTrafficDbStatusCommand object.
 *
 * Checks the processing status of the daily agentic traffic export pipeline:
 *  1. Reads the latest cdn-logs-report audit per site (which stores a batchId when
 *     runDailyAgenticExport completes).
 *  2. Queries projection_audit with those batchIds to see which have been projected
 *     into the agentic_traffic table by the projector service.
 *
 * @param {Object} context - The context object.
 * @returns {CheckAgenticTrafficDbStatusCommand} The command object.
 */
function CheckAgenticTrafficDbStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-agentic-traffic-db-status',
    name: 'Check Agentic Traffic DB Status',
    description: 'Checks the agentic traffic daily export + projection status per site.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>]`,
  });

  const { dataAccess, log, env = {} } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const parsedArgs = parseCommandArgs(args);
      if (parsedArgs.error) {
        await say(parsedArgs.error);
        return;
      }

      const { dateArg, siteId: requestedSiteId } = parsedArgs;
      let targetDate;
      if (dateArg) {
        targetDate = new Date(`${dateArg}T00:00:00Z`);
        if (Number.isNaN(targetDate.getTime())) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = new Date();
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }
      if (isFutureUtcDate(targetDate)) {
        await say(':warning: Cannot check a future traffic date.');
        return;
      }

      const dateStr = `${targetDate.getUTCFullYear()}-${pad2(targetDate.getUTCMonth() + 1)}-${pad2(targetDate.getUTCDate())}`;
      const siteScopeText = requestedSiteId ? ` for site \`${requestedSiteId}\`` : '';

      await say(`:hourglass_flowing_sand: Checking agentic traffic export + projection status for *${dateStr}*${siteScopeText}...`);

      // 1. Find all sites with cdn-logs-report enabled (those run the daily agentic export)
      const [allSites, configuration] = await Promise.all([
        Site.all(),
        Configuration.findLatest(),
      ]);
      const candidateSites = requestedSiteId
        ? allSites.filter((site) => site.getId() === requestedSiteId)
        : allSites;

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

      // 2. Read latest cdn-logs-report audit per site to extract batchId
      const siteExports = [];
      for (let i = 0; i < enabledSites.length; i += BATCH_SIZE) {
        const batch = enabledSites.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const batchResults = await Promise.all(batch.map(async (site) => {
          const siteId = site.getId();
          const baseURL = site.getBaseURL();

          try {
            const latestAudit = await site.getLatestAuditByAuditType(CDN_LOGS_REPORT_AUDIT);
            if (!latestAudit) {
              return { siteId, baseURL, status: 'no-audit' };
            }

            const auditResult = latestAudit.getAuditResult?.() || latestAudit.auditResult;
            const dailyExport = auditResult?.dailyAgenticExport;

            if (!dailyExport) {
              return { siteId, baseURL, status: 'no-export' };
            }
            if (dailyExport.skipped) {
              return {
                siteId,
                baseURL,
                status: 'skipped',
                trafficDate: dailyExport.trafficDate,
              };
            }
            if (!dailyExport.success) {
              return {
                siteId,
                baseURL,
                status: 'export-failed',
                trafficDate: dailyExport.trafficDate,
                error: dailyExport.error,
              };
            }
            if (dailyExport.trafficDate !== dateStr) {
              return {
                siteId,
                baseURL,
                status: 'date-mismatch',
                exportedDate: dailyExport.trafficDate,
                batchId: dailyExport.batchId,
              };
            }
            if (!dailyExport.batchId) {
              return {
                siteId,
                baseURL,
                status: 'no-batchid',
                trafficDate: dailyExport.trafficDate,
                rowCount: dailyExport.rowCount,
                classificationCount: dailyExport.classificationCount,
              };
            }

            return {
              siteId,
              baseURL,
              status: 'exported',
              trafficDate: dailyExport.trafficDate,
              batchId: dailyExport.batchId,
              rowCount: dailyExport.rowCount,
              classificationCount: dailyExport.classificationCount,
              auditedAt: getAuditTimestamp(latestAudit),
            };
          } catch (e) {
            log.warn(`Failed to read audit for site ${siteId}: ${e.message}`);
            return {
              siteId,
              baseURL,
              status: 'error',
              error: e.message,
            };
          }
        }));
        siteExports.push(...batchResults);
      }

      // 3. Collect batchIds for the target date and check projection_audit
      const exportedSites = siteExports.filter((s) => s.status === 'exported' && s.batchId);
      const batchIds = exportedSites.map((s) => s.batchId);
      const projectionCorrelationIds = batchIds.flatMap((batchId) => [
        batchId,
        `${batchId}:daily-refresh`,
        `${batchId}:weekly-refresh`,
      ]);

      const projectionMap = new Map();
      const postgrestClient = dataAccess?.services?.postgrestClient;
      let projectionCheckStatus = 'ok';

      if (projectionCorrelationIds.length > 0) {
        if (!postgrestClient?.from) {
          projectionCheckStatus = 'unavailable';
        } else {
          const { data: projRows, error: projError } = await postgrestClient
            .from('projection_audit')
            .select('correlation_id,scope_prefix,handler_name,output_count,projected_at,skipped,metadata')
            .in('correlation_id', projectionCorrelationIds)
            .in('handler_name', AGENTIC_TRAFFIC_HANDLERS)
            .order('projected_at', { ascending: false });

          if (projError) {
            projectionCheckStatus = 'error';
            log.warn(`projection_audit query failed: ${projError.message}`);
          } else {
            for (const row of projRows || []) {
              projectionMap.set(projectionKey(row.handler_name, row.correlation_id), row);
            }
          }
        }
      }

      // 4. Build status summary
      const dashboardReady = [];
      const refreshPending = [];
      const importPending = [];
      const skipped = [];
      const noAudit = [];
      const failed = [];
      const dateMismatch = [];
      const missingBatchId = [];
      const unknown = [];
      let rawImportsProjected = 0;
      let dailyRefreshProjected = 0;
      let weeklyRefreshProjected = 0;
      let weeklyRefreshAvailableCount = 0;
      let stalePendingSites = 0;
      const refreshEnabled = isRefreshEnabled(env);
      const weeklyRefreshExpected = refreshEnabled && isClosedSunday(targetDate);
      const now = new Date();

      for (const s of siteExports) {
        if (s.status === 'exported') {
          if (projectionCheckStatus !== 'ok') {
            unknown.push({ ...s, projectionCheckStatus });
          } else {
            const importProjection = projectionMap.get(
              projectionKey(AGENTIC_TRAFFIC_IMPORT_HANDLER, s.batchId),
            );
            if (importProjection && !importProjection.skipped) {
              rawImportsProjected += 1;
              const dailyRefreshProjection = refreshEnabled
                ? projectionMap.get(projectionKey(
                  AGENTIC_TRAFFIC_DAILY_REFRESH_HANDLER,
                  `${s.batchId}:daily-refresh`,
                ))
                : null;
              const weeklyRefreshProjection = projectionMap.get(projectionKey(
                AGENTIC_TRAFFIC_WEEKLY_REFRESH_HANDLER,
                `${s.batchId}:weekly-refresh`,
              ));
              const weeklyRefreshAvailable = weeklyRefreshExpected
                || Boolean(weeklyRefreshProjection);
              if (weeklyRefreshAvailable) {
                weeklyRefreshAvailableCount += 1;
              }

              if (dailyRefreshProjection && !dailyRefreshProjection.skipped) {
                dailyRefreshProjected += 1;
              }
              if (weeklyRefreshAvailable
                && weeklyRefreshProjection
                && !weeklyRefreshProjection.skipped) {
                weeklyRefreshProjected += 1;
              }

              const missingRefreshes = [];
              const staleRefreshes = [];
              if (refreshEnabled && (!dailyRefreshProjection || dailyRefreshProjection.skipped)) {
                missingRefreshes.push('daily refresh');
                if (!dailyRefreshProjection && isStalePending(importProjection.projected_at, now)) {
                  staleRefreshes.push('daily refresh');
                }
              }
              if (weeklyRefreshAvailable
                && (!weeklyRefreshProjection || weeklyRefreshProjection.skipped)) {
                missingRefreshes.push('weekly refresh');
                if (!weeklyRefreshProjection
                  && isStalePending(importProjection.projected_at, now)) {
                  staleRefreshes.push('weekly refresh');
                }
              }

              const enrichedSite = {
                ...s,
                importProjection,
                importOutputCount: importProjection.output_count,
                importProjectedAt: formatProjectedAt(importProjection.projected_at),
                dailyRefreshProjection,
                weeklyRefreshProjection,
                weeklyRefreshAvailable,
                staleRefreshes,
              };

              if (missingRefreshes.length > 0) {
                if (staleRefreshes.length > 0) {
                  stalePendingSites += 1;
                }
                refreshPending.push({ ...enrichedSite, missingRefreshes });
              } else {
                dashboardReady.push(enrichedSite);
              }
            } else {
              const importStalePending = isStalePending(s.auditedAt, now);
              if (importStalePending) {
                stalePendingSites += 1;
              }
              importPending.push({ ...s, importStalePending });
            }
          }
        } else if (s.status === 'skipped') {
          skipped.push(s);
        } else if (s.status === 'date-mismatch') {
          dateMismatch.push(s);
        } else if (s.status === 'no-batchid') {
          missingBatchId.push(s);
        } else if (s.status === 'export-failed' || s.status === 'error') {
          failed.push(s);
        } else {
          noAudit.push(s);
        }
      }

      const lines = [
        `*Agentic Traffic Export + Serving Status — ${dateStr}*`,
        `:white_check_mark: Dashboard-ready: *${dashboardReady.length}*  :arrows_counterclockwise: Refresh Pending: *${refreshPending.length}*  :hourglass_flowing_sand: Import Pending: *${importPending.length}*  :warning: Stale Pending: *${stalePendingSites}*  :grey_question: Unknown: *${unknown.length}*  :skip: Skipped: *${skipped.length}*  :x: Failed: *${failed.length}*  :warning: Missing batchId: *${missingBatchId.length}*  (${enabledSites.length} sites total)`,
      ];
      if (projectionCheckStatus === 'ok') {
        lines.push(`Import daily: *${rawImportsProjected}/${exportedSites.length}*  Refresh daily: *${dailyRefreshProjected}/${refreshEnabled ? rawImportsProjected : 0}*${weeklyRefreshAvailableCount > 0 ? `  Refresh weekly: *${weeklyRefreshProjected}/${weeklyRefreshAvailableCount}*` : ''}`);
      } else {
        lines.push(`Import daily: unknown (projection audit check ${projectionCheckStatus})`);
      }

      if (!refreshEnabled) {
        lines.push('_Projector refresh enqueue appears disabled via MYSTICAT_AGENTIC_REFRESH_ENABLED=false._');
      }

      if (dashboardReady.length > 0) {
        lines.push('', '*Dashboard-ready (raw import + required serving refresh complete):*');
        for (const s of dashboardReady) {
          const daily = refreshEnabled
            ? ` — daily refresh: ${formatRefreshStage(s.dailyRefreshProjection)}`
            : ' — daily refresh: disabled';
          const weekly = s.weeklyRefreshAvailable
            ? ` — weekly refresh: ${formatRefreshStage(s.weeklyRefreshProjection)}`
            : '';
          lines.push(`• \`${s.baseURL}\` — import daily: ${formatProjectedStage(s.importProjection, s.importProjectedAt)} — export: ${formatExportCounts(s)}${daily}${weekly}`);
        }
      }

      if (refreshPending.length > 0) {
        lines.push('', '*Refresh Pending (raw import projected, serving table refresh not yet seen):*');
        for (const s of refreshPending) {
          const daily = refreshEnabled
            ? ` — daily refresh: ${formatRefreshStage(
              s.dailyRefreshProjection,
              s.staleRefreshes.includes('daily refresh'),
            )}`
            : ' — daily refresh: disabled';
          const weekly = s.weeklyRefreshAvailable
            ? ` — weekly refresh: ${formatRefreshStage(
              s.weeklyRefreshProjection,
              s.staleRefreshes.includes('weekly refresh'),
            )}`
            : '';
          const missing = s.missingRefreshes
            .map((name) => (s.staleRefreshes.includes(name) ? `${name} (stale)` : name))
            .join(', ');
          lines.push(`• \`${s.baseURL}\` (${s.siteId}) — import daily: ${formatProjectedStage(s.importProjection, s.importProjectedAt)}${daily}${weekly} — missing: ${missing} — batchId: \`${s.batchId}\``);
        }
      }

      if (importPending.length > 0) {
        lines.push('', '*Import Pending (export done, raw DB import not yet seen):*');
        for (const s of importPending) {
          const weekly = weeklyRefreshExpected ? ' — weekly refresh: waiting on import' : '';
          lines.push(`• \`${s.baseURL}\` (${s.siteId}) — import daily: ${formatPendingStatus(s.importStalePending)} — daily refresh: waiting on import${weekly} — batchId: \`${s.batchId}\` — export: ${formatExportCounts(s)}`);
        }
      }

      if (unknown.length > 0) {
        lines.push('', '*Unknown (projection_audit status could not be checked):*');
        for (const s of unknown) {
          lines.push(`• \`${s.baseURL}\` (${s.siteId}) — projection audit check: ${s.projectionCheckStatus} — batchId: \`${s.batchId}\` — export: ${formatExportCounts(s)}`);
        }
      }

      if (dateMismatch.length > 0) {
        lines.push('', `*Latest audit is for a different date (not ${dateStr}):*`);
        for (const s of dateMismatch) {
          lines.push(`• \`${s.baseURL}\` — latest export was for ${s.exportedDate}`);
        }
      }

      if (failed.length > 0) {
        lines.push('', '*Export failures:*');
        for (const s of failed) {
          lines.push(`• \`${s.baseURL}\` — ${s.error || 'unknown error'}`);
        }
      }

      if (missingBatchId.length > 0) {
        lines.push('', '*Export missing batchId:*');
        for (const s of missingBatchId) {
          lines.push(`• \`${s.baseURL}\` (${s.siteId}) — export: ${formatExportCounts(s)}`);
        }
      }

      if (skipped.length > 0) {
        lines.push('', `*Skipped (no traffic data for ${dateStr}):*`);
        for (const s of skipped) {
          lines.push(`• \`${s.baseURL}\``);
        }
      }

      if (noAudit.length > 0) {
        lines.push('', '*No audit record found:*');
        for (const s of noAudit) {
          lines.push(`• \`${s.baseURL}\``);
        }
      }

      await postReport(
        slackContext,
        lines,
        `agentic-traffic-db-status-${dateStr}`,
        `Agentic Traffic DB Status ${dateStr}`,
        `Agentic traffic DB status report for ${dateStr}`,
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
