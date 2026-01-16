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
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const PRE_SIGNED_MAX_AGE_SECONDS = 6 * 60 * 60; // 6 hours

function parseS3Uri(s3Uri) {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  return {
    bucket: match[1],
    prefix: match[2],
  };
}

async function fileExists(s3, key, log, maxAttempts = 3, delayMs = 200) {
  const { bucket, prefix } = parseS3Uri(key);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log.info(`Checking if cached result exists with key: ${key} (attempt ${attempt})`);
      // eslint-disable-next-line no-await-in-loop
      await s3.s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: prefix }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound') {
        return false;
      }

      const isRetryable = err.$metadata?.httpStatusCode === 503 || err.name === 'ServiceUnavailable';

      if (!isRetryable || attempt === maxAttempts) {
        log.error(`Unexpected error when checking cache (attempt ${attempt}): ${err}. Skipping cache.`);
        return false;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise(
        (resolve) => {
          setTimeout(resolve, delayMs);
        },
      );
    }
  }

  return false;
}

async function getS3CachedResult(s3, key, log, ignoreNotFound = true) {
  try {
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
    if (err.name === 'NoSuchKey' && ignoreNotFound) {
      return null;
    }
    log.error(`Unexpected exception when trying to fetch cached results on key: ${key}. Ignoring error and continuing with normal query. Exception was ${err}`);
    return null;
  }
}

async function getSignedUrlWithRetries(s3, key, log, maxAttempts) {
  const exists = await fileExists(s3, key, log, maxAttempts);
  if (exists) {
    return getS3CachedResult(s3, key, log, false);
  }

  return null;
}

async function addResultJsonToCache(s3, cacheKey, result, log) {
  try {
    const { bucket: destBucket, prefix: destKey } = parseS3Uri(cacheKey);

    const compressedBody = await gzipAsync(JSON.stringify(result));

    const putCmd = new PutObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      Body: compressedBody,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    });

    await s3.s3Client.send(putCmd);
    return true;
  } catch (error) {
    log.error(`Failed to add result json to cache ${cacheKey}. Error was ${error}`);
    return false;
  }
}

async function getCachedJsonData(s3, key, log) {
  try {
    const { bucket, prefix } = parseS3Uri(key);

    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: prefix });
    const response = await s3.s3Client.send(getCmd);

    // Read the stream and decompress
    const chunks = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const compressedData = Buffer.concat(chunks);
    const decompressed = await gunzipAsync(compressedData);
    const jsonData = JSON.parse(decompressed.toString());

    return jsonData;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
      log.info(`Cached data not found for key: ${key}`);
      return null;
    }
    log.error(`Failed to fetch cached JSON data from ${key}: ${err.message}`);
    return null;
  }
}

export {
  fileExists,
  parseS3Uri,
  getS3CachedResult,
  addResultJsonToCache,
  getSignedUrlWithRetries,
  getCachedJsonData,
};
