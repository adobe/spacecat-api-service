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
import { parse } from 'csv';
import {
  GetObjectCommand, ListObjectsV2Command, CopyObjectCommand,
} from '@aws-sdk/client-s3';

function parseS3Uri(s3Uri) {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${s3Uri}`);
  return {
    bucket: match[1],
    prefix: match[2] || '',
  };
}

async function parseCsvToJson(csvString) {
  return new Promise((resolve, reject) => {
    parse(csvString, { columns: true, skip_empty_lines: true }, (err, output) => {
      if (err) return reject(err);
      return resolve(output);
    });
  });
}

async function getS3CachedResult(s3, key, log) {
  try {
    log.info(`Checking for cached result key: ${key}`);
    const { bucket, prefix } = parseS3Uri(key);
    const command = new GetObjectCommand({ Bucket: bucket, Key: prefix });
    const response = await s3.send(command);
    const stream = response.Body;
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks).toString('utf-8');
    return data;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    log.error(`Unepected exception when trying to fetch cached results on key: ${key}. Ignoring error and continuing with normal query. Exception was ${err}`);
    return null;
  }
}

async function copyFirstCsvToCache(s3, outLocation, cacheKey, log) {
  try {
    const { bucket, prefix } = parseS3Uri(outLocation);
    const listCmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 });
    const listed = await s3.send(listCmd);
    const csvObj = (listed.Contents || [])
      .filter((obj) => obj.Key.endsWith('.csv'))
      .reduce((latest, file) => (
        !latest || file.LastModified > latest.LastModified ? file : latest
      ), null);
    if (!csvObj) throw new Error('No CSV result found in Athena output');
    const { bucket: destBucket, prefix: destKey } = parseS3Uri(cacheKey);
    const copyCmd = new CopyObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      CopySource: `${bucket}/${csvObj.Key}`,
      ContentType: 'text/csv',
    });
    await s3.send(copyCmd);
    return true;
  } catch (error) {
    log.error(`Failed to copy query result to cache ${cacheKey} from: ${outLocation} with error ${error}. Continuing with excecution without caching`);
    return false;
  }
}

export {
  parseS3Uri,
  parseCsvToJson,
  getS3CachedResult,
  copyFirstCsvToCache,
};
