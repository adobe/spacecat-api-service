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
import { getOpportunitiesForAudit, getLastNumberOfWeeks } from '@adobe/spacecat-shared-utils';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  triggerImportRun,
  triggerTrafficAnalysisBackfill,
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
const OPPORTUNITY_FRESHNESS_DAYS = 7;

/**
 * Preset / request `imports` may include:
 * - `types`: string[]
 * - `optionsByImportType`: map of import type → options object (shallow merge per type; body wins).
 *   Example: `optionsByImportType['traffic-analysis'] = { backfillWeeks: 5 }`.
 * Add sibling keys under an import type when that import gains more tunables.
 *
 * Legacy: top-level `imports.trafficAnalysisWeeks` still overrides traffic-analysis backfill weeks.
 */
const PRESETS = {
  'insights-report-default': {
    imports: {
      types: [
        'organic-traffic',
        'top-pages',
        'organic-keywords',
        'all-traffic',
        'traffic-analysis',
      ],
      optionsByImportType: {
        [TRAFFIC_ANALYSIS_IMPORT_TYPE]: {
          [TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY]: 5,
        },
      },
    },
    audits: {
      types: [
        'scrape-top-pages',
        'broken-backlinks',
        'broken-backlinks-auto-suggest',
        'broken-internal-links',
        'broken-internal-links-auto-suggest',
        'cwv',
        'cwv-auto-suggest',
        'meta-tags',
        'meta-tags-auto-suggest',
        'alt-text',
        'alt-text-auto-suggest-mystique',
        'forms-opportunities',
        'experimentation-opportunities',
        'accessibility',
        'paid',
        'no-cta-above-the-fold',
        'security-vulnerabilities',
        'security-vulnerabilities-auto-suggest',
        'security-permissions',
        'security-permissions-redundant',
        'security-csp-auto-suggest',
        'lhs-mobile',
      ],
    },
  },
};

const DEFAULT_TRAFFIC_ANALYSIS_BACKFILL_WEEKS = 52;
const DEFAULT_TEARDOWN_DELAY_SECONDS = 14400; // 4 hours
const MAX_TEARDOWN_DELAY_SECONDS = 86400; // 24 hours
const MAX_BATCH_SITES = 1000;

function mergeOptionsByImportType(baseMap = {}, bodyMap = {}) {
  const keys = new Set([
    ...Object.keys(baseMap),
    ...Object.keys(bodyMap),
  ]);
  const out = {};
  for (const importType of keys) {
    out[importType] = {
      ...(baseMap[importType] || {}),
      ...(bodyMap[importType] || {}),
    };
  }
  return out;
}

