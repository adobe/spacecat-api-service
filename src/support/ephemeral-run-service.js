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

import { randomUUID } from 'crypto';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  getLastNumberOfWeeks, getDateRanges, composeBaseURL, getStoredMetrics,
} from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  triggerImportRun,
  sendAuditMessage,
  sanitizeExecutionName,
} from './utils.js';
import { writeBatchManifest, writeSiteResult, BATCH_TTL_DAYS } from './ephemeral-run-batch-store.js';

const sfnClient = new SFNClient();

/** Import type key for traffic-analysis jobs and backfill. */
const TRAFFIC_ANALYSIS_IMPORT_TYPE = 'traffic-analysis';

/** Option key for how many weeks of traffic-analysis backfill to queue. */
const TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY = 'backfillWeeks';

const SCRAPE_AUDIT_TYPE = 'scrape-top-pages';
const SCRAPE_FRESHNESS_DAYS = 30;
const AUDIT_FRESHNESS_DAYS = 7;
const IMPORT_FRESHNESS_DAYS = 7;

/**
 * Maps import type → S3 metrics config { source, metric }.
 * top-pages freshness is checked via SiteTopPage.importedAt instead of S3.
 */
const IMPORT_METRICS_SOURCE_MAP = {
  'organic-traffic': { source: 'seo', metric: 'organic-traffic' },
  'organic-keywords': { source: 'seo', metric: 'organic-keywords' },
  'organic-keywords-nonbranded': { source: 'seo', metric: 'organic-keywords-nonbranded' },
  'ahref-paid-pages': { source: 'seo', metric: 'paid-pages' },
  'latest-metrics': { source: 'seo', metric: 'latest-metrics' },
  'all-traffic': { source: 'rum', metric: 'all-traffic' },
};

/** S3 prefix root for traffic-analysis Parquet partitions. */
const TRAFFIC_ANALYSIS_S3_PREFIX = 'rum-metrics-compact/data';

/**
 * Preset / request `imports` may include:
 * - `types`: string[]
 * - `optionsByImportType`: map of import type → options object (shallow merge per type; body wins).
 *   Example: `optionsByImportType['traffic-analysis'] = { backfillWeeks: 5 }`.
 * Add sibling keys under an import type when that import gains more tunables.
 *
 * Legacy: top-level `imports.trafficAnalysisWeeks` still overrides traffic-analysis backfill weeks.
 */

const DEFAULT_TRAFFIC_ANALYSIS_BACKFILL_WEEKS = 52;
const DEFAULT_TEARDOWN_DELAY_SECONDS = 14400; // 4 hours
const MAX_TEARDOWN_DELAY_SECONDS = 86400; // 24 hours
const MAX_BATCH_SITES = 1000;

function resolveImports(bodyImports) {
  const types = bodyImports?.types ?? [];
  let optionsByImportType = { ...(bodyImports?.optionsByImportType || {}) };

  const explicitLegacyTaWeeks = bodyImports
    && Object.prototype.hasOwnProperty.call(bodyImports, 'trafficAnalysisWeeks');
  if (explicitLegacyTaWeeks) {
    const prev = optionsByImportType[TRAFFIC_ANALYSIS_IMPORT_TYPE] || {};
    optionsByImportType = {
      ...optionsByImportType,
      [TRAFFIC_ANALYSIS_IMPORT_TYPE]: {
        ...prev,
        [TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY]: bodyImports.trafficAnalysisWeeks,
      },
    };
  }

  const taBodyOpts = bodyImports?.optionsByImportType?.[TRAFFIC_ANALYSIS_IMPORT_TYPE];
  const explicitNestedTaWeeks = taBodyOpts
    && Object.prototype.hasOwnProperty.call(taBodyOpts, TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY);
  const explicitTaWeeks = explicitLegacyTaWeeks || explicitNestedTaWeeks;

  let trafficAnalysisWeeks = optionsByImportType[TRAFFIC_ANALYSIS_IMPORT_TYPE]
    ?.[TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY] ?? 0;

  if (!types.includes(TRAFFIC_ANALYSIS_IMPORT_TYPE)) {
    trafficAnalysisWeeks = 0;
  } else if (trafficAnalysisWeeks === 0 && !explicitTaWeeks) {
    trafficAnalysisWeeks = DEFAULT_TRAFFIC_ANALYSIS_BACKFILL_WEEKS;
    const prev = optionsByImportType[TRAFFIC_ANALYSIS_IMPORT_TYPE] || {};
    optionsByImportType = {
      ...optionsByImportType,
      [TRAFFIC_ANALYSIS_IMPORT_TYPE]: {
        ...prev,
        [TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY]: trafficAnalysisWeeks,
      },
    };
  }

  return {
    types,
    optionsByImportType,
    trafficAnalysisWeeks,
  };
}

