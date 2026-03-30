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
  triggerImportRun,
  triggerTrafficAnalysisBackfill,
  sendAuditMessage,
  sanitizeExecutionName,
} from './utils.js';
import { writeBatchManifest, writeSiteResult, BATCH_TTL_DAYS } from './insights-batch-store.js';

const sfnClient = new SFNClient();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESETS = {
  'plg-full': {
    imports: {
      types: [
        'top-pages',
        'organic-traffic',
        'organic-keywords',
        'all-traffic',
        'cwv-weekly',
        'code',
        'traffic-analysis',
      ],
      trafficAnalysisWeeks: 5,
    },
    audits: {
      types: [
        'lhs-mobile',
        'accessibility',
        'broken-backlinks',
        'broken-internal-links',
        'forms-opportunities',
        'experimentation-opportunities',
        'paid',
        'no-cta-above-the-fold',
        'broken-backlinks-auto-suggest',
        'broken-internal-links-auto-suggest',
        'meta-tags-auto-suggest',
      ],
    },
  },
};

const DEFAULT_TEARDOWN_DELAY_SECONDS = 14400; // 4 hours
const MAX_TEARDOWN_DELAY_SECONDS = 86400; // 24 hours
const MAX_BATCH_SITES = 500;

// ---------------------------------------------------------------------------
// Payload resolution
// ---------------------------------------------------------------------------

function resolvePayload(body) {
  const preset = PRESETS[body.preset];
  const base = preset || { imports: { types: [] }, audits: { types: [] } };

  const imports = {
    types: body.imports?.types || base.imports.types,
    trafficAnalysisWeeks: body.imports?.trafficAnalysisWeeks
      ?? base.imports.trafficAnalysisWeeks
      ?? 0,
  };

  const audits = {
    types: body.audits?.types || base.audits.types,
  };

  const rawDelay = body.teardown?.delaySeconds ?? DEFAULT_TEARDOWN_DELAY_SECONDS;
  const teardownDelaySeconds = Math.min(
    Math.max(0, rawDelay),
    MAX_TEARDOWN_DELAY_SECONDS,
  );

  return { imports, audits, teardownDelaySeconds };
}

// ---------------------------------------------------------------------------
// Delta-enable helpers
// ---------------------------------------------------------------------------

function isImportEnabled(importType, imports) {
  const found = imports?.find((cfg) => cfg.type === importType);
  return found ? found.enabled : false;
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

// ---------------------------------------------------------------------------
// Abort / rollback
// ---------------------------------------------------------------------------

async function abortDisable(site, configuration, importsEnabled, auditsEnabled, log) {
  try {
    if (importsEnabled.length > 0) {
      const siteConfig = site.getConfig();
      for (const importType of importsEnabled) {
        siteConfig.disableImport(importType);
      }
      await site.save();
    }
    if (auditsEnabled.length > 0) {
      for (const auditType of auditsEnabled) {
        configuration.disableHandlerForSite(auditType, site);
      }
      await configuration.save();
    }
    return true;
  } catch (disableError) {
    log.error('Failed to abort-disable imports/audits after failure', disableError);
    return false;
  }
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
          // eslint-disable-next-line no-await-in-loop
          await site.save();
        }
      } catch (err) {
        log.error(`Failed to rollback imports for site ${siteId}`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step Functions teardown scheduling
// ---------------------------------------------------------------------------

function getStateMachineArn(env) {
  return env.INSIGHTS_TEARDOWN_STATE_MACHINE_ARN || env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN;
}

async function scheduleTeardown(params) {
  const {
    siteId, baseURL, importsEnabled, auditsEnabled, delaySeconds, env, log,
  } = params;

  const workflowInput = {
    disableImportAndAuditJob: {
      type: 'disable-import-audit-processor',
      siteId,
      siteUrl: baseURL,
      taskContext: {
        importTypes: importsEnabled,
        auditTypes: auditsEnabled,
        scheduledRun: false,
      },
    },
    workflowWaitTime: delaySeconds || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
  };

  const workflowName = sanitizeExecutionName(
    `insights-${siteId.slice(0, 8)}-${Date.now()}`,
  );

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: getStateMachineArn(env),
    input: JSON.stringify(workflowInput),
    name: workflowName,
  }));

  log.info(`Scheduled teardown for site ${siteId}, delay=${delaySeconds}s`);

  return {
    mode: 'deferred',
    delaySeconds,
    disableAfter: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    scheduled: true,
  };
}