function resolveImportsFromPreset(baseImports, bodyImports) {
  /* c8 ignore next -- final ?? [] only when both sides omit types; presets always define types */
  const types = bodyImports?.types ?? baseImports?.types ?? [];

  let optionsByImportType = mergeOptionsByImportType(
    baseImports?.optionsByImportType,
    bodyImports?.optionsByImportType,
  );

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
    ?.[TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY];
  trafficAnalysisWeeks = trafficAnalysisWeeks ?? 0;

  if (!types.includes(TRAFFIC_ANALYSIS_IMPORT_TYPE)) {
    trafficAnalysisWeeks = 0;
  }

  if (
    types.includes(TRAFFIC_ANALYSIS_IMPORT_TYPE)
    && trafficAnalysisWeeks === 0
    && !explicitTaWeeks
  ) {
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
  const preset = PRESETS[body.preset];
  const base = preset || { imports: { types: [] }, audits: { types: [] } };

  const imports = resolveImportsFromPreset(base.imports, body.imports);

  const audits = {
    types: body.audits?.types ?? base.audits.types,
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

  const scrapeFreshnessDays = typeof body.freshness?.scrapeDays === 'number'
    ? body.freshness.scrapeDays
    : SCRAPE_FRESHNESS_DAYS;
  const opportunityFreshnessDays = typeof body.freshness?.opportunityDays === 'number'
    ? body.freshness.opportunityDays
    : OPPORTUNITY_FRESHNESS_DAYS;

  return {
    imports,
    audits,
    teardownDelaySeconds,
    forceRun,
    forceRunSiteIds,
    scrapeFreshnessDays,
    opportunityFreshnessDays,
  };
}

function isImportEnabled(importType, imports) {
  const found = imports?.find((cfg) => cfg.type === importType);
  return found ? found.enabled : false;
}

/**
 * Maps audit types to the parent audit type used for opportunity-freshness lookups.
 * Covers -auto-suggest/-auto-suggest-mystique variants and data-collection audits
 * that share freshness with a parent audit's opportunities.
 * lhs-mobile and security-csp-auto-suggest are only enabled/run when security-csp
 * opportunities are not fresh.
 */
const AUDIT_PARENT_MAP = {
  // -auto-suggest variants
  'broken-backlinks-auto-suggest': 'broken-backlinks',
  'broken-internal-links-auto-suggest': 'broken-internal-links',
  'meta-tags-auto-suggest': 'meta-tags',
  'alt-text-auto-suggest-mystique': 'alt-text',
  'security-vulnerabilities-auto-suggest': 'security-vulnerabilities',
  'security-csp-auto-suggest': 'security-csp',
  // data-collection audits gated on security-csp opportunity freshness
  'lhs-mobile': 'security-csp',
};

/**
 * Local opportunity overrides for audit types that are excluded from the shared
 * AUDIT_OPPORTUNITY_MAP (e.g. listed as data-collection only) but do produce
 * opportunities that can be used for freshness checks.
 */
const LOCAL_OPPORTUNITY_MAP = {
  paid: ['consent-banner'],
  // accessibility creates a11y-* types, not the 'accessibility' type listed in the shared map
  accessibility: ['a11y-assistive', 'a11y-color-contrast'],
};

/**
 * Returns the opportunity types for a given audit type, checking the local
 * override map first and falling back to the shared AUDIT_OPPORTUNITY_MAP.
 */
function getOpportunityTypesForAudit(auditType) {
  return LOCAL_OPPORTUNITY_MAP[auditType] ?? getOpportunitiesForAudit(auditType);
}

/**
 * Returns the parent audit type for opportunity-freshness lookups.
 * Falls back to the audit type itself when no explicit mapping exists.
 */
function getParentAuditType(auditType) {
  return AUDIT_PARENT_MAP[auditType] ?? auditType;
}

/**
 * Returns true if the site has a scrape-top-pages audit result that is
 * younger than SCRAPE_FRESHNESS_DAYS days.
 */
async function isScrapeRecent(
  siteId,
  LatestAudit,
  log,
  scrapeFreshnessDays = SCRAPE_FRESHNESS_DAYS,
) {
  try {
    const audits = await LatestAudit.allBySiteIdAndAuditType(siteId, SCRAPE_AUDIT_TYPE);
    if (!audits || audits.length === 0) return false;
    const auditedAt = new Date(audits[0].getAuditedAt()).getTime();
    const ageInDays = (Date.now() - auditedAt) / (1000 * 60 * 60 * 24);
    return ageInDays < scrapeFreshnessDays;
  } catch (err) {
    log.warn(`Failed to check scrape freshness for site ${siteId}:`, err);
    return false;
  }
}

/**
 * Fetches all opportunities for a site and returns a Map of
 * opportunityType → latest updatedAt Date. When multiple opportunities share
 * the same type, the newest updatedAt wins.
 */
async function buildOpportunityFreshnessMap(siteId, Opportunity, log) {
  const map = new Map();
  try {
    const opportunities = await Opportunity.allBySiteId(siteId);
    for (const opp of opportunities) {
      const type = opp.getType();
      const updatedAt = new Date(opp.getUpdatedAt());
      if (!map.has(type) || updatedAt > map.get(type)) {
        map.set(type, updatedAt);
      }
    }
  } catch (err) {
    log.warn(`Failed to build opportunity freshness map for site ${siteId}:`, err);
  }
  return map;
}

/**
 * Returns a Set of audit types that should be skipped from SQS enqueue for
 * this site. Audit types are still enabled in Configuration (Phase 1) —
 * only the SQS message is suppressed.
 *
 * Returns an empty Set immediately when forceRun is true (bypass all checks).
 *
 * Skip rules:
 * - scrape-top-pages: skip if site has a scrape result within scrapeFreshnessDays
 * - all others: resolve parent via AUDIT_PARENT_MAP, look up opportunity types,
 *   skip if ALL of them have updatedAt within opportunityFreshnessDays.
 *   If there are no mapped opportunity types, never skip (unknown = run it).
 */
async function getAuditTypesToSkipForSite(
  siteId,
  auditTypes,
  dataAccess,
  log,
  forceRun = false,
  scrapeFreshnessDays = SCRAPE_FRESHNESS_DAYS,
  opportunityFreshnessDays = OPPORTUNITY_FRESHNESS_DAYS,
) {
  if (forceRun) {
    log.info(`Site ${siteId}: forceRun=true — skipping all freshness checks`);
    return new Set();
  }

  const { LatestAudit, Opportunity } = dataAccess;

  const hasScrapeAudit = auditTypes.includes(SCRAPE_AUDIT_TYPE);
  const nonScrapeTypes = auditTypes.filter((t) => t !== SCRAPE_AUDIT_TYPE);
  const hasOpportunityAudits = nonScrapeTypes.some(
    (t) => getOpportunityTypesForAudit(getParentAuditType(t)).length > 0,
  );

  const [scrapeRecent, opportunityMap] = await Promise.all([
    hasScrapeAudit
      ? isScrapeRecent(siteId, LatestAudit, log, scrapeFreshnessDays)
      : Promise.resolve(false),
    hasOpportunityAudits
      ? buildOpportunityFreshnessMap(siteId, Opportunity, log)
      : Promise.resolve(new Map()),
  ]);

  const now = Date.now();
  const freshnessThresholdMs = opportunityFreshnessDays * 24 * 60 * 60 * 1000;
  const skip = new Set();

  for (const auditType of auditTypes) {
    if (auditType === SCRAPE_AUDIT_TYPE) {
      if (scrapeRecent) {
        log.info(`Site ${siteId}: skipping SQS enqueue for ${SCRAPE_AUDIT_TYPE} — scrape within ${scrapeFreshnessDays} days`);
        skip.add(auditType);
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    const parent = getParentAuditType(auditType);
    const opportunityTypes = getOpportunityTypesForAudit(parent);
    if (opportunityTypes.length === 0) {
      // No known opportunity mapping — always run
      // eslint-disable-next-line no-continue
      continue;
    }

    const allFresh = opportunityTypes.every((oppType) => {
      const updatedAt = opportunityMap.get(oppType);
      return updatedAt && (now - updatedAt.getTime()) < freshnessThresholdMs;
    });

    if (allFresh) {
      log.info(`Site ${siteId}: skipping SQS enqueue for ${auditType} — all opportunities fresh within ${opportunityFreshnessDays} days`);
      skip.add(auditType);
    }
  }

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
) {
  const { log, env } = context;
  const { imports, audits } = resolvedPayload;
  const enqueued = { imports: [], audits: [] };
  const skipped = [];

  const trafficAnalysisHandledByBackfill = imports.trafficAnalysisWeeks > 0;
  for (const importType of imports.types) {
    // traffic-analysis with weeks > 0 is handled by triggerTrafficAnalysisBackfill below
    if (importType === TRAFFIC_ANALYSIS_IMPORT_TYPE && trafficAnalysisHandledByBackfill) {
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
    try {
      const weeks = imports.trafficAnalysisWeeks;
      const weekYearPairs = getLastNumberOfWeeks(weeks);
      await triggerTrafficAnalysisBackfill(siteId, configuration, slackContext, context, weeks);
      for (const { week, year } of weekYearPairs) {
        enqueued.imports.push({
          type: 'traffic-analysis', status: 'queued', week, year,
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
    onDemand: true,
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
    Site, Configuration, Opportunity, LatestAudit,
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
    scrapeFreshnessDays,
    opportunityFreshnessDays,
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
      preset: body.preset,
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
      const auditTypesToSkip = await getAuditTypesToSkipForSite(
        siteId,
        auditTypes,
        { LatestAudit, Opportunity },
        log,
        siteForceRun,
        scrapeFreshnessDays,
        opportunityFreshnessDays,
      );
      const filteredAuditTypes = audits.types.filter((t) => !auditTypesToSkip.has(t));
      const freshnessSkipped = [...auditTypesToSkip].map((type) => ({
        type,
        reason: type === SCRAPE_AUDIT_TYPE ? 'scrape-fresh' : 'opportunity-fresh',
      }));
      // eslint-disable-next-line no-await-in-loop
      const jobResult = await enqueueSiteJobs(
        siteId,
        { imports, audits: { ...audits, types: filteredAuditTypes } },
        configuration,
        context,
        workflowSlackContext,
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

  if (teardownSites.length > 0) {
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
  getParentAuditType,
  isScrapeRecent,
  buildOpportunityFreshnessMap,
  getAuditTypesToSkipForSite,
  PRESETS,
  MAX_BATCH_SITES,
};