function resolvePayload(body) {
  const imports = resolveImports(body.imports);

  const audits = {
    types: body.audits?.types ?? [],
  };

  const rawDelay = body.teardown?.delaySeconds ?? DEFAULT_TEARDOWN_DELAY_SECONDS;
  const teardownDelaySeconds = Math.min(
    Math.max(0, rawDelay),
    MAX_TEARDOWN_DELAY_SECONDS,
  );

  const forceRun = body.forceRun === true;
  const forceRunSiteIds = new Set(
    Array.isArray(body.forceRunSiteIds) ? body.forceRunSiteIds : [],
  );
  const scheduledRun = body.scheduledRun === true;
  const onDemand = body.onDemand === true;

  const scrapeFreshnessDays = typeof body.freshness?.scrapeDays === 'number'
    ? body.freshness.scrapeDays
    : SCRAPE_FRESHNESS_DAYS;
  const auditFreshnessDays = typeof body.freshness?.auditDays === 'number'
    ? body.freshness.auditDays
    : AUDIT_FRESHNESS_DAYS;
  const importFreshnessDays = typeof body.freshness?.importDays === 'number'
    ? body.freshness.importDays
    : IMPORT_FRESHNESS_DAYS;

  return {
    imports,
    audits,
    teardownDelaySeconds,
    forceRun,
    forceRunSiteIds,
    scheduledRun,
    onDemand,
    scrapeFreshnessDays,
    auditFreshnessDays,
    importFreshnessDays,
  };
}

function isImportEnabled(importType, imports) {
  const found = imports?.find((cfg) => cfg.type === importType);
  return found ? found.enabled : false;
}

/**
 * Maps audit types to configuration handler flags that must be enabled for the audit
 * to function fully. These are feature flags checked at runtime inside the audit handler
 * — not standalone SQS audit types and not enqueued as separate messages.
 */
const AUDIT_HANDLER_FLAGS = {
  'lhs-mobile': ['security-csp', 'security-csp-auto-suggest'],
};

/**
 * Returns true if the site has a completed scrape job (processingType 'default') that started
 * within the last SCRAPE_FRESHNESS_DAYS days.
 *
 * scrape-top-pages goes to ScrapeClient → spacecat-content-scraper, not the audit pipeline,
 * so LatestAudit never has a scrape-top-pages record. The correct freshness signal is the
 * most recent ScrapeJob for the site's top pages baseURL with processingType 'default'.
 *
 * The baseURL stored on ScrapeJob is derived via composeBaseURL(new URL(url).host) from the
 * first top page URL — so we must apply the same normalization here to match the indexed value.
 */
async function isScrapeRecent(
  siteId,
  dataAccess,
  log,
  scrapeFreshnessDays = SCRAPE_FRESHNESS_DAYS,
) {
  try {
    const { Site, ScrapeJob } = dataAccess;
    const site = await Site.findById(siteId);
    if (!site) return false;
    const topPages = await site.getSiteTopPagesBySourceAndGeo('seo', 'global');
    if (!topPages || topPages.length === 0) return false;
    const baseURL = composeBaseURL(new URL(topPages[0].getUrl()).host);
    const jobs = await ScrapeJob.allByBaseURLAndProcessingType(baseURL, 'default');
    if (!jobs || jobs.length === 0) return false;
    const latestStartedAt = Math.max(...jobs.map((j) => new Date(j.getStartedAt()).getTime()));
    const ageInDays = (Date.now() - latestStartedAt) / (1000 * 60 * 60 * 24);
    return ageInDays < scrapeFreshnessDays;
  } catch (err) {
    log.warn(`Failed to check scrape freshness for site ${siteId}:`, err);
    return false;
  }
}

/**
 * Returns true if a traffic-analysis Parquet file exists in S3 for the last
 * completed ISO calendar week (mirrors the import worker's getLastFullCalendarWeek logic).
 *
 * S3 path: rum-metrics-compact/data/siteid={siteId}/year={Y}/month={M}/week={W}/data.parquet
 *
 * A week can span two calendar months (e.g. Mon Jan 27 – Sun Feb 2). The import worker
 * writes one file per month segment, so we compute the Monday and Sunday of the target
 * week to determine the exact month(s) and make 1–2 targeted ListObjectsV2 calls
 * with MaxKeys=1 — no pagination, no key scanning.
 */
async function isTrafficAnalysisWeekPresent(siteId, week, year, context) {
  const { s3 } = context;
  const { s3Client, s3Bucket, ListObjectsV2Command } = s3;
  const dateRanges = getDateRanges(week, year);
  const paddedWeek = String(week).padStart(2, '0');
  for (const { year: y, month: m } of dateRanges) {
    const paddedMonth = String(m).padStart(2, '0');
    const prefix = `${TRAFFIC_ANALYSIS_S3_PREFIX}/siteid=${siteId}/year=${y}/month=${paddedMonth}/week=${paddedWeek}/`;
    // eslint-disable-next-line no-await-in-loop
    const resp = await s3Client.send(
      new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: prefix, MaxKeys: 1 }),
    );
    if ((resp.Contents || []).length > 0) return true;
  }
  return false;
}

