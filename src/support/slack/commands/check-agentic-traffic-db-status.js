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
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check agentic traffic db status'];
const CDN_LOGS_REPORT_AUDIT = 'cdn-logs-report';
const AGENTIC_TRAFFIC_HANDLER = 'wrpc_import_agentic_traffic';
const BATCH_SIZE = 10;

const pad2 = (n) => String(n).padStart(2, '0');

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
    usageText: `${PHRASES[0]} [YYYY-MM-DD]`,
  });

  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [dateArg] = args;
      let targetDate;
      if (dateArg) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
        targetDate = new Date(`${dateArg}T00:00:00Z`);
        if (Number.isNaN(targetDate.getTime())) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = new Date();
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }

      const dateStr = `${targetDate.getUTCFullYear()}-${pad2(targetDate.getUTCMonth() + 1)}-${pad2(targetDate.getUTCDate())}`;

      await say(`:hourglass_flowing_sand: Checking agentic traffic export + projection status for *${dateStr}*...`);

      // 1. Find all sites with cdn-logs-report enabled (those run the daily agentic export)
      const [allSites, configuration] = await Promise.all([
        Site.all(),
        Configuration.findLatest(),
      ]);
      const enabledSites = allSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_REPORT_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(':information_source: No sites have cdn-logs-report enabled.');
        return;
      }

      await say(`:gear: Checking ${enabledSites.length} sites with cdn-logs-report enabled...`);

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

            return {
              siteId,
              baseURL,
              status: 'exported',
              trafficDate: dailyExport.trafficDate,
              batchId: dailyExport.batchId,
              rowCount: dailyExport.rowCount,
              classificationCount: dailyExport.classificationCount,
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

      const projectionMap = new Map();
      const postgrestClient = dataAccess?.services?.postgrestClient;

      if (batchIds.length > 0 && postgrestClient?.from) {
        const { data: projRows, error: projError } = await postgrestClient
          .from('projection_audit')
          .select('correlation_id,scope_prefix,output_count,projected_at,skipped')
          .in('correlation_id', batchIds)
          .eq('handler_name', AGENTIC_TRAFFIC_HANDLER)
          .order('projected_at', { ascending: false });

        if (projError) {
          log.warn(`projection_audit query failed: ${projError.message}`);
        } else {
          for (const row of projRows || []) {
            projectionMap.set(row.correlation_id, row);
          }
        }
      }

      // 4. Build status summary
      const projected = [];
      const pending = [];
      const skipped = [];
      const noAudit = [];
      const failed = [];
      const dateMismatch = [];

      for (const s of siteExports) {
        if (s.status === 'exported') {
          const proj = projectionMap.get(s.batchId);
          if (proj) {
            const projAt = new Date(proj.projected_at).toISOString().slice(0, 16).replace('T', ' ');
            projected.push({ ...s, outputCount: proj.output_count, projectedAt: projAt });
          } else {
            pending.push(s);
          }
        } else if (s.status === 'skipped') {
          skipped.push(s);
        } else if (s.status === 'date-mismatch') {
          dateMismatch.push(s);
        } else if (s.status === 'export-failed' || s.status === 'error') {
          failed.push(s);
        } else {
          noAudit.push(s);
        }
      }

      const lines = [
        `*Agentic Traffic Export + Projection Status — ${dateStr}*`,
        `:white_check_mark: Projected: *${projected.length}*  :hourglass_flowing_sand: Pending: *${pending.length}*  :skip: Skipped: *${skipped.length}*  :x: Failed: *${failed.length}*  (${enabledSites.length} sites total)`,
      ];

      if (projected.length > 0) {
        lines.push('', '*Projected (export → DB complete):*');
        for (const s of projected) {
          lines.push(`• \`${s.baseURL}\` — rows: ${s.rowCount} exported / ${s.outputCount} projected — at ${s.projectedAt}`);
        }
      }

      if (pending.length > 0) {
        lines.push('', '*Pending (export done, projection not yet seen):*');
        for (const s of pending) {
          lines.push(`• \`${s.baseURL}\` (${s.siteId}) — batchId: \`${s.batchId}\` — ${s.rowCount} rows`);
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

      // Chunk output to respect Slack's message length limits
      const CHUNK_LIMIT = 2800;
      const fullText = lines.join('\n');
      if (fullText.length <= CHUNK_LIMIT) {
        await say(fullText);
      } else {
        let chunk = '';
        for (const line of lines) {
          if (chunk.length + line.length + 1 > CHUNK_LIMIT) {
            // eslint-disable-next-line no-await-in-loop
            await say(chunk.trim());
            chunk = '';
          }
          chunk += `${line}\n`;
        }
        if (chunk.trim()) await say(chunk.trim());
      }
    } catch (error) {
      log.error('Error in check-agentic-traffic-db-status:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default CheckAgenticTrafficDbStatusCommand;
