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
 * Handles the LLMO rationale retrieval logic after site validation.
 * This function contains all the logic that comes after getSiteAndValidateLlmo().
 *
 * @param {object} context - The request context containing log, s3, env, and params
 * @returns {Promise<Response>} The rationale response
 */
export async function handleLlmoRationale(context) {
  const { log, s3, env } = context;
  const { siteId } = context.params;

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  log.info(`Getting LLMO rationale for site ${siteId}`);

  // Construct the S3 key for the human prompts popularity cache file
  const bucketName = `spacecat-${env.ENV}-mystique-assets`;
  const s3Key = `llm_cache/${siteId}/prompts/human_prompts_popularity_cache.json`;

  try {
    // Fetch the file from S3
    const { GetObjectCommand } = s3;
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const response = await s3.s3Client.send(command);
    const fileContent = await response.Body.transformToString();

    // Parse the JSON content
    const jsonData = JSON.parse(fileContent);

    return ok(jsonData);
  } catch (s3Error) {
    if (s3Error.name === 'NoSuchKey') {
      log.warn(`LLMO rationale file not found for site ${siteId} at ${s3Key}`);
      return notFound(`Rationale file not found for site ${siteId}`);
    }
    if (s3Error.name === 'NoSuchBucket') {
      log.error(`S3 bucket ${bucketName} not found`);
      return badRequest(`Storage bucket not found: ${bucketName}`);
    }
    if (s3Error instanceof SyntaxError) {
      log.error(`Invalid JSON in rationale file for site ${siteId}: ${s3Error.message}`);
      return badRequest('Invalid JSON format in rationale file');
    }

    log.error(`S3 error retrieving rationale for site ${siteId}: ${s3Error.message}`);
    return badRequest(`Error retrieving rationale: ${s3Error.message}`);
  }
}