/**
 * Returns only the {week, year} pairs from the last weekCount weeks that have no Parquet
 * file in S3. Weeks where the check itself fails are treated as missing (fail-open) so
 * transient S3 errors never silently suppress a needed import run.
 */
async function getMissingTrafficAnalysisWeeks(siteId, weekCount, context, log) {
  const weekYearPairs = getLastNumberOfWeeks(weekCount);
  const results = await Promise.all(
    weekYearPairs.map(async ({ week, year }) => {
      try {
        const present = await isTrafficAnalysisWeekPresent(siteId, week, year, context);
        return { week, year, present };
      } catch (err) {
        log.warn(`Failed to check traffic-analysis week ${week}/${year} for site ${siteId}:`, err);
        return { week, year, present: false };
      }
    }),
  );
  return results.filter((r) => !r.present).map(({ week, year }) => ({ week, year }));
}

/**
 * Returns true if the given import type has data fetched within freshnessDay days.
 *
 * - top-pages: checks SiteTopPage.importedAt via getSiteTopPagesBySourceAndGeo('seo', 'global')
 * - traffic-analysis: lists S3 Parquet partitions and checks the latest ISO week end date
 * - all others: reads the S3 metrics JSON file and checks the latest `time` field.
 *
 * Returns false when no data exists (so the import will run).
 */
// eslint-disable-next-line max-len
async function isImportFresh(siteId, importType, site, context, log, freshnessDay = IMPORT_FRESHNESS_DAYS) {
  try {
    if (importType === 'top-pages') {
      const topPages = await site.getSiteTopPagesBySourceAndGeo('seo', 'global');
      if (!topPages || topPages.length === 0) return false;
      const latestImportedAt = topPages
        .map((p) => p.getImportedAt?.() ?? p.importedAt)
        .filter(Boolean)
        .sort()
        .reverse()[0];
      if (!latestImportedAt) return false;
      const ageInDays = (Date.now() - new Date(latestImportedAt).getTime()) / (1000 * 60 * 60 * 24);
      return ageInDays < freshnessDay;
    }

    if (importType === TRAFFIC_ANALYSIS_IMPORT_TYPE) {
      const [{ week, year }] = getLastNumberOfWeeks(1);
      return isTrafficAnalysisWeekPresent(siteId, week, year, context);
    }

    const metricsConfig = IMPORT_METRICS_SOURCE_MAP[importType];
    if (!metricsConfig) return false;

    const records = await getStoredMetrics({ siteId, ...metricsConfig }, context);
    if (!records || records.length === 0) return false;

    const latestTime = records
      .map((r) => r.time ?? r.importTime ?? r.importedAt)
      .filter(Boolean)
      .sort()
      .reverse()[0];
    if (!latestTime) return false;

    const ageInDays = (Date.now() - new Date(latestTime).getTime()) / (1000 * 60 * 60 * 24);
    return ageInDays < freshnessDay;
  } catch (err) {
    log.warn(`Failed to check import freshness for site ${siteId}, type ${importType}:`, err);
    return false;
  }
}

/**
 * Returns a Set of import types that should be skipped for this site.
 *
 * Skip rule: skip if data was fetched within freshnessDay days AND data exists.
 * Always run if forceRun is true or if there is no existing data.
 */
async function getImportTypesToSkipForSite(
  siteId,
  importTypes,
  site,
  context,
  log,
  forceRun = false,
  freshnessDay = IMPORT_FRESHNESS_DAYS,
  trafficAnalysisWeeks = 0,
) {
  if (forceRun) {
    log.info(`Site ${siteId}: forceRun=true — skipping all import freshness checks`);
    return new Set();
  }

  // traffic-analysis in backfill mode is handled per-week by getMissingTrafficAnalysisWeeks
  const typesToCheck = trafficAnalysisWeeks > 0
    ? importTypes.filter((t) => t !== TRAFFIC_ANALYSIS_IMPORT_TYPE)
    : importTypes;

  const skip = new Set();
  await Promise.all(typesToCheck.map(async (importType) => {
    const fresh = await isImportFresh(siteId, importType, site, context, log, freshnessDay);
    if (fresh) {
      log.info(`Site ${siteId}: skipping import ${importType} — data fetched within ${freshnessDay} days`);
      skip.add(importType);
    }
  }));
  return skip;
}

/**
 * Maps auto-suggest audit types to their parent audit type.
 * Auto-suggest audits do not produce LatestAudit records of their own, so freshness
 * is derived from the parent: if the parent was skipped as fresh, the child is too.
 */
