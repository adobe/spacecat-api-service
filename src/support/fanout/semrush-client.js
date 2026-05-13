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

import pLimit from 'p-limit';
import { KEYWORD_INTENT_ENUM } from '@quazar/ai-seo-ts/v2/fanout/enums_pb.js';

const RETRY_DELAYS_MS = [500, 2000, 8000];
const GRPC_RESOURCE_EXHAUSTED = 8; // RESOURCE_EXHAUSTED ≈ HTTP 429
const RATE_LIMIT_PATTERN = /rate.?limit|429/i;

const INTENT_NAME = {
  [KEYWORD_INTENT_ENUM.UNSPECIFIED]: 'UNSPECIFIED',
  [KEYWORD_INTENT_ENUM.COMMERCIAL]: 'COMMERCIAL',
  [KEYWORD_INTENT_ENUM.INFORMATIONAL]: 'INFORMATIONAL',
  [KEYWORD_INTENT_ENUM.NAVIGATIONAL]: 'NAVIGATIONAL',
  [KEYWORD_INTENT_ENUM.TRANSACTIONAL]: 'TRANSACTIONAL',
};

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function isRateLimited(err) {
  if (!err) {
    return false;
  }
  if (err.code === GRPC_RESOURCE_EXHAUSTED) {
    return true;
  }
  return RATE_LIMIT_PATTERN.test(err.message ?? '');
}

async function callBatchWithRetry(fanoutClient, payload, log) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential retries are intentional
      return await fanoutClient.resolveTopicMetrics(payload);
    } catch (e) {
      lastErr = e;
      if (!isRateLimited(e) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      log?.warn?.(`fanout: rate-limited, retrying in ${delay}ms (attempt ${attempt + 1})`);
      // eslint-disable-next-line no-await-in-loop -- sequential retries are intentional
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Picks the first intent from Semrush's multi-label intents[] and converts the
 * KEYWORD_INTENT_ENUM int to the string form we surface in the report JSON.
 *
 * Returns `undefined` (not `null`) when the input is empty so callers can use
 * the value directly in a spread without producing an explicit `null` field.
 */
export function intentNameFromEnum(intents) {
  if (!Array.isArray(intents) || intents.length === 0) {
    return undefined;
  }
  return INTENT_NAME[intents[0]] ?? 'UNSPECIFIED';
}

/**
 * Calls `FanoutService.resolveTopicMetrics` in batches with bounded
 * concurrency and exponential backoff on rate-limit errors.
 *
 * @param {object} opts
 * @param {object} opts.fanoutClient - The connectrpc client (from grpc-transport.js).
 * @param {string[]} opts.topics - Topic names to resolve. May exceed batchSize.
 * @param {number} opts.country - COUNTRY_ENUM int.
 * @param {number} opts.llm - LLM_ENUM int.
 * @param {number} [opts.concurrency=5] - In-flight batches cap.
 * @param {number} [opts.batchSize=100] - Topics per RPC call (Semrush max).
 * @param {object} [opts.log] - Optional logger.
 * @returns {Promise<{
 *   byOriginal: Map<string, object>,
 *   isoDate: string|null
 * }>}
 */
export async function resolveTopicMetricsBatched({
  fanoutClient,
  topics,
  country,
  llm,
  concurrency = 5,
  batchSize = 100,
  log,
}) {
  if (!topics?.length) {
    return { byOriginal: new Map(), isoDate: null };
  }

  const limit = pLimit(concurrency);
  const batches = chunk(topics, batchSize);

  const results = await Promise.all(batches.map((batch) => limit(async () => {
    const payload = { country, llm, topics: batch };
    return callBatchWithRetry(fanoutClient, payload, log);
  })));

  const byOriginal = new Map();
  let isoDate = null;
  for (const r of results) {
    if (isoDate == null && r?.isoDate) {
      isoDate = r.isoDate;
    }
    for (const tm of r?.topicMetrics ?? []) {
      byOriginal.set(tm.originalTopic, tm);
    }
  }
  return { byOriginal, isoDate };
}
