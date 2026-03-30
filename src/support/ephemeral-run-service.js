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
  buildOnboardWorkflowInput,
} from './utils.js';
import { writeBatchManifest, writeSiteResult, BATCH_TTL_DAYS } from './ephemeral-run-batch-store.js';

const sfnClient = new SFNClient();

/** Import type key for traffic-analysis jobs and backfill. */
const TRAFFIC_ANALYSIS_IMPORT_TYPE = 'traffic-analysis';

/** Option key for how many weeks of traffic-analysis backfill to queue. */
const TRAFFIC_ANALYSIS_BACKFILL_WEEKS_KEY = 'backfillWeeks';

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
  'plg-full': {
    imports: {
      types: [
        'top-pages',
        'organic-traffic',
        'organic-keywords',
        'all-traffic',
        'code',
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

const DEFAULT_TRAFFIC_ANALYSIS_BACKFILL_WEEKS = 5;
const DEFAULT_TEARDOWN_DELAY_SECONDS = 14400; // 4 hours
const MAX_TEARDOWN_DELAY_SECONDS = 86400; // 24 hours
const MAX_BATCH_SITES = 600;

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

  if (!explicitTaWeeks && !types.includes(TRAFFIC_ANALYSIS_IMPORT_TYPE)) {
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

  return { imports, audits, teardownDelaySeconds };
}

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

function getStateMachineArn(env) {
  return env.EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN
    || env.INSIGHTS_TEARDOWN_STATE_MACHINE_ARN
    || env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN;
}

function ephemeralRunWorkflowSlackContext(env) {
  return {
    channelId: env.EPHEMERAL_RUN_WORKFLOW_SLACK_CHANNEL_ID
      || env.INSIGHTS_WORKFLOW_SLACK_CHANNEL_ID
      || '',
    threadTs: env.EPHEMERAL_RUN_WORKFLOW_SLACK_THREAD_TS
      || env.INSIGHTS_WORKFLOW_SLACK_THREAD_TS
      || '',
  };
}

async function scheduleTeardown(params) {
  const {
    siteId,
    baseURL,
    imsOrgId,
    organizationId,
    importsEnabled,
    auditsEnabled,
    opportunityStatusAuditTypes,
    profileName,
    delaySeconds,
    env,
    log,
  } = params;

  const stateMachineArn = getStateMachineArn(env);
  if (!stateMachineArn) {
    throw new Error(
      'Ephemeral run teardown requires EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN, '
      + 'INSIGHTS_TEARDOWN_STATE_MACHINE_ARN (legacy), or ONBOARD_WORKFLOW_STATE_MACHINE_ARN',
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

  const workflowInput = buildOnboardWorkflowInput({
    siteId,
    siteUrl: baseURL,
    imsOrgId,
    organizationId,
    slackContext: ephemeralRunWorkflowSlackContext(env),
    opportunityStatusAuditTypes,
    importTypesToDisable: importsEnabled,
    auditTypesToDisable: auditsEnabled,
    scheduledRun: false,
    profileName,
    env,
    workflowWaitTime,
    onboardStartTime: Date.now(),
  });

  const workflowName = sanitizeExecutionName(
    `ephemeral-run-${siteId.slice(0, 8)}-${Date.now()}`,
  );

  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn,
    input: JSON.stringify(workflowInput),
    name: workflowName,
  }));

  log.info(`Scheduled teardown for site ${siteId}, workflowWaitTime=${workflowWaitTime}s`);

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
  const auditContext = {
    onDemand: true,
    slackContext: { channelId: '', threadTs: '' },
  };
  if (audits.types.length > 0 && !auditQueueUrl) {
    log.error('No audit queue URL: set env AUDIT_JOBS_QUEUE_URL');
    for (const auditType of audits.types) {
      skipped.push({
        type: auditType,
        kind: 'audit',
        reason: 'Missing audit jobs queue URL',
      });
    }
  } else {
    for (const auditType of audits.types) {
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
  const { Site, Configuration, Organization } = dataAccess;
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
          organizationId: site.getOrganizationId(),
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

  // Phase 4: One onboard-compatible teardown execution per site (imports and/or audits)
  const profileName = body.preset ?? 'plg-full';
  for (const [siteId, setup] of Object.entries(perSiteSetup)) {
    if (setup.importsEnabled.length === 0 && setup.auditsEnabled.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!setup.organizationId) {
      log.error(`Batch ${batchId}: site ${siteId} has no organization; skipping teardown schedule`);
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const organization = await Organization.findById(setup.organizationId);
      if (!organization) {
        log.error(`Batch ${batchId}: organization not found for site ${siteId}; skipping teardown`);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await scheduleTeardown({
        siteId,
        baseURL: setup.baseURL,
        imsOrgId: organization.getImsOrgId(),
        organizationId: organization.getId(),
        importsEnabled: setup.importsEnabled,
        auditsEnabled: setup.auditsEnabled,
        opportunityStatusAuditTypes: auditTypes,
        profileName,
        delaySeconds: teardownDelaySeconds,
        env,
        log,
      });
    } catch (error) {
      log.error(`Batch ${batchId}: failed to schedule teardown for site ${siteId}`, error);
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
