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

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Append an Atomic Strategy entry to the site's LLMO strategy blob in S3.
 *
 * Bounded-retry, idempotent on retry: if a strategy with the same id is
 * already present (because a previous attempt succeeded but this code did
 * not learn of it), it is treated as success.
 *
 * On terminal failure (all 3 attempts fail), emits a structured
 * [atomic-strategy-create-failed] log carrying enough metadata for an
 * operator to reconstruct the intended strategy, then THROWS. The new UI
 * (progress stepper, "View Strategy" button) treats the Atomic strategy as
 * a required projection of the experiment — a missing strategy means an
 * invisible experiment with no UI path. Callers must roll back any
 * side-effects (GeoExperiment row, DRS schedule, suggestion mutations)
 * accordingly.
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
 * @returns {Promise<{ success: true, strategyId: string, attempts: number }>}
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
    createdBy: profile?.email || 'edge-deploy',
    opportunities: [
      {
        opportunityId,
        link: opportunityLink,
        status: 'in_progress',
        assignee: profile?.email || 'edge-deploy',
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

      const { data, exists } = await readStrategy(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
      });
      const baseData = exists && data
        ? { opportunities: data.opportunities ?? [], strategies: data.strategies ?? [] }
        : { opportunities: [], strategies: [] };

      const alreadyPresent = baseData.strategies.some((s) => s.id === strategyId);
      if (alreadyPresent) {
        log.info(`[atomic-strategy-create] idempotent skip: strategy ${strategyId} already present (attempt ${attempt})`);
        return { success: true, strategyId, attempts: attempt };
      }

      const nextData = {
        ...baseData,
        strategies: [...baseData.strategies, newStrategy],
      };

      await writeStrategy(siteId, nextData, s3.s3Client, { s3Bucket: s3.s3Bucket });

      log.info(`[atomic-strategy-create] success: strategy ${strategyId} for site ${siteId} (attempt ${attempt})`);
      return { success: true, strategyId, attempts: attempt };
    } catch (error) {
      lastError = error;
      log.warn(`[atomic-strategy-create] attempt ${attempt}/${MAX_ATTEMPTS} failed for strategy ${strategyId}: ${error.message}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  log.error('[atomic-strategy-create-failed]', {
    siteId,
    geoExperimentId,
    strategyId,
    opportunityId,
    opportunityType,
    intendedStrategy: newStrategy,
    error: lastError?.message,
    stack: lastError?.stack,
  });

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
 * @param {Function} [params.sleep]         Override for tests.
 * @returns {Promise<{ success: true, strategyId: string, attempts: number, removed: boolean }>}
 * @throws {Error} If all attempts fail. Caller should log loudly — orphan
 *   strategy + missing experiment is the failure mode we accept here.
 */
export async function deleteAtomicStrategy({
  siteId,
  strategyId,
  s3,
  log,
  sleep = defaultSleep,
}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    try {
      if (BACKOFF_MS[attempt - 1] > 0) {
        await sleep(BACKOFF_MS[attempt - 1]);
      }

      const { data, exists } = await readStrategy(siteId, s3.s3Client, {
        s3Bucket: s3.s3Bucket,
      });

      if (!exists || !data) {
        log.info(`[atomic-strategy-delete] idempotent skip: blob does not exist for site ${siteId} (attempt ${attempt})`);
        return {
          success: true, strategyId, attempts: attempt, removed: false,
        };
      }

      const existingStrategies = data.strategies ?? [];
      const present = existingStrategies.some((s) => s.id === strategyId);
      if (!present) {
        log.info(`[atomic-strategy-delete] idempotent skip: strategy ${strategyId} not present (attempt ${attempt})`);
        return {
          success: true, strategyId, attempts: attempt, removed: false,
        };
      }

      const nextData = {
        opportunities: data.opportunities ?? [],
        strategies: existingStrategies.filter((s) => s.id !== strategyId),
      };

      await writeStrategy(siteId, nextData, s3.s3Client, { s3Bucket: s3.s3Bucket });

      log.info(`[atomic-strategy-delete] success: strategy ${strategyId} removed for site ${siteId} (attempt ${attempt})`);
      return {
        success: true, strategyId, attempts: attempt, removed: true,
      };
    } catch (error) {
      lastError = error;
      log.warn(`[atomic-strategy-delete] attempt ${attempt}/${MAX_ATTEMPTS} failed for strategy ${strategyId}: ${error.message}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  log.error('[atomic-strategy-delete-failed]', {
    siteId,
    strategyId,
    error: lastError?.message,
    stack: lastError?.stack,
  });

  const err = new Error(
    `atomic-strategy delete failed after ${MAX_ATTEMPTS} attempts for strategy ${strategyId}: ${lastError?.message}`,
  );
  err.cause = lastError;
  throw err;
}