async function scheduleBatchAuditTeardown(params) {
  const {
    batchId, allAuditsEnabled, delaySeconds, env, log,
  } = params;

  const workflowName = sanitizeExecutionName(
    `insights-batch-${batchId.slice(0, 8)}-${Date.now()}`,
  );

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: getStateMachineArn(env),
    input: JSON.stringify({
      type: 'batch-disable-audits',
      batchId,
      allAuditsEnabled,
      workflowWaitTime: delaySeconds || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
    }),
    name: workflowName,
  }));

  log.info(`Scheduled batch audit teardown for ${Object.keys(allAuditsEnabled).length} sites, delay=${delaySeconds}s`);
}

// ---------------------------------------------------------------------------
// Job enqueuing (shared by single-site and batch flows)
// ---------------------------------------------------------------------------

async function enqueueSiteJobs(siteId, resolvedPayload, configuration, context) {
  const { log, env } = context;
  const { imports, audits } = resolvedPayload;
  const enqueued = { imports: [], audits: [] };
  const skipped = [];

  for (const importType of imports.types) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await triggerImportRun(configuration, importType, siteId, undefined, undefined, {}, context);
      enqueued.imports.push({ type: importType, status: 'queued' });
    } catch (e) {
      log.error(`Failed to enqueue import ${importType} for site ${siteId}`, e);
      skipped.push({ type: importType, kind: 'import', reason: e.message });
    }
  }

  if (imports.trafficAnalysisWeeks > 0) {
    try {
      const weeks = imports.trafficAnalysisWeeks;
      await triggerTrafficAnalysisBackfill(siteId, configuration, {}, context, weeks);
      for (let w = 1; w <= weeks; w += 1) {
        enqueued.imports.push({ type: 'traffic-analysis', status: 'queued', week: w });
      }
    } catch (e) {
      log.error(`Failed to enqueue traffic-analysis backfill for site ${siteId}`, e);
      skipped.push({ type: 'traffic-analysis', kind: 'import', reason: e.message });
    }
  }

  const auditQueueUrl = env.AUDIT_JOBS_QUEUE_URL;
  for (const auditType of audits.types) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendAuditMessage(context.sqs, auditQueueUrl, auditType, { onDemand: true }, siteId);
      enqueued.audits.push({ type: auditType, status: 'queued' });
    } catch (e) {
      log.error(`Failed to enqueue audit ${auditType} for site ${siteId}`, e);
      skipped.push({ type: auditType, kind: 'audit', reason: e.message });
    }
  }

  return { enqueued, skipped };
}

// ---------------------------------------------------------------------------
// Single-site endpoint
// ---------------------------------------------------------------------------

