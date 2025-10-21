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

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';

const IMPORT_TYPE = 'llmo-prompts-ahrefs';

/**
 * Builds the S3 key for LLMO prompts parquet file
 * @param {string} siteId - The site ID
 * @param {object} partitions - The partition values
 * @returns {string} The S3 key
 */
function buildS3Key(siteId, partitions) {
  // Build partition path with ALL partition keys in order, matching original behavior
  // Missing partition values are converted to empty strings
  const partitionKeys = ['region', 'category', 'topic', 'url', 'week'];
  const partitionParts = partitionKeys.map((key) => {
    const value = partitions[key] ?? '';
    return `${key}=${value}`;
  });

  const partitionPath = partitionParts.join('/');
  return `metrics/${siteId}/${IMPORT_TYPE}/${partitionPath}/data.parquet`;
}

/**
 * Reads LLMO prompts from S3 parquet file
 * @param {object} options - Options
 * @param {string} options.siteId - The site ID
 * @param {object} options.partitions - The partition values
 * @param {string} options.partitions.region - Region
 * @param {string} options.partitions.category - Category
 * @param {string} options.partitions.topic - Topic
 * @param {string} options.partitions.url - URL
 * @param {string} options.partitions.week - Week (e.g., '2025w03')
 * @param {object} context - Context object
 * @param {object} context.s3 - S3 client configuration
 * @param {object} context.s3.s3Client - S3 client
 * @param {string} context.s3.s3Bucket - S3 bucket name
 * @param {object} context.log - Logger
 * @returns {Promise<Array<object>|null>} Array of records or null if not found/error
 */
export async function loadLlmoPromptsFromS3({ siteId, partitions }, context) {
  const { log, s3 } = context;
  const { s3Client, s3Bucket } = s3;

  if (!s3Client || !s3Bucket) {
    log.error('S3 client or bucket not configured');
    return null;
  }

  const key = buildS3Key(siteId, partitions);

  try {
    log.debug(`Reading LLMO prompts from S3: ${key}`);

    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      }),
    );

    const buffer = await result.Body?.transformToByteArray();
    if (!buffer) {
      log.warn(`No data found in S3 at key: ${key}`);
      return null;
    }

    const records = await parquetReadObjects({ file: buffer });
    log.info(`Read ${records.length} LLMO prompt records from S3: ${key}`);

    return records;
  } catch (error) {
    // If file doesn't exist, return null instead of throwing
    if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
      log.info(`No LLMO prompts found at S3 key: ${key}`);
      return null;
    }

    log.error(`Error reading LLMO prompts from S3 at ${key}: ${error.message}`);
    return null;
  }
}