const AUTO_SUGGEST_PARENT_MAP = {
  'broken-backlinks-auto-suggest': 'broken-backlinks',
  'broken-internal-links-auto-suggest': 'broken-internal-links',
  'cwv-auto-suggest': 'cwv',
  'meta-tags-auto-suggest': 'meta-tags',
  'alt-text-auto-suggest-mystique': 'alt-text',
  'security-vulnerabilities-auto-suggest': 'security-vulnerabilities',
};

/**
 * Returns a Set of audit types that should be skipped from SQS enqueue for
 * this site. Audit types are still enabled in Configuration (Phase 1) —
 * only the SQS message is suppressed.
 *
 * Returns an empty Set immediately when forceRun is true (bypass all checks).
 *
 * Skip rules:
 * - scrape-top-pages: skip if site has a scrape result within scrapeFreshnessDays
 * - auto-suggest types: skip if their parent audit was skipped as fresh (they have no
 *   LatestAudit records of their own)
 * - all others: query LatestAudit.findById(siteId, auditType) and check auditedAt.
 *   If no LatestAudit record exists → always run.
 */
async function getAuditTypesToSkipForSite(
  siteId,
  auditTypes,
  dataAccess,
  log,
  forceRun = false,
  scrapeFreshnessDays = SCRAPE_FRESHNESS_DAYS,
  auditFreshnessDays = AUDIT_FRESHNESS_DAYS,
) {
  if (forceRun) {
    log.info(`Site ${siteId}: forceRun=true — skipping all freshness checks`);
    return new Set();
  }

  const { LatestAudit } = dataAccess;
  const hasScrapeAudit = auditTypes.includes(SCRAPE_AUDIT_TYPE);
  // Auto-suggest types have no LatestAudit records — handled via parent propagation
  const autoSuggestTypes = auditTypes.filter((t) => AUTO_SUGGEST_PARENT_MAP[t]);
  const checkableTypes = auditTypes.filter(
    (t) => t !== SCRAPE_AUDIT_TYPE && !AUTO_SUGGEST_PARENT_MAP[t],
  );
  const freshnessThresholdMs = auditFreshnessDays * 24 * 60 * 60 * 1000;

  const [scrapeRecent, ...latestAudits] = await Promise.all([
    hasScrapeAudit
      ? isScrapeRecent(siteId, dataAccess, log, scrapeFreshnessDays)
      : Promise.resolve(false),
    ...checkableTypes.map((auditType) => LatestAudit.findById(siteId, auditType).catch((err) => {
      log.warn(`Failed to fetch latest audit for site ${siteId}, type ${auditType}:`, err);
      return null;
    })),
  ]);

  const skip = new Set();

  if (hasScrapeAudit && scrapeRecent) {
    log.info(`Site ${siteId}: skipping SQS enqueue for ${SCRAPE_AUDIT_TYPE} — scrape within ${scrapeFreshnessDays} days`);
    skip.add(SCRAPE_AUDIT_TYPE);
  }

  checkableTypes.forEach((auditType, i) => {
    const latestAudit = latestAudits[i];
    if (!latestAudit) return; // no record → always run
    const ageInMs = Date.now() - new Date(latestAudit.getAuditedAt()).getTime();
    if (ageInMs < freshnessThresholdMs) {
      log.info(`Site ${siteId}: skipping SQS enqueue for ${auditType} — audit ran within ${auditFreshnessDays} days`);
      skip.add(auditType);
    }
  });

  // Auto-suggest types: skip if their parent was skipped as fresh
  autoSuggestTypes.forEach((auditType) => {
    const parent = AUTO_SUGGEST_PARENT_MAP[auditType];
    if (skip.has(parent)) {
      log.info(`Site ${siteId}: skipping SQS enqueue for ${auditType} — parent ${parent} is fresh`);
      skip.add(auditType);
    }
  });

  return skip;
}

function deltaEnableImports(site, importTypes) {
  const siteConfig = site.getConfig();
  const imports = siteConfig.getImports();
  const importsEnabled = [];
  const importsAlreadyEnabled = [];

  for (const importType of importTypes) {
    if (isImportEnabled(importType, imports)) {
      importsAlreadyEnabled.push(importType);
    } else {
      siteConfig.enableImport(importType);
      importsEnabled.push(importType);
    }
  }

  return { importsEnabled, importsAlreadyEnabled };
}

function deltaEnableAudits(configuration, site, auditTypes) {
  const auditsEnabled = [];
  const auditsAlreadyEnabled = [];

  for (const auditType of auditTypes) {
    if (configuration.isHandlerEnabledForSite(auditType, site)) {
      auditsAlreadyEnabled.push(auditType);
    } else {
      configuration.enableHandlerForSite(auditType, site);
      auditsEnabled.push(auditType);
    }
  }

  return { auditsEnabled, auditsAlreadyEnabled };
}

