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

import { found, notFound, forbidden } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';

const PRE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * File Controller provides functionality to handle file operations.
 * @param {object} ctx - Context object containing required services and configuration.
 * @param {object} ctx.s3 - S3 service containing client and utilities.
 * @param {object} ctx.s3.s3Client - The S3 client instance.
 * @param {function} ctx.s3.getSignedUrl - The function to generate pre-signed URLs.
 * @param {object} ctx.s3.GetObjectCommand - The S3 GetObjectCommand constructor.
 * @param {object} ctx.log - The logger instance.
 * @param {object} ctx.env - Environment configuration.
 * @param {string} ctx.env.S3_SCRAPER_BUCKET - The S3 bucket name.
 * @returns {object} The file controller object.
 */
function FileController(ctx) {
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
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.data.key - The S3 object key of the file to retrieve.
   * @returns {Promise<Response>} 302 Redirect to pre-signed URL for file access.
   */
  async function getFileByKey(requestContext) {
    const { siteId } = requestContext.params;
    const { key } = requestContext.data;

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

  return {
    getFileByKey,
  };
}

export default FileController;
