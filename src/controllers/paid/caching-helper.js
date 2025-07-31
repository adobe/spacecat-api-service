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
  GetObjectCommand, PutObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';

const PRE_SIGNED_MAX_AGE_SECONDS = 6 * 60 * 60; // 6 hours

function parseS3Uri(s3Uri) {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  return {
    bucket: match[1],
    prefix: match[2],
  };
}

async function fileExists(s3, key, log) {
  try {
    log.info(`Checking if cached result exists with key: ${key}`);
    const { bucket, prefix } = parseS3Uri(key);
    await s3.s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: prefix }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound') {
      return false;
    }
    log.error(`Unexpected error when checking if cached result exists: ${err}. Continuing execution without using cache`);
    return false;
  }
}

async function getS3CachedResult(s3, key, log) {
  try {
    log.info(`Fetching cached result key: ${key}`);
    const { bucket, prefix } = parseS3Uri(key);

    const getCachedFile = new GetObjectCommand({ Bucket: bucket, Key: prefix });
    const { s3Client, getSignedUrl } = s3;

    const presignedUrl = await getSignedUrl(
      s3Client,
      getCachedFile,
      { expiresIn: PRE_SIGNED_MAX_AGE_SECONDS },
    );
    return presignedUrl;
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      return null;
    }
    log.error(`Unepected exception when trying to fetch cached results on key: ${key}. Ignoring error and continuing with normal query. Exception was ${err}`);
    return null;
  }
}

async function addResultJsonToCache(s3, cacheKey, result, log) {
  try {
    const { bucket: destBucket, prefix: destKey } = parseS3Uri(cacheKey);
    const putCmd = new PutObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
    });
    await s3.s3Client.send(putCmd);
    return true;
  } catch (error) {
    log.error(`Failed to add result json to cache ${cacheKey}. Error was ${error}`);
    return false;
  }
}

export {
  fileExists,
  parseS3Uri,
  getS3CachedResult,
  addResultJsonToCache,
};
