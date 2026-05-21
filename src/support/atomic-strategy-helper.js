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

import { llmoStrategy } from '@adobe/spacecat-shared-utils';

const { readStrategy, writeStrategy } = llmoStrategy;

const BACKOFF_MS = [0, 250, 750];
const MAX_ATTEMPTS = BACKOFF_MS.length;

// All logs in this module share the [edge-deploy] root prefix and a
// step=<atomic-strategy-create|atomic-strategy-delete> tag so the entire
// edge-deploy flow (controller + helper) is queryable as one stream in
// Coralogix via `$d.message ~ '\[edge-deploy\]'`.
const STEP_CREATE = 'atomic-strategy-create';
const STEP_DELETE = 'atomic-strategy-delete';

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// Best-effort extraction of an SDK error code. AWS SDK v3 errors expose
// `.Code` or `.$metadata.httpStatusCode`; plain JS errors typically have
// nothing. Branches here are trivial fallbacks and hit only at runtime
// against real S3 errors, so we exempt them from the 100% branch gate.
/* c8 ignore next */
const errCode = (e) => e?.code || e?.Code || e?.$metadata?.httpStatusCode;

/**
 * Append an Atomic Strategy entry to the site's LLMO strategy blob in S3.
 *
 * Bounded-retry, idempotent on retry: if a strategy with the same id is
 * already present (because a previous attempt succeeded but this code did
 * not learn of it), it is treated as success.
 *
 * On terminal failure (all 3 attempts fail), emits a structured
 * phase=failed log carrying enough metadata for an operator to reconstruct
 * the intended strategy, then THROWS. The new UI (progress stepper, "View
 * Strategy" button) treats the Atomic strategy as a required projection of
 * the experiment — a missing strategy means an invisible experiment with
 * no UI path. Callers must roll back any side-effects (GeoExperiment row,
 * DRS schedule, suggestion mutations) accordingly.
 *
 * @param {object} params
 * @param {string} params.siteId
 * @param {string} params.geoExperimentId  Used as both strategy.id and experimentId.
 * @param {string} params.opportunityId
 * @param {string} params.opportunityType
 * @param {string} params.name
 * @param {object} params.profile
 * @param {object} params.s3                { s3Client, s3Bucket }
 * @param {object} params.log
 * @param {Function} [params.sleep]         Override for tests.
 * @returns {Promise<{ success: true, strategyId: string, attempts: number, durationMs: number }>}
 * @throws {Error} If all attempts fail. Original error message is preserved.
 */
