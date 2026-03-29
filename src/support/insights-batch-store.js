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

const BATCH_PREFIX = 'insights-batches';
const BATCH_TTL_DAYS = 7;
const S3_GET_CONCURRENCY = 50;
const TERMINAL_STATUSES = ['failed', 'not_found', 'enqueue_failed'];

function batchKey(batchId) {
  return `${BATCH_PREFIX}/${batchId}`;
}

function putObject(s3, key, data) {
  const { s3Client, s3Bucket, PutObjectCommand } = s3;
  return s3Client.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

async function getObject(s3, key) {
  const { s3Client, s3Bucket, GetObjectCommand } = s3;
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: s3Bucket,
    Key: key,
  }));
  return JSON.parse(await response.Body.transformToString());
}

/**
 * Write the batch manifest to S3 after enqueuing.
 * Contains the list of sites, enqueue failures, and the original payload for re-runs.
 */
export async function writeBatchManifest(s3, batchId, manifest) {
  await putObject(s3, `${batchKey(batchId)}/manifest.json`, manifest);
}

/**
 * Write a per-site result to S3 after the worker processes it.
 * Each site gets its own key — no read-modify-write contention.
 */
export async function writeSiteResult(s3, batchId, siteId, result) {
  await putObject(s3, `${batchKey(batchId)}/results/${siteId}.json`, result);
}

/**
 * List all S3 keys under a prefix, handling pagination.
 */
async function listAllKeys(s3, prefix) {
  const { s3Client, s3Bucket, ListObjectsV2Command } = s3;
  const keys = [];
  let continuationToken;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: s3Bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    // eslint-disable-next-line no-await-in-loop
    const response = await s3Client.send(cmd);
    const pageKeys = (response.Contents || []).map((obj) => obj.Key);
    keys.push(...pageKeys);
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys;
}

/**
 * Fetch S3 objects in parallel with controlled concurrency.
 * Gracefully handles individual read failures — returns null for failed reads.
 */
async function fetchResults(s3, keys) {
  const results = new Map();

  for (let i = 0; i < keys.length; i += S3_GET_CONCURRENCY) {
    const chunk = keys.slice(i, i + S3_GET_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const chunkResults = await Promise.all(
      chunk.map(async (key) => {
        try {
          return await getObject(s3, key);
        } catch {
          return null;
        }
      }),
    );
    for (const result of chunkResults) {
      if (result?.siteId) {
        results.set(result.siteId, result);
      }
    }
  }

  return results;
}

/**
 * Assemble the status response from manifest and per-site results.
 */
function assembleBatchResponse(batchId, manifest, siteResults) {
  const sites = {};
  const failedSiteIds = [];
  let completed = 0;
  let failed = 0;
  let pending = 0;

  for (const siteId of manifest.enqueuedSiteIds) {
    const result = siteResults.get(siteId);
    if (result) {
      sites[siteId] = {
        status: result.status,
        completedAt: result.completedAt,
        ...(result.error ? { error: result.error } : {}),
      };
      if (TERMINAL_STATUSES.includes(result.status)) {
        failedSiteIds.push(siteId);
        failed += 1;
      } else {
        completed += 1;
      }
    } else {
      sites[siteId] = { status: 'pending' };
      pending += 1;
    }
  }

  for (const entry of (manifest.failedToEnqueue || [])) {
    sites[entry.siteId] = { status: 'enqueue_failed', reason: entry.reason };
    failedSiteIds.push(entry.siteId);
    failed += 1;
  }

  return {
    batchId,
    status: pending > 0 ? 'in_progress' : 'completed',
    createdAt: manifest.createdAt,
    progress: {
      total: manifest.totalSites, completed, failed, pending,
    },
    failedSiteIds,
    failedToEnqueue: manifest.failedToEnqueue || [],
    sites,
  };
}

/**
 * Read the batch manifest and all per-site results, then assemble the status response.
 *
 * @param {Object} s3 - S3 context with s3Client, s3Bucket, and command constructors.
 * @param {string} batchId - The batch UUID.
 * @returns {Object|null} Assembled batch status, or null if batch not found.
 */
export async function readBatchStatus(s3, batchId) {
  let manifest;
  try {
    manifest = await getObject(s3, `${batchKey(batchId)}/manifest.json`);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }

  if (manifest.expiresAt && new Date(manifest.expiresAt) < new Date()) {
    return {
      batchId,
      status: 'expired',
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
    };
  }

  const resultKeys = await listAllKeys(s3, `${batchKey(batchId)}/results/`);
  const siteResults = await fetchResults(s3, resultKeys);

  return assembleBatchResponse(batchId, manifest, siteResults);
}

export { BATCH_TTL_DAYS };
