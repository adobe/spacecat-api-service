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

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

const V2_CONFIG_PREFIX = 'customer-config-v2';

/**
 * Gets the S3 key for a customer config v2
 * @param {string} organizationId - The SpaceCat Organization ID
 * @returns {string} S3 key
 */
function getS3Key(organizationId) {
  return `${V2_CONFIG_PREFIX}/${organizationId}/config.json`;
}

/**
 * Fetches customer config v2 from S3
 * @param {string} organizationId - The SpaceCat Organization ID
 * @param {object} s3Client - AWS S3 client
 * @param {string} s3Bucket - S3 bucket name
 * @returns {Promise<object|null>} Customer config or null if not found
 */
export async function getCustomerConfigV2FromS3(organizationId, s3Client, s3Bucket) {
  if (!hasText(organizationId)) {
    throw new Error('Organization ID is required');
  }

  if (!s3Client || !hasText(s3Bucket)) {
    throw new Error('S3 client and bucket are required');
  }

  const key = getS3Key(organizationId);

  try {
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    });

    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Saves customer config v2 to S3
 * @param {string} organizationId - The SpaceCat Organization ID
 * @param {object} config - Customer config object
 * @param {object} s3Client - AWS S3 client
 * @param {string} s3Bucket - S3 bucket name
 * @returns {Promise<void>}
 */
export async function saveCustomerConfigV2ToS3(organizationId, config, s3Client, s3Bucket) {
  if (!hasText(organizationId)) {
    throw new Error('Organization ID is required');
  }

  if (!isNonEmptyObject(config)) {
    throw new Error('Config is required');
  }

  if (!s3Client || !hasText(s3Bucket)) {
    throw new Error('S3 client and bucket are required');
  }

  const key = getS3Key(organizationId);

  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: JSON.stringify(config, null, 2),
    ContentType: 'application/json',
  });

  await s3Client.send(command);
}

/**
 * Checks if customer config v2 exists in S3
 * @param {string} organizationId - The SpaceCat Organization ID
 * @param {object} s3Client - AWS S3 client
 * @param {string} s3Bucket - S3 bucket name
 * @returns {Promise<boolean>}
 */
export async function customerConfigV2Exists(organizationId, s3Client, s3Bucket) {
  const config = await getCustomerConfigV2FromS3(organizationId, s3Client, s3Bucket);
  return config !== null;
}

export default {
  getCustomerConfigV2FromS3,
  saveCustomerConfigV2ToS3,
  customerConfigV2Exists,
};
