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
  ok, notFound, internalServerError,
} from '@adobe/spacecat-shared-http-utils';

const DEMO_BRAND_PRESENCE_KEY = 'workspace/llmo/demo/summit-demo-brand-presence.json';
const DEMO_RECOMMENDATIONS_KEY = 'workspace/llmo/demo/summit-demo-recommendations.json';

const EXPIRES_IN = 60 * 60; // 1 hour

async function generateDemoPresignedUrl(context, s3Key, label) {
  const { log, s3 } = context;

  if (!s3 || !s3.s3Client) {
    return internalServerError('S3 storage is not configured for this environment');
  }

  const bucketName = s3.s3Bucket;
  if (!bucketName) {
    return internalServerError('S3 bucket is not configured for this environment');
  }

  log.info(`Getting demo fixture: ${label}`);

  try {
    const { getSignedUrl, GetObjectCommand } = s3;
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const url = await getSignedUrl(s3.s3Client, command, { expiresIn: EXPIRES_IN });

    return ok({
      presignedUrl: url,
      expiresAt: new Date(Date.now() + EXPIRES_IN * 1000).toISOString(),
    });
  } catch (s3Error) {
    if (s3Error.name === 'NoSuchKey') {
      log.warn(`Demo fixture not found at ${s3Key}`);
      return notFound(`Demo fixture not found: ${label}`);
    }

    log.error(`S3 error retrieving demo fixture ${label}: ${s3Error.message}`);
    return internalServerError('Failed to retrieve demo fixture');
  }
}

/**
 * Returns a presigned S3 URL for the summit demo brand presence fixture.
 *
 * @param {object} context - The request context containing log and s3
 * @returns {Promise<Response>} The presigned URL response
 */
export async function handleDemoBrandPresence(context) {
  return generateDemoPresignedUrl(context, DEMO_BRAND_PRESENCE_KEY, 'brand-presence');
}

/**
 * Returns a presigned S3 URL for the summit demo recommendations fixture.
 *
 * @param {object} context - The request context containing log and s3
 * @returns {Promise<Response>} The presigned URL response
 */
export async function handleDemoRecommendations(context) {
  return generateDemoPresignedUrl(context, DEMO_RECOMMENDATIONS_KEY, 'recommendations');
}
