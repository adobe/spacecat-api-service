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

import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';

/**
 * Derives a tri-state scraping status from aggregated scrape-URL counts so the report
 * distinguishes "still running" from "failed". A snapshot taken while many URLs are still
 * PENDING/RUNNING (none COMPLETE yet) must read as in-progress, not failed.
 *
 * Mirrors the same helper in spacecat-task-processor's opportunity-status-processor; kept
 * as a small local copy to avoid a shared-package release. Consolidating both into
 * `@adobe/spacecat-shared-utils` is a reasonable follow-up.
 *
 * @param {{completed: number, failed: number, pending: number, total: number}} [stats]
 * @returns {'available'|'in_progress'|'failed'|'unknown'}
 */
export function deriveScrapingStatus(stats) {
  if (!stats || stats.total === 0) {
    return 'unknown';
  }
  if (stats.completed > 0) {
    return 'available';
  }
  if (stats.pending > 0) {
    return 'in_progress';
  }
  return 'failed';
}

/**
 * Aggregates scrape-URL statuses for a site's current onboarding session.
 *
 * Only jobs created at/after `lastStartTime` are counted, so stale jobs from previous
 * onboardings don't bleed in. Non-terminal URLs (PENDING/RUNNING) are counted separately
 * so a still-running scrape reads as in-progress rather than failed.
 *
 * @param {string} baseURL - Site base URL (scrape jobs are keyed by base URL)
 * @param {number|undefined} lastStartTime - Onboard start timestamp (ms); unset = no filter
 * @param {object} context - Context with env/log for ScrapeClient
 * @returns {Promise<{completed:number, failed:number, pending:number, total:number}|null>}
 *   null when no scrape jobs exist for this onboarding session.
 */
export async function getScrapingStats(baseURL, lastStartTime, context) {
  const scrapeClient = ScrapeClient.createFrom(context);
  const jobs = await scrapeClient.getScrapeJobsByBaseURL(baseURL, 'default');
  if (!jobs || jobs.length === 0) {
    return null;
  }

  const relevantJobs = lastStartTime
    ? jobs.filter(
      (job) => new Date(job.startedAt || job.createdAt || 0).getTime() >= lastStartTime,
    )
    : jobs;
  if (relevantJobs.length === 0) {
    return null;
  }

  const allUrlResults = [];
  /* eslint-disable no-await-in-loop */
  for (const job of relevantJobs) {
    const results = await scrapeClient.getScrapeJobUrlResults(job.id);
    if (results && results.length > 0) {
      allUrlResults.push(...results);
    }
  }
  /* eslint-enable no-await-in-loop */

  if (allUrlResults.length === 0) {
    return null;
  }

  const countByStatus = (status) => allUrlResults.filter((r) => r.status === status).length;
  return {
    completed: countByStatus('COMPLETE'),
    failed: countByStatus('FAILED'),
    pending: allUrlResults.filter(
      (r) => r.status === 'PENDING' || r.status === 'RUNNING',
    ).length,
    total: allUrlResults.length,
  };
}

/**
 * Builds the Slack lines for the scraping section of `onboard status`, or null when there
 * is no scrape data yet. Best-effort: never throws — a scrape-client failure yields null so
 * the command still renders opportunity statuses.
 *
 * @param {string} baseURL
 * @param {number|undefined} lastStartTime
 * @param {object} context
 * @returns {Promise<{statsMessage: string, dataSourceLine: string}|null>}
 */
export async function buildScrapingSection(baseURL, lastStartTime, context) {
  const { log } = context;
  try {
    const stats = await getScrapingStats(baseURL, lastStartTime, context);
    const status = deriveScrapingStatus(stats);
    // 'unknown' (no scrape data yet) shows a neutral info icon — not ❌ (which would
    // falsely read as failed on an early snapshot) and not ⏳ (which would overclaim
    // active progress). Only a genuinely terminal-failed scrape (0 completed, 0 pending,
    // >0 failed) shows ❌.
    const emoji = {
      available: ':white_check_mark:',
      in_progress: ':hourglass_flowing_sand:',
      unknown: ':information_source:',
      failed: ':x:',
    }[status] || ':x:';

    if (!stats) {
      return {
        statsMessage: `:mag: *Scraping Statistics for ${baseURL}*\n`
          + ':information_source: _Scraping is in progress or no results available yet._',
        dataSourceLine: `Scraping ${emoji}`,
      };
    }

    const pendingLine = stats.pending > 0 ? `⏳ In progress: ${stats.pending}\n` : '';
    const statsMessage = `:mag: *Scraping Statistics for ${baseURL}*\n`
      + `✅ Completed: ${stats.completed}\n`
      + `❌ Failed: ${stats.failed}\n${
        pendingLine
      }📊 Total: ${stats.total}`;
    return { statsMessage, dataSourceLine: `Scraping ${emoji}` };
  } catch (error) {
    log?.warn(`[onboard-status] Could not compute scraping stats for ${baseURL}: ${error.message}`);
    return null;
  }
}
