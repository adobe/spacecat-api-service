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
 * operator to reconstruct the intended strategy. Does NOT throw — callers
 * have already created the GeoExperiment, which is the user's primary asset.
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
 * @returns {Promise<{ success: boolean, strategyId: string, attempts: number }>}
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

  return { success: false, strategyId, attempts: MAX_ATTEMPTS };
}
