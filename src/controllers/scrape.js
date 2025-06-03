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
  found,
  notFound,
  forbidden,
  badRequest,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import { buildS3Prefix, ErrorWithStatusCode } from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';

const PRE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Scrape Controller provides functionality to handle scrape operations.
 * @param {object} ctx - Context object containing required services and configuration.
 * @param {object} ctx.s3 - S3 service containing client and utilities.
 * @param {object} ctx.s3.s3Client - The S3 client instance.
 * @param {function} ctx.s3.getSignedUrl - The function to generate pre-signed URLs.
 * @param {object} ctx.s3.GetObjectCommand - The S3 GetObjectCommand constructor.
 * @param {object} ctx.log - The logger instance.
 * @param {object} ctx.env - Environment configuration.
 * @param {string} ctx.env.S3_SCRAPER_BUCKET - The S3 bucket name.
 * @returns {object} The scrape controller object.
 */
function ScrapeController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const {
    dataAccess,
    s3,
    log,
    env,
  } = ctx;

  const { s3Client, getSignedUrl, GetObjectCommand } = s3;
  const { S3_SCRAPER_BUCKET: bucketName } = env;
  const { Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Get a file by its storage key.
   * @param {object} context - Context of the request.
   * @param {string} context.data.key - The S3 object key of the file to retrieve.
   * @returns {Promise<Response>} 302 Redirect to pre-signed URL for file access.
   */
  async function getFileByKey(context) {
    const { siteId } = context.params;
    const { key } = context.data;

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can get files');
    }

    if (!key) {
      throw new ErrorWithStatusCode('File key is required', 400);
    }

    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });
      const presignedUrl = await getSignedUrl(
        s3Client,
        command,
        { expiresIn: PRE_SIGNED_URL_TTL_SECONDS },
      );

      return found(presignedUrl);
    } catch (err) {
      log.error(`Failed to generate pre-signed S3 URL for key: ${key}`, err);
      if (err.name === 'NoSuchKey') {
        throw new ErrorWithStatusCode('File not found', 404);
      }
      throw new ErrorWithStatusCode('Error occurred generating a pre-signed URL', 500);
    }
  }

  async function listScrapedContentFiles(context) {
    try {
      const { siteId, type } = context.params ?? {};

      if (!isValidUUID(siteId)) {
        return badRequest('Site ID required');
      }
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Only users belonging to the organization can get scraped content files');
      }

      if (!['scrapes', 'imports', 'accessibility'].includes(type)) {
        return badRequest('Type must be either "scrapes" or "imports" or "accessibility"');
      }

      // Query params
      const data = context.data || {};
      const path = data.path || '';
      const rootOnly = data.rootOnly === 'true';
      const pageSize = parseInt(data.pageSize, 10) || 100;
      const { pageToken } = data;

      // Build S3 prefix and params
      const s3Prefix = buildS3Prefix(type, siteId, path);
      const params = {
        Bucket: bucketName,
        Prefix: s3Prefix,
        MaxKeys: rootOnly ? 100 : pageSize,
        ...(rootOnly ? { Delimiter: '/' } : {}),
        ...(pageToken ? { ContinuationToken: decodeURIComponent(pageToken) } : {}),
      };

      // Execute S3 list command
      const { ListObjectsV2Command } = s3;
      const listCommand = new ListObjectsV2Command(params);

      const result = await s3Client.send(listCommand).catch((error) => {
        log.error(`Failed to list S3 objects for site ${siteId}: ${error.message}`);
        throw new Error('S3 error: Failed to list files');
      });

      if (!result?.Contents) {
        return ok({ items: [], nextPageToken: null });
      }

      // Process files
      const files = result.Contents.map((obj) => ({
        name: obj.Key.replace(s3Prefix, ''),
        type: obj.Key.split('.').pop(),
        size: obj.Size,
        lastModified: obj.LastModified,
        key: obj.Key,
      })).filter((file) => file.name);

      return ok({
        items: files,
        nextPageToken: result.NextContinuationToken
          ? encodeURIComponent(result.NextContinuationToken)
          : null,
      });
    } catch (error) {
      log.error(`Error in listScrapedContentFiles for site ${context.params?.siteId}: ${error.message}`);
      throw error;
    }
  }

  return {
    getFileByKey,
    listScrapedContentFiles,
  };
}

export default ScrapeController;
