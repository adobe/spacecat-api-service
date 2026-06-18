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

import crypto from 'crypto';
import {
  createResponse,
  unauthorized,
  badRequest,
  notFound,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

const ENVS = ['dev', 'stage', 'prod'];
// Cloud Manager service identifier, e.g. cm-p154709-e1629980.
const SERVICE_RE = /^cm-p\d+-e\d+$/;
// Aligns with the Fastly edge TTL for this path (fetch/100-aso-overlay-ttl.vcl).
const OVERLAY_TTL_SECONDS = 10;

/**
 * Constant-time string comparison. Returns false on length mismatch (without a
 * timing side channel) and never throws on non-string input.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Redirects Controller — serves the ASO dispatcher-layer redirect overlay
 * (`config/cm-pXXX-eYYY/redirects.txt`) from the per-env overlay S3 bucket.
 *
 * This is the "Lite-E" read path from ADR aso-dispatcher-overlay: Fastly proxies
 * `/config/*` to api-service (instead of signing SigV4 to S3 directly), and
 * api-service reads the object with its own Lambda execution role. The inbound
 * `X-ASO-API-Key` (unchanged from the static-key model) is validated here, so
 * the route is registered as anonymous in `access-control-util.js` (the same
 * pattern as the `/hooks/*` endpoints) and gates on the key in this controller.
 *
 * Server-side per-tenant authorization (resolving `(program, env)` against site
 * config / entitlements) is a tracked follow-up — see the ADR's Lite-E note.
 *
 * @param {object} ctx - Context with `s3`, `log`, and `env`.
 * @returns {object} controller with `getRedirects`.
 */
function RedirectsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { s3, log, env } = ctx;
  const { s3Client, GetObjectCommand } = s3;
  const {
    S3_ASO_OVERLAYS_BUCKET: bucketName,
    ASO_OVERLAY_API_KEY: apiKey,
  } = env;

  /**
   * GET /config/:env/:service/redirects.txt
   *
   * @param {object} context - Request context.
   * @param {object} context.params - `{ env, service }` from the path.
   * @param {object} context.pathInfo.headers - Request headers (`x-aso-api-key`).
   * @returns {Promise<Response>} 200 text/plain redirects file, or 401/400/404/500.
   */
  async function getRedirects(context) {
    const { env: reqEnv, service } = context.params;
    const headers = context.pathInfo?.headers || {};
    const providedKey = headers['x-aso-api-key'];

    // Auth — constant-time check of the inbound X-ASO-API-Key.
    if (!apiKey) {
      log.error('[aso-overlay] ASO_OVERLAY_API_KEY is not configured');
      return internalServerError('Overlay endpoint not configured');
    }
    if (!safeEqual(providedKey, apiKey)) {
      return unauthorized('Unauthorized: missing or invalid X-ASO-API-Key');
    }

    // Validate path parameters before touching S3.
    if (!ENVS.includes(reqEnv)) {
      return badRequest('Invalid environment');
    }
    if (!SERVICE_RE.test(service)) {
      return badRequest('Invalid service identifier');
    }
    if (!bucketName) {
      log.error('[aso-overlay] S3_ASO_OVERLAYS_BUCKET is not configured');
      return internalServerError('Overlay endpoint not configured');
    }

    // Read the overlay with the Lambda's own execution role (no SigV4 from caller).
    const key = `config/${service}/redirects.txt`;
    try {
      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3Client.send(command);
      const body = await response.Body.transformToString();
      return createResponse(body, 200, {
        'content-type': 'text/plain; charset=utf-8',
        // Cache-friendly for Fastly request-collapsing; edge TTL also set in VCL.
        'cache-control': `max-age=${OVERLAY_TTL_SECONDS}`,
      });
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return notFound('No redirect overlay found');
      }
      log.error(`[aso-overlay] failed to read ${key} from ${bucketName}`, err);
      return internalServerError('Failed to retrieve redirect overlay');
    }
  }

  return { getRedirects };
}

export default RedirectsController;
