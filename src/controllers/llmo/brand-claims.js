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
  ok, badRequest, notFound,
} from '@adobe/spacecat-shared-http-utils';

/**
 * Handles the brand claims retrieval by generating a presigned S3 URL.
 * Data files are .json.gz and can exceed Lambda's 6MB response limit,
 * so this endpoint returns a presigned URL rather than the data directly.
 *
 * @param {object} context - The request context containing log, s3, env, and params
 * @returns {Promise<Response>} The brand claims presigned URL response
 */
export async function handleBrandClaims(context) {
  const { log, s3, env } = context;
  const { siteId } = context.params;
  const { model } = context.data;

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  const bucketName = `spacecat-${env.ENV}-mystique-assets`;
  const s3Key = model
    ? `brand_claims/${siteId}/${model}.json.gz`
    : `brand_claims/${siteId}/data.json.gz`;

  log.info(`Getting brand claims for site ${siteId}, model: ${model || 'default'}`);

  try {
    const { getSignedUrl, GetObjectCommand } = s3;
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const expiresIn = 60 * 60; // 1 hour
    const url = await getSignedUrl(s3.s3Client, command, { expiresIn });

    return ok({
      siteId,
      model: model || 'default',
      presignedUrl: url,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (s3Error) {
    if (s3Error.name === 'NoSuchKey') {
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
