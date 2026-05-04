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
  appendLimitedDetails,
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
const AUDIT_LOOKBACK_LIMIT = 50;
const PROJECTION_CORRELATION_ID_BATCH_SIZE = 75;
const STALE_PENDING_THRESHOLD_HOURS = 4;
const STALE_PENDING_THRESHOLD_MS = STALE_PENDING_THRESHOLD_HOURS * 60 * 60 * 1000;
const DAILY_REFRESH_CORRELATION_SUFFIX = ':daily-refresh';
const WEEKLY_REFRESH_CORRELATION_SUFFIX = ':weekly-refresh';
const BATCH_ID_ARG_RE = /^batchId=([0-9A-Za-z._:-]+)$/i;

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcIsoWeek(date) {
  const midnight = startOfUtcDay(date);
  const day = midnight.getUTCDay();
  const diffToMonday = -((day + 6) % 7);
  return addUtcDays(midnight, diffToMonday);
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

function getAuditResult(audit) {
  return audit?.getAuditResult?.() || audit?.auditResult;
}

function inferTrafficDateFromAudit(audit) {
  const auditedAt = parseTimestamp(getAuditTimestamp(audit));
  return auditedAt ? formatUtcDate(addUtcDays(auditedAt, -1)) : undefined;
}

function getDailyAgenticExports(audit) {
  const auditResult = getAuditResult(audit);
  if (Array.isArray(auditResult)) {
    const trafficDate = inferTrafficDateFromAudit(audit);
    return auditResult
      .filter(({ name } = {}) => name === 'agentic-db-export')
      .map(({ batchId }) => ({
        success: true,
        trafficDate,
        batchId,
      }));
  }

  return [
    auditResult?.dailyAgenticExport,
    ...(Array.isArray(auditResult?.dailyAgenticExports) ? auditResult.dailyAgenticExports : []),
  ].filter(Boolean);
}

function getDailyAgenticExport(audit, dateStr) {
  const exports = getDailyAgenticExports(audit);
  return exports.find((dailyExport) => dailyExport?.trafficDate === dateStr) || exports[0];
}

async function getAuditForTrafficDate(site, auditCollection, auditType, dateStr) {
  const siteId = site.getId();
  if (auditCollection?.allBySiteIdAndAuditType) {
    const audits = await auditCollection.allBySiteIdAndAuditType(siteId, auditType, {
      order: 'desc',
      limit: AUDIT_LOOKBACK_LIMIT,
    });
    const matchingAudit = (audits || []).find((audit) => (
      getDailyAgenticExports(audit).some((dailyExport) => dailyExport?.trafficDate === dateStr)
    ));
    return matchingAudit || audits?.[0] || null;
  }

  return site.getLatestAuditByAuditType(auditType);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function renderOmittedSites(omitted) {
  return `… ${omitted} more. Re-run with \`siteId=<siteId>\` for focused details.`;
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

function addProjectionRow(projectionMap, row) {
  projectionMap.set(projectionKey(row.handler_name, row.correlation_id), row);
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

function projectionCorrelationIdsForBatch(batchId) {
  return [
    batchId,
    `${batchId}${DAILY_REFRESH_CORRELATION_SUFFIX}`,
    `${batchId}${WEEKLY_REFRESH_CORRELATION_SUFFIX}`,
  ];
}

function parseBatchIdArg(args = []) {
  const remainingArgs = [];
  let batchId;

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) {
      remainingArgs.push(rawArg);
      // eslint-disable-next-line no-continue
      continue;
    }

    const match = arg.match(BATCH_ID_ARG_RE);
    if (match) {
      if (batchId) {
        return { error: ':warning: Duplicate batchId argument.' };
      }
      [, batchId] = match;
    } else if (/^batchId=/i.test(arg)) {
      return { error: ':warning: Invalid batchId. Expected a non-empty correlation ID.' };
    } else {
      remainingArgs.push(rawArg);
    }
  }

  return { batchId, remainingArgs };
}

/**
 * Factory function to create the CheckAgenticTrafficDbStatusCommand object.
 *
 * Checks the processing status of the daily agentic traffic export pipeline:
 *  1. Reads the latest cdn-logs-report audit per site (which stores an
 *     agentic-db-export audit_result entry when runDailyAgenticExport completes).
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
  const { Site, Configuration, Audit } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const batchArg = parseBatchIdArg(args);
      if (batchArg.error) {
        await say(batchArg.error);
        return;
      }

      if (batchArg.batchId) {
        const postgrestClient = dataAccess?.services?.postgrestClient;
        if (!postgrestClient?.from) {
          await say(':warning: PostgREST client is unavailable; cannot check projection_audit.');
          return;
        }

        const { batchId } = batchArg;
        await say(`:hourglass_flowing_sand: Checking projection_audit for batchId \`${batchId}\`...`);

        const { data: projectionRows, error: projectionError } = await postgrestClient
          .from('projection_audit')
          .select('correlation_id,scope_prefix,handler_name,output_entity,output_record_id,output_count,projected_at,skipped,metadata')
          .in('correlation_id', projectionCorrelationIdsForBatch(batchId))
          .in('handler_name', AGENTIC_TRAFFIC_HANDLERS)
          .order('projected_at', { ascending: false });

        if (projectionError) {
          log.warn(`projection_audit batchId query failed: ${projectionError.message}`);
          await say(`:warning: projection_audit query failed: ${projectionError.message}`);
          return;
        }

        const projectionMap = new Map();
        for (const row of projectionRows || []) {
          addProjectionRow(projectionMap, row);
        }

        const importProjection = projectionMap.get(
          projectionKey(AGENTIC_TRAFFIC_IMPORT_HANDLER, batchId),
        );
        const dailyRefreshProjection = projectionMap.get(projectionKey(
          AGENTIC_TRAFFIC_DAILY_REFRESH_HANDLER,
          `${batchId}${DAILY_REFRESH_CORRELATION_SUFFIX}`,
        ));
        const weeklyRefreshProjection = projectionMap.get(projectionKey(
          AGENTIC_TRAFFIC_WEEKLY_REFRESH_HANDLER,
          `${batchId}${WEEKLY_REFRESH_CORRELATION_SUFFIX}`,
        ));
        const siteId = importProjection?.scope_prefix
          || dailyRefreshProjection?.scope_prefix
          || weeklyRefreshProjection?.scope_prefix;
        const site = siteId ? await Site.findById(siteId).catch(() => null) : null;

        let outcome = 'IMPORT_NOT_FOUND';
        if (importProjection && dailyRefreshProjection) {
          outcome = 'RAW_IMPORT_AND_DAILY_REFRESH_PROJECTED';
        } else if (importProjection) {
          outcome = 'RAW_IMPORT_PROJECTED';
        }
        const lines = [
          `*Agentic Traffic Projection Status — ${batchId}*`,
          `Outcome: *${outcome}*`,
          siteId ? `siteId: \`${siteId}\`` : 'siteId: unknown',
          site?.getBaseURL ? `baseURL: \`${site.getBaseURL()}\`` : '',
          `Rows found: *${(projectionRows || []).length}*`,
          '',
          '*Projection rows:*',
          `raw import: ${importProjection ? formatProjectedStage(importProjection, formatProjectedAt(importProjection.projected_at)) : 'pending'}`,
          `daily refresh: ${formatRefreshStage(dailyRefreshProjection)}`,
          `weekly refresh: ${formatRefreshStage(weeklyRefreshProjection)}`,
        ].filter(Boolean);

        await postReport(
          slackContext,
          lines,
          `agentic-traffic-projection-${batchId}`,
          `Agentic Traffic Projection ${batchId}`,
          `Agentic traffic projection report for ${batchId}`,
        );
        return;
      }

      const parsedArgs = parseStatusCommandArgs(batchArg.remainingArgs);
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
        targetDate = new Date();
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }
      if (isFutureUtcDate(targetDate)) {
        await say(':warning: Cannot check a future traffic date.');
        return;
      }

      const dateStr = formatUtcDate(targetDate);
      const siteScopeText = requestedSiteId ? ` for site \`${requestedSiteId}\`` : '';

      await say(`:hourglass_flowing_sand: Checking agentic traffic export + projection status for *${dateStr}*${siteScopeText}...`);

      // 1. Find all sites with cdn-logs-report enabled (those run the daily agentic export)
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

      // 2. Read latest cdn-logs-report audit per site to extract batchId
      const siteExports = [];
      for (let i = 0; i < enabledSites.length; i += BATCH_SIZE) {
        const batch = enabledSites.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const batchResults = await Promise.all(batch.map(async (site) => {
          const siteId = site.getId();
          const baseURL = site.getBaseURL();

          try {
            const latestAudit = await getAuditForTrafficDate(
              site,
              Audit,
              CDN_LOGS_REPORT_AUDIT,
              dateStr,
            );
            if (!latestAudit) {
              return { siteId, baseURL, status: 'no-audit' };
            }

            const dailyExport = getDailyAgenticExport(latestAudit, dateStr);

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
      let exportedSites = siteExports.filter((s) => s.status === 'exported' && s.batchId);
      const batchIds = exportedSites.map((s) => s.batchId);
      const projectionCorrelationIds = batchIds.flatMap(projectionCorrelationIdsForBatch);
      const siteIdByCorrelationId = new Map(exportedSites.flatMap((s) => [
        [s.batchId, s.siteId],
        [`${s.batchId}${DAILY_REFRESH_CORRELATION_SUFFIX}`, s.siteId],
        [`${s.batchId}${WEEKLY_REFRESH_CORRELATION_SUFFIX}`, s.siteId],
      ]));

      const projectionMap = new Map();
      const postgrestClient = dataAccess?.services?.postgrestClient;
      let projectionCheckStatus = 'ok';

      if (projectionCorrelationIds.length > 0) {
        if (!postgrestClient?.from) {
          projectionCheckStatus = 'unavailable';
        } else {
          const projectionRows = [];
          const correlationIdBatches = chunkArray(
            projectionCorrelationIds,
            PROJECTION_CORRELATION_ID_BATCH_SIZE,
          );
          for (const correlationIdBatch of correlationIdBatches) {
            // eslint-disable-next-line no-await-in-loop
            const { data: projRows, error: projError } = await postgrestClient
              .from('projection_audit')
              .select('correlation_id,scope_prefix,handler_name,output_count,projected_at,skipped,metadata')
              .in('correlation_id', correlationIdBatch)
              .in('handler_name', AGENTIC_TRAFFIC_HANDLERS)
              .order('projected_at', { ascending: false });

            if (projError) {
              projectionCheckStatus = 'error';
              log.warn(`projection_audit query failed: ${projError.message}`);
              break;
            }
            projectionRows.push(...(projRows || []));
          }

          if (projectionCheckStatus === 'ok') {
            for (const row of projectionRows) {
              const expectedSiteId = siteIdByCorrelationId.get(row.correlation_id);
              if (row.scope_prefix && expectedSiteId && row.scope_prefix !== expectedSiteId) {
                log.warn(`Ignoring projection_audit row with mismatched scope_prefix for ${row.correlation_id}: expected ${expectedSiteId}, got ${row.scope_prefix}`);
                // eslint-disable-next-line no-continue
                continue;
              }
              addProjectionRow(projectionMap, row);
            }
          }
        }
      }

      exportedSites = siteExports.filter((s) => s.status === 'exported' && s.batchId);
      // 4. Build status summary
      const dashboardReady = [];
      const refreshPending = [];
      const importPending = [];
      const skipped = [];
      const noAudit = [];
      const noExport = [];
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
        } else if (s.status === 'no-export') {
          noExport.push(s);
        } else {
          noAudit.push(s);
        }
      }

      let outcome = 'ACTION_REQUIRED';
      if (projectionCheckStatus !== 'ok') {
        outcome = 'CHECKER_UNRELIABLE';
      } else if (noAudit.length === enabledSites.length) {
        outcome = 'NO_AUDITS_FOR_DATE';
      } else if (dashboardReady.length === enabledSites.length) {
        outcome = 'DASHBOARD_READY';
      }

      const lines = [
        `*Agentic Traffic Export + Serving Status — ${dateStr}*`,
        `Outcome: *${outcome}*`,
        `:white_check_mark: Dashboard-ready: *${dashboardReady.length}*`,
        `:arrows_counterclockwise: Refresh Pending: *${refreshPending.length}*`,
        `:hourglass_flowing_sand: Import Pending: *${importPending.length}*`,
        `:warning: Stale Pending: *${stalePendingSites}*`,
        `:grey_question: Unknown: *${unknown.length}*`,
        `:skip: Skipped: *${skipped.length}*`,
        `:x: Failed: *${failed.length}*`,
        `:warning: Missing batchId: *${missingBatchId.length}*`,
        `:mag: Audit without export details: *${noExport.length}*`,
        `Sites checked: *${enabledSites.length}*`,
      ];
      if (projectionCheckStatus === 'ok') {
        lines.push(`Import daily: *${rawImportsProjected}/${exportedSites.length}*`);
        lines.push(`Refresh daily: *${dailyRefreshProjected}/${refreshEnabled ? rawImportsProjected : 0}*`);
        if (weeklyRefreshAvailableCount > 0) {
          lines.push(`Refresh weekly: *${weeklyRefreshProjected}/${weeklyRefreshAvailableCount}*`);
        }
      } else {
        lines.push(`Import daily: unknown (projection audit check ${projectionCheckStatus})`);
      }

      lines.push('', '*Actionable insight:*');
      if (noAudit.length === enabledSites.length) {
        lines.push(`No \`${CDN_LOGS_REPORT_AUDIT}\` audit has run for any of the *${enabledSites.length}* enabled sites for ${dateStr}.`);
        lines.push('Action: run the daily DB import backfill for the target site, or wait for the scheduled audit, then rerun this status check.');
      } else {
        if (dashboardReady.length > 0) {
          lines.push(`${dashboardReady.length} site(s) are dashboard-ready. No action needed for those sites.`);
        }
        if (importPending.length > 0) {
          lines.push(`${importPending.length} site(s) exported data but raw DB import is not visible yet. Action: check projector/import processing for the listed batchId(s).`);
        }
        if (refreshPending.length > 0) {
          lines.push(`${refreshPending.length} site(s) completed raw import but serving refresh is missing. Action: check daily/weekly refresh projection for the listed batchId(s).`);
        }
        if (missingBatchId.length > 0) {
          lines.push(`${missingBatchId.length} site(s) exported without a batchId. Action: check audit-worker dailyAgenticExport output before DB status can be correlated.`);
        }
        if (noExport.length > 0) {
          lines.push(`${noExport.length} site(s) have a \`${CDN_LOGS_REPORT_AUDIT}\` audit, but no agentic DB export batchId to read. Action: check the audit result payload for ${dateStr}.`);
        }
        if (unknown.length > 0) {
          lines.push(`${unknown.length} site(s) have unknown DB status because projection_audit could not be checked. Action: fix/check PostgREST before trusting pending counts.`);
        }
        if (failed.length > 0) {
          lines.push(`${failed.length} export failure(s) found. Action: check the export error before retrying DB import.`);
        }
        if (dateMismatch.length > 0) {
          lines.push(`${dateMismatch.length} site(s) have a latest audit for a different date. Action: run or wait for ${dateStr} before checking DB status.`);
        }
        if (skipped.length > 0) {
          lines.push(`${skipped.length} site(s) were skipped because no traffic data was exported for ${dateStr}.`);
        }
        if (noAudit.length > 0) {
          lines.push(`${noAudit.length} site(s) have no latest audit record. Action: run the daily DB import backfill for specific sites that need investigation.`);
        }
      }

      if (!refreshEnabled) {
        lines.push('_Projector refresh enqueue appears disabled via MYSTICAT_AGENTIC_REFRESH_ENABLED=false._');
      }

      const fullLines = [...lines];
      const addDetailHeader = (header) => {
        lines.push('', header);
        fullLines.push('', header);
      };

      if (dashboardReady.length > 0) {
        addDetailHeader('*Dashboard-ready (raw import + required serving refresh complete):*');
        appendLimitedDetails(lines, dashboardReady, (s) => {
          const daily = refreshEnabled
            ? ` — daily refresh: ${formatRefreshStage(s.dailyRefreshProjection)}`
            : ' — daily refresh: disabled';
          const weekly = s.weeklyRefreshAvailable
            ? ` — weekly refresh: ${formatRefreshStage(s.weeklyRefreshProjection)}`
            : '';
          return [
            `• \`${s.baseURL}\``,
            `  siteId: \`${s.siteId}\``,
            `  import daily: ${formatProjectedStage(s.importProjection, s.importProjectedAt)}`,
            `  export: ${formatExportCounts(s)}`,
            `  ${daily.replace(/^ — /, '')}`,
            weekly ? `  ${weekly.replace(/^ — /, '')}` : '',
          ].filter(Boolean).join('\n');
        }, renderOmittedSites, fullLines);
      }

      if (refreshPending.length > 0) {
        addDetailHeader('*Refresh Pending (raw import projected, serving table refresh not yet seen):*');
        appendLimitedDetails(lines, refreshPending, (s) => {
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
          return [
            `• \`${s.baseURL}\``,
            `  siteId: \`${s.siteId}\``,
            `  import daily: ${formatProjectedStage(s.importProjection, s.importProjectedAt)}`,
            `  ${daily.replace(/^ — /, '')}`,
            weekly ? `  ${weekly.replace(/^ — /, '')}` : '',
            `  missing: ${missing}`,
            `  batchId: \`${s.batchId}\``,
          ].filter(Boolean).join('\n');
        }, renderOmittedSites, fullLines);
      }

      if (importPending.length > 0) {
        addDetailHeader('*Import Pending (export done, raw DB import not yet seen):*');
        appendLimitedDetails(lines, importPending, (s) => {
          const weekly = weeklyRefreshExpected ? ' — weekly refresh: waiting on import' : '';
          return [
            `• \`${s.baseURL}\``,
            `  siteId: \`${s.siteId}\``,
            `  import daily: ${formatPendingStatus(s.importStalePending)}`,
            '  daily refresh: waiting on import',
            weekly ? `  ${weekly.replace(/^ — /, '')}` : '',
            `  batchId: \`${s.batchId}\``,
            `  export: ${formatExportCounts(s)}`,
          ].filter(Boolean).join('\n');
        }, renderOmittedSites, fullLines);
      }

      if (unknown.length > 0) {
        addDetailHeader('*Unknown (projection_audit status could not be checked):*');
        appendLimitedDetails(lines, unknown, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
          `  projection audit check: ${s.projectionCheckStatus}`,
          `  batchId: \`${s.batchId}\``,
          `  export: ${formatExportCounts(s)}`,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (dateMismatch.length > 0) {
        addDetailHeader(`*Latest audit is for a different date (not ${dateStr}):*`);
        appendLimitedDetails(lines, dateMismatch, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
          `  latest export was for ${s.exportedDate}`,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (failed.length > 0) {
        addDetailHeader('*Export failures:*');
        appendLimitedDetails(lines, failed, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
          `  error: ${s.error || 'unknown error'}`,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (missingBatchId.length > 0) {
        addDetailHeader('*Export missing batchId:*');
        appendLimitedDetails(lines, missingBatchId, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
          `  export: ${formatExportCounts(s)}`,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (noExport.length > 0) {
        addDetailHeader('*Audit found without daily agentic export details:*');
        appendLimitedDetails(lines, noExport, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (skipped.length > 0) {
        addDetailHeader(`*Skipped (no traffic data for ${dateStr}):*`);
        appendLimitedDetails(lines, skipped, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
        ].join('\n'), renderOmittedSites, fullLines);
      }

      if (noAudit.length > 0) {
        addDetailHeader('*No audit record found:*');
        appendLimitedDetails(lines, noAudit, (s) => [
          `• \`${s.baseURL}\``,
          `  siteId: \`${s.siteId}\``,
        ].join('\n'), renderOmittedSites, fullLines);
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