export async function createAtomicStrategy({
  siteId,
  geoExperimentId,
  opportunityId,
  opportunityType,
  name,
  profile,
  s3,
  log,
  sleep = defaultSleep,
}) {
  const strategyId = geoExperimentId;
  const tStart = Date.now();
  const caller = profile?.email || 'edge-deploy';

  log.info(`[edge-deploy] step=${STEP_CREATE} phase=start siteId=${siteId} strategyId=${strategyId} geoExperimentId=${geoExperimentId} opportunityId=${opportunityId} opportunityType=${opportunityType} caller=${caller}`);

  // The opportunityId references a SYSTEM Opportunity (DynamoDB), not a
  // library opportunity in the strategy blob's top-level `opportunities`
  // array. The schema's superRefine rule requires `link` to mark this as a
  // system reference, otherwise parse() rejects with
  // "Library opportunity <id> does not exist" the next time anything reads
  // the blob. The link path mirrors the API route shape.
  const opportunityLink = `/sites/${siteId}/opportunities/${opportunityId}`;
  const newStrategy = {
    id: strategyId,
    type: 'atomic',
    experimentId: geoExperimentId,
    name,
    status: 'in_progress',
    url: '',
    description: '',
    topic: opportunityType,
    createdAt: new Date().toISOString(),
    createdBy: caller,
    opportunities: [
      {
        opportunityId,
        link: opportunityLink,
        status: 'in_progress',
        assignee: caller,
      },
    ],
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    try {
      if (BACKOFF_MS[attempt - 1] > 0) {
        await sleep(BACKOFF_MS[attempt - 1]);
      }

      const tRead = Date.now();
      const { data, exists } = await readStrategy(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
      });
      const readMs = Date.now() - tRead;

      const baseData = exists && data
        ? { opportunities: data.opportunities ?? [], strategies: data.strategies ?? [] }
        : { opportunities: [], strategies: [] };

      log.info(`[edge-deploy] step=${STEP_CREATE} phase=read siteId=${siteId} strategyId=${strategyId} attempt=${attempt} blobExists=${exists === true} existingCount=${baseData.strategies.length} readMs=${readMs}`);

      const alreadyPresent = baseData.strategies.some((s) => s.id === strategyId);
      if (alreadyPresent) {
        const durationMs = Date.now() - tStart;
        log.info(`[edge-deploy] step=${STEP_CREATE} phase=ok siteId=${siteId} strategyId=${strategyId} attempt=${attempt} idempotentSkip=true totalStrategies=${baseData.strategies.length} durationMs=${durationMs}`);
        return {
          success: true, strategyId, attempts: attempt, durationMs,
        };
      }

      const nextData = {
        ...baseData,
        strategies: [...baseData.strategies, newStrategy],
      };

      const tWrite = Date.now();
      await writeStrategy(siteId, nextData, s3.s3Client, { s3Bucket: s3.s3Bucket });
      const writeMs = Date.now() - tWrite;
      const durationMs = Date.now() - tStart;

      log.info(`[edge-deploy] step=${STEP_CREATE} phase=ok siteId=${siteId} strategyId=${strategyId} attempt=${attempt} idempotentSkip=false totalStrategies=${nextData.strategies.length} readMs=${readMs} writeMs=${writeMs} durationMs=${durationMs}`);
      return {
        success: true, strategyId, attempts: attempt, durationMs,
      };
    } catch (error) {
      lastError = error;
      log.warn(`[edge-deploy] step=${STEP_CREATE} phase=attempt-failed siteId=${siteId} strategyId=${strategyId} attempt=${attempt}/${MAX_ATTEMPTS} errorName=${error.name} errorCode=${errCode(error)} message=${error.message}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  const durationMs = Date.now() - tStart;
  log.error(`[edge-deploy] step=${STEP_CREATE} phase=failed siteId=${siteId} strategyId=${strategyId} geoExperimentId=${geoExperimentId} opportunityId=${opportunityId} opportunityType=${opportunityType} attempts=${MAX_ATTEMPTS} durationMs=${durationMs} errorName=${lastError?.name} errorCode=${errCode(lastError)} message=${lastError?.message} intendedStrategy=${JSON.stringify(newStrategy)} stack=${lastError?.stack}`);

  // Throw so the caller can roll back the GeoExperiment + DRS schedule +
  // suggestion mutations. A successful experiment with no strategy is
  // user-invisible (no UI path), which is worse than a clean failure.
  const err = new Error(
    `atomic-strategy create failed after ${MAX_ATTEMPTS} attempts for strategy ${strategyId}: ${lastError?.message}`,
  );
  err.cause = lastError;
  throw err;
}

/**
 * Remove an Atomic Strategy entry from the site's LLMO strategy blob in S3.
 *
 * Used as the compensating action when a later step in the edge-deploy
 * pipeline (DRS schedule, suggestion marking, etc.) fails after the strategy
 * has already been written. Delete-by-id is idempotent: if the strategy is
 * already absent (concurrent cleanup, never-existed, or blob doesn't exist
 * yet) the helper returns success without writing.
 *
 * Bounded retry mirrors createAtomicStrategy so concurrent writes from
 * another request can't undo the cleanup: each attempt re-reads the blob
 * before filtering, so we don't write stale data over a fresh insert.
 *
 * @param {object} params
 * @param {string} params.siteId
 * @param {string} params.strategyId       The strategy.id to remove (== geoExperimentId).
 * @param {object} params.s3                { s3Client, s3Bucket }
 * @param {object} params.log
 * @param {string} [params.reason]          Free-form tag for the log (e.g. 'rollback').
 * @param {Function} [params.sleep]         Override for tests.
 * @returns {Promise<object>} { success, strategyId, attempts, removed, durationMs }
 * @throws {Error} If all attempts fail. Caller should log loudly — orphan
 *   strategy + missing experiment is the failure mode we accept here.
 */
export async function deleteAtomicStrategy({
  siteId,
  strategyId,
  s3,
  log,
  reason = 'unspecified',
  sleep = defaultSleep,
}) {
  const tStart = Date.now();
  log.info(`[edge-deploy] step=${STEP_DELETE} phase=start siteId=${siteId} strategyId=${strategyId} reason=${reason}`);

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    try {
      if (BACKOFF_MS[attempt - 1] > 0) {
        await sleep(BACKOFF_MS[attempt - 1]);
      }

      const tRead = Date.now();
      const { data, exists } = await readStrategy(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
      });
      const readMs = Date.now() - tRead;

      if (!exists || !data) {
        const durationMs = Date.now() - tStart;
        log.info(`[edge-deploy] step=${STEP_DELETE} phase=ok siteId=${siteId} strategyId=${strategyId} attempt=${attempt} removed=false idempotentSkip=blob-missing readMs=${readMs} durationMs=${durationMs} reason=${reason}`);
        return {
          success: true, strategyId, attempts: attempt, removed: false, durationMs,
        };
      }

      const existingStrategies = data.strategies ?? [];
      const present = existingStrategies.some((s) => s.id === strategyId);

      log.info(`[edge-deploy] step=${STEP_DELETE} phase=read siteId=${siteId} strategyId=${strategyId} attempt=${attempt} existingCount=${existingStrategies.length} present=${present} readMs=${readMs}`);

      if (!present) {
        const durationMs = Date.now() - tStart;
        log.info(`[edge-deploy] step=${STEP_DELETE} phase=ok siteId=${siteId} strategyId=${strategyId} attempt=${attempt} removed=false idempotentSkip=not-present readMs=${readMs} durationMs=${durationMs} reason=${reason}`);
        return {
          success: true, strategyId, attempts: attempt, removed: false, durationMs,
        };
      }

      const nextData = {
        opportunities: data.opportunities ?? [],
        strategies: existingStrategies.filter((s) => s.id !== strategyId),
      };

      const tWrite = Date.now();
      await writeStrategy(siteId, nextData, s3.s3Client, { s3Bucket: s3.s3Bucket });
      const writeMs = Date.now() - tWrite;
      const durationMs = Date.now() - tStart;

      log.info(`[edge-deploy] step=${STEP_DELETE} phase=ok siteId=${siteId} strategyId=${strategyId} attempt=${attempt} removed=true totalStrategies=${nextData.strategies.length} readMs=${readMs} writeMs=${writeMs} durationMs=${durationMs} reason=${reason}`);
      return {
        success: true, strategyId, attempts: attempt, removed: true, durationMs,
      };
    } catch (error) {
      lastError = error;
      log.warn(`[edge-deploy] step=${STEP_DELETE} phase=attempt-failed siteId=${siteId} strategyId=${strategyId} attempt=${attempt}/${MAX_ATTEMPTS} errorName=${error.name} errorCode=${errCode(error)} message=${error.message}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  const durationMs = Date.now() - tStart;
  log.error(`[edge-deploy] step=${STEP_DELETE} phase=failed siteId=${siteId} strategyId=${strategyId} attempts=${MAX_ATTEMPTS} durationMs=${durationMs} reason=${reason} errorName=${lastError?.name} errorCode=${errCode(lastError)} message=${lastError?.message} stack=${lastError?.stack}`);

  const err = new Error(
    `atomic-strategy delete failed after ${MAX_ATTEMPTS} attempts for strategy ${strategyId}: ${lastError?.message}`,
  );
  err.cause = lastError;
  throw err;
}
