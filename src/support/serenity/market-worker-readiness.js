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

// @ts-check

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * Fail-closed consumer-readiness gate (spacecat-infrastructure#780). The market
 * worker's ESM, DLQ, cross-account DRS invoke IAM and env are provisioned by
 * infra#780 and only become live after an operator runs a post-deploy synthetic
 * and flips the SSM param to `"true"`. Until then the producer must NOT enqueue a
 * generation job (it would sit unconsumed). api-service reads the SSM param and
 * only enqueues when it reads exactly `"true"` — any other value, a read error,
 * or a missing param is treated as NOT ready.
 *
 * The value is cached briefly so a burst of onboards does not issue a
 * GetParameter per request; the operator's flip therefore takes effect within one
 * cache window rather than instantly, which is acceptable for a rollout gate.
 */

/** SSM parameter path the operator flips to enable the consumer. */
export const CONSUMER_READY_PARAM = '/spacecat/serenity-market-worker/consumer-ready';

/** How long a readiness read is cached (ms). */
export const READINESS_CACHE_TTL_MS = 60 * 1000;

/** @type {{ value: boolean, expiresAt: number } | null} */
let cache = null;

/**
 * Resets the module-level cache. Test seam only.
 */
export function resetReadinessCache() {
  cache = null;
}

/**
 * @param {object} context - worker/request context (`runtime.region`, `log`).
 * @returns {SSMClient}
 */
function buildSsmClient(context) {
  return new SSMClient({ region: context?.runtime?.region });
}

/**
 * Reads the consumer-readiness gate, fail-closed and cached.
 *
 * @param {object} context - context providing `runtime.region` and `log`.
 * @param {object} [opts]
 * @param {SSMClient} [opts.ssmClient] - injectable client (tests).
 * @param {number} [opts.now] - injectable clock (ms epoch) for tests.
 * @returns {Promise<boolean>} true ONLY when the SSM param reads exactly `"true"`.
 */
export async function isMarketConsumerReady(context, { ssmClient, now = Date.now() } = {}) {
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  const client = ssmClient ?? buildSsmClient(context);
  let ready = false;
  try {
    const res = await client.send(new GetParameterCommand({ Name: CONSUMER_READY_PARAM }));
    ready = res?.Parameter?.Value === 'true';
  } catch (error) {
    // Fail closed: a missing param or a read error means "not ready" — never
    // enqueue a job the consumer cannot yet process.
    context?.log?.warn?.(`[market-worker-readiness] could not read ${CONSUMER_READY_PARAM}; treating as not ready: ${error.message}`);
    ready = false;
  }
  cache = { value: ready, expiresAt: now + READINESS_CACHE_TTL_MS };
  return ready;
}
