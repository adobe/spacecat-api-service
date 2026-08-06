/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  badRequest, notFound,
} from '@adobe/spacecat-shared-http-utils';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { cachedOk } from '../../support/cached-response.js';
import { dateToIsoWeek } from '../../support/elements/week-utils.js';

const CLAIMS_PREFIX = 'brand_claims/llmo';
const WEEK_RE = /^\d{4}-W\d{2}$/;

/**
 * Latest run key for a site: the lexically-greatest `YYYY-Www` folder under the
 * site prefix. Returns null when no week folder exists yet (caller falls back to
 * the legacy flat key).
 */
async function latestWeekKey(s3, bucketName, siteId) {
  const prefix = `${CLAIMS_PREFIX}/${siteId}/`;
  const res = await s3.s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
    Delimiter: '/',
  }));
  const latest = (res.CommonPrefixes || [])
    .map((p) => p.Prefix.slice(prefix.length).replace(/\/$/, ''))
    .filter((seg) => WEEK_RE.test(seg))
    .sort()
    .pop();
  return latest ? `${prefix}${latest}/data.json.gz` : null;
}

/**
 * Handles the brand claims retrieval by generating a presigned S3 URL.
 * Data files are .json.gz and can exceed Lambda's 6MB response limit,
 * so this endpoint returns a presigned URL rather than the data directly.
 *
 * Runs are stored per ISO week (`{siteId}/{YYYY-Www}/data.json.gz`). With no
 * `date`, the latest week is served (falling back to the legacy flat
 * `{siteId}/data.json.gz` for sites not yet migrated); with `date`, the run for
 * that date's ISO week is served. A `model` selects a legacy flat
 * `{model}.json.gz` file, unchanged.
 *
 * @param {object} context - The request context containing log, s3, env, and params
 * @returns {Promise<Response>} The brand claims presigned URL response
 */
export async function handleBrandClaims(context) {
  const { log, s3 } = context;
  const { siteId } = context.params;
  const { model, date } = context.data;

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  const bucketName = s3.s3Bucket;
  if (!bucketName) {
    return badRequest('S3 bucket is not configured for this environment');
  }

  if (date !== undefined && Number.isNaN(new Date(date).getTime())) {
    return badRequest(`Invalid date parameter: ${date}`);
  }

  // Model files are managed flat (not week-partitioned); resolved synchronously.
  // Date resolves directly to its week. The default (no model, no date) needs a
  // list to find the latest week, so it is resolved inside the try below.
  let s3Key;
  if (model) {
    s3Key = `${CLAIMS_PREFIX}/${siteId}/${model}.json.gz`;
  } else if (date) {
    s3Key = `${CLAIMS_PREFIX}/${siteId}/${dateToIsoWeek(date.slice(0, 10))}/data.json.gz`;
  }

  log.info(`Getting brand claims for site ${siteId}, model: ${model || 'default'}${date ? `, date: ${date}` : ''}`);

  try {
    const { getSignedUrl, GetObjectCommand } = s3;

    if (!s3Key) {
      s3Key = (await latestWeekKey(s3, bucketName, siteId))
        || `${CLAIMS_PREFIX}/${siteId}/data.json.gz`;
    }

    // Presigning a GetObject URL is an offline operation and never checks that
    // the object exists, so without this HeadObject the endpoint would happily
    // hand out a URL that 404s on fetch. Verify existence first and return a
    // clean 404 otherwise (mirrors getFanoutReport). This also lets callers use
    // the endpoint as a cheap availability probe (e.g. an "all brands" view).
    await s3.s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const expiresIn = 60 * 60; // 1 hour
    const url = await getSignedUrl(s3.s3Client, command, { expiresIn });

    return cachedOk({
      siteId,
      model: model || 'default',
      presignedUrl: url,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (s3Error) {
    if (s3Error.name === 'NotFound' || s3Error.$metadata?.httpStatusCode === 404) {
      log.warn(`Brand claims file not found for site ${siteId} at ${s3Key}`);
      return notFound(`Brand claims data not found for site ${siteId}`);
    }
    if (s3Error.name === 'NoSuchBucket') {
      log.error(`S3 bucket ${bucketName} not found`);
      return badRequest(`Storage bucket not found: ${bucketName}`);
    }

    log.error(`S3 error retrieving brand claims for site ${siteId}: ${s3Error.message}`);
    return badRequest(`Error retrieving brand claims: ${s3Error.message}`);
  }
}