export async function runInsightsForSite(siteId, body, context) {
  const { dataAccess, log } = context;
  const { Site, Configuration } = dataAccess;
  const runId = randomUUID();

  const site = await Site.findById(siteId);
  if (!site) {
    return { siteId, runId, status: 'not_found' };
  }

  const { imports, audits, teardownDelaySeconds } = resolvePayload(body);
  const auditTypes = audits.types;
  const configuration = await Configuration.findLatest();

  const { importsEnabled, importsAlreadyEnabled } = deltaEnableImports(site, imports.types);
  const auditDelta = deltaEnableAudits(configuration, site, auditTypes);
  const { auditsEnabled, auditsAlreadyEnabled } = auditDelta;

  let teardownResult = { mode: 'none' };
  let syncError = null;
  const enqueued = { imports: [], audits: [] };
  const skipped = [];

  try {
    if (importsEnabled.length > 0) {
      await site.save();
      log.info(`Enabled imports for site ${siteId}: ${importsEnabled.join(', ')}`);
    }
    if (auditsEnabled.length > 0) {
      await configuration.save();
      log.info(`Enabled audits for site ${siteId}: ${auditsEnabled.join(', ')}`);
    }

    const jobResult = await enqueueSiteJobs(siteId, { imports, audits }, configuration, context);
    enqueued.imports.push(...jobResult.enqueued.imports);
    enqueued.audits.push(...jobResult.enqueued.audits);
    skipped.push(...jobResult.skipped);

    if (importsEnabled.length > 0 || auditsEnabled.length > 0) {
      teardownResult = await scheduleTeardown({
        siteId,
        baseURL: site.getBaseURL(),
        importsEnabled,
        auditsEnabled,
        delaySeconds: teardownDelaySeconds,
        env: context.env,
        log,
      });
    }
  } catch (error) {
    syncError = error;
    log.error(`Insights run failed for site ${siteId}, aborting`, error);
  } finally {
    if (syncError) {
      const disableOk = await abortDisable(site, configuration, importsEnabled, auditsEnabled, log);
      teardownResult = {
        mode: 'abort',
        disabledImmediately: disableOk,
        disabledTypes: [...importsEnabled, ...auditsEnabled],
      };
    }
  }

  return {
    runId,
    siteId,
    status: syncError ? 'failed' : 'accepted',
    setup: {
      imports: { enabled: importsEnabled, alreadyEnabled: importsAlreadyEnabled },
      audits: { enabled: auditsEnabled, alreadyEnabled: auditsAlreadyEnabled },
    },
    enqueued,
    skipped,
    teardown: teardownResult,
    ...(syncError ? { error: { code: 'SYNC_FAILURE', message: 'Insights run failed' } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Batch endpoint (POST handler)
// ---------------------------------------------------------------------------

export async function runInsightsBatch(siteIds, body, context) {
  const {
    dataAccess, s3, env, log,
  } = context;
  const { Site, Configuration } = dataAccess;
  const batchId = randomUUID();
  const uniqueSiteIds = [...new Set(siteIds)];
  const effectiveSiteIds = uniqueSiteIds.slice(0, MAX_BATCH_SITES);

  const { imports, audits, teardownDelaySeconds } = resolvePayload(body);
  const auditTypes = audits.types;
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
          // eslint-disable-next-line no-await-in-loop
          await site.save();
        }

        const { auditsEnabled } = deltaEnableAudits(configuration, site, auditTypes);

        perSiteSetup[siteId] = {
          importsEnabled,
          auditsEnabled,
          baseURL: site.getBaseURL(),
        };
      }
    } catch (error) {
      log.error(`Setup: failed to enable for site ${siteId}`, error);
      // eslint-disable-next-line no-await-in-loop
      await writeSiteResult(s3, batchId, siteId, {
        siteId,
        batchId,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'SETUP_FAILURE', message: 'Failed to enable site' },
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
      // eslint-disable-next-line no-await-in-loop
      const jobResult = await enqueueSiteJobs(siteId, { imports, audits }, configuration, context);
      result = {
        siteId,
        batchId,
        status: 'completed',
        completedAt: new Date().toISOString(),
        enqueued: jobResult.enqueued,
        skipped: jobResult.skipped,
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

  // Phase 4: Schedule teardowns
  const allAuditsEnabled = {};
  for (const [siteId, setup] of Object.entries(perSiteSetup)) {
    if (setup.auditsEnabled.length > 0) {
      allAuditsEnabled[siteId] = setup.auditsEnabled;
    }
  }

  if (Object.keys(allAuditsEnabled).length > 0) {
    try {
      await scheduleBatchAuditTeardown({
        batchId,
        allAuditsEnabled,
        delaySeconds: teardownDelaySeconds,
        env,
        log,
      });
    } catch (error) {
      log.error(`Batch ${batchId}: failed to schedule audit teardown`, error);
    }
  }

  for (const [siteId, setup] of Object.entries(perSiteSetup)) {
    if (setup.importsEnabled.length > 0) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await scheduleTeardown({
          siteId,
          baseURL: setup.baseURL,
          importsEnabled: setup.importsEnabled,
          auditsEnabled: [],
          delaySeconds: teardownDelaySeconds,
          env,
          log,
        });
      } catch (error) {
        log.error(`Batch ${batchId}: failed to schedule import teardown for site ${siteId}`, error);
      }
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
  PRESETS,
  MAX_BATCH_SITES,
};