async function rollbackImports(Site, perSiteSetup, log) {
  for (const [siteId, setup] of Object.entries(perSiteSetup)) {
    if (setup.importsEnabled.length > 0) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const site = await Site.findById(siteId);
        if (site) {
          const siteConfig = site.getConfig();
          for (const importType of setup.importsEnabled) {
            siteConfig.disableImport(importType);
          }
          site.setConfig(Config.toDynamoItem(site.getConfig()));
          // eslint-disable-next-line no-await-in-loop
          await site.save();
        }
      } catch (err) {
        log.error(`Failed to rollback imports for site ${siteId}`, err);
      }
    }
  }
}

function getStateMachineArn(env) {
  return env.EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN;
}

const EMPTY_SLACK_CONTEXT = { channelId: '', threadTs: '' };

/**
 * Builds the input payload for the ephemeral-run-teardown-workflow Step Function.
 * Sends a single bulk-disable-import-audit-processor job covering all sites,
 * so the task-processor can load Configuration once and save it once.
 */
function buildTeardownWorkflowInput({
  sites,
  slackContext = EMPTY_SLACK_CONTEXT,
  scheduledRun = false,
  workflowWaitTime,
}) {
  const slack = { channelId: slackContext.channelId ?? '', threadTs: slackContext.threadTs ?? '' };

  const bulkDisableJob = {
    type: 'bulk-disable-import-audit-processor',
    sites,
    taskContext: {
      scheduledRun,
      slackContext: slack,
    },
  };

  return { bulkDisableJob, workflowWaitTime };
}

/**
 * Slack context for ephemeral-run teardown (Step Functions) and audit enqueue.
 * Defaults to environment variables; API payload `slack` field overrides individual fields.
 */
function ephemeralRunWorkflowSlackContext(env, payloadSlack = {}) {
  return {
    channelId: payloadSlack.channelId || env.EPHEMERAL_RUN_WORKFLOW_SLACK_CHANNEL_ID || '',
    threadTs: payloadSlack.threadTs
      || env.EPHEMERAL_RUN_WORKFLOW_SLACK_THREAD_TS
      || env.INSIGHTS_WORKFLOW_SLACK_THREAD_TS
      || '',
  };
}

async function scheduleTeardown(params) {
  const {
    batchId,
    sites,
    delaySeconds,
    slackContext,
    env,
    log,
  } = params;

  const stateMachineArn = getStateMachineArn(env);
  if (!stateMachineArn) {
    throw new Error(
      'Ephemeral run teardown requires EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN',
    );
  }

  // API delay is 0..MAX; 0 means use WORKFLOW_WAIT_TIME_IN_SECONDS (operational default).
  const rawWait = delaySeconds === 0
    ? env.WORKFLOW_WAIT_TIME_IN_SECONDS
    : delaySeconds;
  if (rawWait == null || rawWait === '') {
    throw new Error(
      'Ephemeral run teardown requires a positive teardown.delaySeconds or env WORKFLOW_WAIT_TIME_IN_SECONDS '
      + '(delaySeconds 0 defers to WORKFLOW_WAIT_TIME_IN_SECONDS)',
    );
  }
  const workflowWaitTime = Number(rawWait);
  if (!Number.isFinite(workflowWaitTime) || workflowWaitTime < 0) {
    throw new Error('Workflow wait time must be a finite non-negative number');
  }

  const workflowInput = buildTeardownWorkflowInput({
    sites,
    slackContext,
    scheduledRun: false,
    workflowWaitTime,
  });

  const workflowName = sanitizeExecutionName(`ephemeral-run-teardown-${batchId}`);

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn,
    input: JSON.stringify(workflowInput),
    name: workflowName,
  }));

  log.info(`Scheduled teardown for ${sites.length} site(s), workflowWaitTime=${workflowWaitTime}s`);

  return {
    mode: 'deferred',
    delaySeconds: workflowWaitTime,
    disableAfter: new Date(Date.now() + workflowWaitTime * 1000).toISOString(),
    scheduled: true,
  };
}

// ---------------------------------------------------------------------------
// Job enqueuing (ephemeral run batch)
// ---------------------------------------------------------------------------

