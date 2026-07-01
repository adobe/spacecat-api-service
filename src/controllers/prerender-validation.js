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

import { badRequest, ok } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import { comparePage } from '../utils/prerender-compare.js';

/**
 * PrerenderValidationController provides the POST /prerender-validation/compare endpoint.
 * It fetches prerendered HTML from S3 and live HTML from the given URL, runs a
 * Myers word-level diff, and returns a structured comparison result.
 *
 * @param {object} ctx - The context object.
 * @param {object} ctx.log - The logger instance.
 * @param {object} ctx.env - Environment variables.
 * @param {string} ctx.env.S3_SCRAPER_BUCKET - S3 bucket holding prerendered HTML.
 * @param {object} ctx.s3 - S3 service from the s3ClientWrapper middleware.
 * @param {object} ctx.s3.s3Client - AWS S3Client instance.
 * @returns {object} Controller object with a `compare` method.
 */
function PrerenderValidationController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { log, env, s3 } = ctx;

  if (!isNonEmptyObject(s3)) {
    throw new Error('S3 client required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  const { s3Client, GetObjectCommand } = s3;
  const s3Bucket = env.S3_SCRAPER_BUCKET;

  /**
   * Compares the S3-prerendered HTML with the live Lambda-rendered HTML for the given URL.
   *
   * @param {object} context - The request context.
   * @param {object} context.data - The parsed request body.
   * @param {string} context.data.url - The URL to compare.
   * @returns {Promise<Response>} 200 OK with comparison metrics, or 400 on invalid input.
   */
  const compare = async (context) => {
    const { data } = context;

    if (!isNonEmptyObject(data) || !data.url || !isValidUrl(data.url)) {
      return badRequest('url is required and must be a valid URL');
    }

    const { url } = data;
    const result = await comparePage(url, s3Client, GetObjectCommand, s3Bucket, log);
    return ok(result);
  };

  return { compare };
}

export default PrerenderValidationController;