async function enqueueSiteJobs(
  siteId,
  resolvedPayload,
  configuration,
  context,
  slackContext = { channelId: '', threadTs: '' },
  onDemand = false,
) {
  const { log, env } = context;
  const { imports, audits } = resolvedPayload;
  const enqueued = { imports: [], audits: [] };
  const skipped = [];

  const { trafficAnalysisWeekYearPairs } = imports;
  // When specific pairs are provided (per-week freshness from batch run), use those.
  // Fall back to trafficAnalysisWeeks count for direct callers (e.g. Slack commands).
  const trafficAnalysisHandledByBackfill = trafficAnalysisWeekYearPairs !== undefined
    ? trafficAnalysisWeekYearPairs.length > 0
    : imports.trafficAnalysisWeeks > 0;

  for (const importType of imports.types) {
    // Exclude traffic-analysis from the single-message path when backfill or per-week pairs apply
    if (importType === TRAFFIC_ANALYSIS_IMPORT_TYPE
      && (trafficAnalysisWeekYearPairs !== undefined || imports.trafficAnalysisWeeks > 0)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await triggerImportRun(
        configuration,
        importType,
        siteId,
        undefined,
        undefined,
        slackContext,
        context,
      );
      enqueued.imports.push({ type: importType, status: 'queued' });
    } catch (e) {
      log.error(`Failed to enqueue import ${importType} for site ${siteId}`, e);
      skipped.push({ type: importType, kind: 'import', reason: e.message });
    }
  }

  if (trafficAnalysisHandledByBackfill) {
    const pairsToRun = trafficAnalysisWeekYearPairs
      ?? getLastNumberOfWeeks(imports.trafficAnalysisWeeks);
    try {
      await Promise.all(
        pairsToRun.map(({ week, year }) => context.sqs.sendMessage(
          configuration.getQueues().imports,
          {
            type: TRAFFIC_ANALYSIS_IMPORT_TYPE,
            trigger: 'backfill',
            siteId,
            week,
            year,
          },
        )),
      );
      for (const { week, year } of pairsToRun) {
        enqueued.imports.push({
          type: TRAFFIC_ANALYSIS_IMPORT_TYPE, status: 'queued', week, year,
        });
      }
    } catch (e) {
      log.error(`Failed to enqueue traffic-analysis backfill for site ${siteId}`, e);
      skipped.push({ type: 'traffic-analysis', kind: 'import', reason: e.message });
    }
  }

  // scrape-top-pages goes to the scraping pipeline (ScrapeClient), not the audit queue
  if (audits.types.includes(SCRAPE_AUDIT_TYPE)) {
    try {
      const { Site } = context.dataAccess;
      const site = await Site.findById(siteId);
      if (!site) {
        log.warn(`Site ${siteId}: not found, skipping ${SCRAPE_AUDIT_TYPE}`);
        skipped.push({ type: SCRAPE_AUDIT_TYPE, kind: 'audit', reason: 'Site not found' });
      } else {
        const topPages = (await site.getSiteTopPagesBySourceAndGeo('seo', 'global')) || [];
        if (topPages.length === 0) {
          log.warn(`Site ${siteId}: no top pages found, skipping ${SCRAPE_AUDIT_TYPE}`);
          skipped.push({ type: SCRAPE_AUDIT_TYPE, kind: 'audit', reason: 'No top pages found' });
        } else {
          const urls = topPages.map((page) => page.getUrl());
          // allow injection via context for testability, fall back to creating from context
          const scrapeClient = context.scrapeClient ?? ScrapeClient.createFrom(context);
          await scrapeClient.createScrapeJob({
            processingType: 'default',
            urls,
            maxScrapeAge: 0,
            metaData: {
              slackData: {
                channel: slackContext.channelId ?? '',
                thread_ts: slackContext.threadTs ?? '',
              },
            },
          });
          enqueued.audits.push({ type: SCRAPE_AUDIT_TYPE, status: 'queued' });
        }
      }
    } catch (e) {
      log.error(`Failed to enqueue ${SCRAPE_AUDIT_TYPE} for site ${siteId}`, e);
      skipped.push({ type: SCRAPE_AUDIT_TYPE, kind: 'audit', reason: e.message });
    }
  }

  const nonScrapeTypes = audits.types.filter((t) => t !== SCRAPE_AUDIT_TYPE);
  const auditQueueUrl = env.AUDIT_JOBS_QUEUE_URL;
  const auditContext = {
    onDemand,
    slackContext: {
      channelId: slackContext.channelId ?? '',
      threadTs: slackContext.threadTs ?? '',
    },
  };
  if (nonScrapeTypes.length > 0 && !auditQueueUrl) {
    log.error('No audit queue URL: set env AUDIT_JOBS_QUEUE_URL');
    for (const auditType of nonScrapeTypes) {
      skipped.push({
        type: auditType,
        kind: 'audit',
        reason: 'Missing audit jobs queue URL',
      });
    }
  } else {
    for (const auditType of nonScrapeTypes) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendAuditMessage(context.sqs, auditQueueUrl, auditType, auditContext, siteId);
        enqueued.audits.push({ type: auditType, status: 'queued' });
      } catch (e) {
        log.error(`Failed to enqueue audit ${auditType} for site ${siteId}`, e);
        skipped.push({ type: auditType, kind: 'audit', reason: e.message });
      }
    }
  }

  return { enqueued, skipped };
}

// ---------------------------------------------------------------------------
// Batch endpoint (POST handler)
// ---------------------------------------------------------------------------

export async function runEphemeralRunBatch(siteIds, body, context) {
  const {
    dataAccess, s3, env, log,
  } = context;
  const {
    Site, Configuration, LatestAudit, ScrapeJob,
  } = dataAccess;
  const batchId = randomUUID();
  const uniqueSiteIds = [...new Set(siteIds)];
  const effectiveSiteIds = uniqueSiteIds.slice(0, MAX_BATCH_SITES);

  const {
    imports,
    audits,
    teardownDelaySeconds,
    forceRun,
    forceRunSiteIds,
    scheduledRun,
    onDemand,
    scrapeFreshnessDays,
    auditFreshnessDays,
    importFreshnessDays,
  } = resolvePayload(body);
  const auditTypes = audits.types;
  const workflowSlackContext = ephemeralRunWorkflowSlackContext(env, body.slack);
  const configuration = await Configuration.findLatest();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + BATCH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await writeBatchManifest(s3, batchId, {
    batchId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    totalSites: effectiveSiteIds.length,
    enqueuedSiteIds: effectiveSiteIds,
    failedToEnqueue: [],
    jobsPlan: {
      imports: {
        types: imports.types,
        trafficAnalysisWeeks: imports.trafficAnalysisWeeks,
      },
      audits: {
        types: audits.types,
      },
      teardownDelaySeconds,
    },
    payload: {
      imports: body.imports,
      audits: body.audits,
      teardown: body.teardown,
    },
  });

  // Phase 1: Sequential delta-enable for all sites
  const perSiteSetup = {};
  for (const siteId of effectiveSiteIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const site = await Site.findById(siteId);
      if (!site) {
        // eslint-disable-next-line no-await-in-loop
        await writeSiteResult(s3, batchId, siteId, {
          siteId, batchId, status: 'not_found', completedAt: new Date().toISOString(),
        });
      } else {
        const { importsEnabled } = deltaEnableImports(site, imports.types);
        if (importsEnabled.length > 0) {
          site.setConfig(Config.toDynamoItem(site.getConfig()));
          // eslint-disable-next-line no-await-in-loop
          await site.save();
        }

        const { auditsEnabled } = deltaEnableAudits(configuration, site, auditTypes);

        for (const auditType of auditTypes) {
          for (const flag of (AUDIT_HANDLER_FLAGS[auditType] || [])) {
            if (!configuration.isHandlerEnabledForSite(flag, site)) {
              configuration.enableHandlerForSite(flag, site);
              auditsEnabled.push(flag);
              log.info(`Site ${siteId}: enabling handler flag '${flag}' required by '${auditType}'`);
            }
          }
        }

        perSiteSetup[siteId] = {
          importsEnabled,
          auditsEnabled,
          baseURL: site.getBaseURL(),
          organizationId: site.getOrganizationId(),
        };
      }
    } catch (error) {
      log.error(`Setup: failed to enable for site ${siteId}`, error);
      const detail = error?.message || String(error);
      // eslint-disable-next-line no-await-in-loop
      await writeSiteResult(s3, batchId, siteId, {
        siteId,
        batchId,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: 'SETUP_FAILURE',
          message: 'Failed to enable site',
          details: detail.slice(0, 2000),
        },
      }).catch((e) => log.error(`Failed to write setup failure for ${siteId}`, e));
    }
  }

  // Phase 2: Persist global configuration (one save for all audit changes)
  try {
    await configuration.save();
    log.info(`Batch ${batchId}: saved config for ${Object.keys(perSiteSetup).length} sites`);
  } catch (error) {
    log.error(`Batch ${batchId}: config save failed, rolling back imports`, error);
    await rollbackImports(Site, perSiteSetup, log);
    for (const siteId of Object.keys(perSiteSetup)) {
      // eslint-disable-next-line no-await-in-loop
      await writeSiteResult(s3, batchId, siteId, {
        siteId,
        batchId,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'CONFIG_SAVE_FAILURE', message: 'Failed to save configuration' },
      }).catch((e) => log.error(`Failed to write config failure for ${siteId}`, e));
    }
    return { batchId, total: effectiveSiteIds.length };
  }

  // Phase 3: Enqueue jobs for each site directly
  for (const siteId of Object.keys(perSiteSetup)) {
    let result;
    try {
      // Global forceRun takes full precedence; per-site check is only evaluated when not set
      const siteForceRun = forceRun ? true : forceRunSiteIds.has(siteId);
      // eslint-disable-next-line no-await-in-loop
      const siteForFreshness = await Site.findById(siteId);

      const isTrafficAnalysisBackfillMode = imports.types.includes(TRAFFIC_ANALYSIS_IMPORT_TYPE)
        && imports.trafficAnalysisWeeks > 0;

      // eslint-disable-next-line no-await-in-loop
      const [auditTypesToSkip, importTypesToSkip, missingTrafficAnalysisWeeks] = await Promise.all([
        getAuditTypesToSkipForSite(
          siteId,
          auditTypes,
          {
            Site, ScrapeJob, LatestAudit,
          },
          log,
          siteForceRun,
          scrapeFreshnessDays,
          auditFreshnessDays,
        ),
        getImportTypesToSkipForSite(
          siteId,
          imports.types,
          siteForFreshness,
          context,
          log,
          siteForceRun,
          importFreshnessDays,
          imports.trafficAnalysisWeeks,
        ),
        // Per-week S3 check: only missing weeks get an SQS message
        (isTrafficAnalysisBackfillMode && !siteForceRun)
          ? getMissingTrafficAnalysisWeeks(siteId, imports.trafficAnalysisWeeks, context, log)
          : Promise.resolve(null),
      ]);

      // Specific pairs to enqueue: undefined means not in backfill mode (fall back to legacy path)
      let trafficAnalysisWeekYearPairs;
      if (isTrafficAnalysisBackfillMode) {
        trafficAnalysisWeekYearPairs = siteForceRun
          ? getLastNumberOfWeeks(imports.trafficAnalysisWeeks)
          : missingTrafficAnalysisWeeks;
      }

      const filteredAuditTypes = audits.types.filter((t) => !auditTypesToSkip.has(t));
      // Exclude traffic-analysis from single-message path when in backfill mode (handled via pairs)
      const filteredImportTypes = imports.types.filter((t) => {
        if (importTypesToSkip.has(t)) return false;
        if (t === TRAFFIC_ANALYSIS_IMPORT_TYPE && isTrafficAnalysisBackfillMode) return false;
        return true;
      });
      const freshnessSkipped = [
        ...[...auditTypesToSkip].map((type) => ({
          type,
          kind: 'audit',
          reason: type === SCRAPE_AUDIT_TYPE ? 'scrape-fresh' : 'audit-fresh',
        })),
        ...[...importTypesToSkip].map((type) => ({
          type,
          kind: 'import',
          reason: 'import-fresh',
        })),
      ];
      // traffic-analysis is per-week: skipped only when every requested week is already present
      if (isTrafficAnalysisBackfillMode && trafficAnalysisWeekYearPairs?.length === 0) {
        // eslint-disable-next-line max-len
        freshnessSkipped.push({ type: TRAFFIC_ANALYSIS_IMPORT_TYPE, kind: 'import', reason: 'import-fresh' });
      }
      // eslint-disable-next-line no-await-in-loop
      const jobResult = await enqueueSiteJobs(
        siteId,
        {
          imports: { ...imports, types: filteredImportTypes, trafficAnalysisWeekYearPairs },
          audits: { ...audits, types: filteredAuditTypes },
        },
        configuration,
        context,
        workflowSlackContext,
        onDemand,
      );
      result = {
        siteId,
        batchId,
        status: 'completed',
        completedAt: new Date().toISOString(),
        enqueued: jobResult.enqueued,
        skipped: jobResult.skipped,
        freshnessSkipped,
      };
    } catch (error) {
      log.error(`Batch ${batchId}: failed to enqueue jobs for site ${siteId}`, error);
      result = {
        siteId,
        batchId,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'ENQUEUE_FAILURE', message: 'Failed to enqueue site jobs' },
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await writeSiteResult(s3, batchId, siteId, result)
      .catch((e) => log.error(`Failed to write result for ${siteId}`, e));
  }

  // Phase 4: Single teardown execution covering all sites that had imports/audits enabled
  const teardownSites = [];
  for (const [siteId, setup] of Object.entries(perSiteSetup)) {
    if (setup.importsEnabled.length === 0 && setup.auditsEnabled.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }
    teardownSites.push({
      siteId,
      siteUrl: setup.baseURL,
      importTypes: setup.importsEnabled,
      auditTypes: setup.auditsEnabled,
    });
  }

  if (teardownSites.length > 0 && !scheduledRun) {
    try {
      await scheduleTeardown({
        batchId,
        sites: teardownSites,
        delaySeconds: teardownDelaySeconds,
        slackContext: workflowSlackContext,
        env,
        log,
      });
    } catch (error) {
      log.error(`Batch ${batchId}: failed to schedule teardown`, error);
    }
  } else if (teardownSites.length > 0 && scheduledRun) {
    log.info(`Batch ${batchId}: scheduledRun=true — skipping teardown, imports/audits will remain enabled`);
  }

  log.info(`Batch ${batchId}: complete, processed ${Object.keys(perSiteSetup).length} sites`);

  return { batchId, total: effectiveSiteIds.length };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  resolvePayload,
  deltaEnableImports,
  deltaEnableAudits,
  enqueueSiteJobs,
  buildTeardownWorkflowInput,
  isScrapeRecent,
  getAuditTypesToSkipForSite,
  isImportFresh,
  getImportTypesToSkipForSite,
  getMissingTrafficAnalysisWeeks,
  MAX_BATCH_SITES,
  AUDIT_HANDLER_FLAGS,
  AUTO_SUGGEST_PARENT_MAP,
};
