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

import {
  createResponse,
  badRequest,
  notFound,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { getHeader } from '../support/http-headers.js';

// Cloud Manager service identifier, e.g. cm-p154709-e1629980. Digit runs are
// capped to a realistic length to avoid arbitrarily long lookups; the capture
// groups yield the program id (pXXXX) and environment id (eYYYY).
const SERVICE_RE = /^cm-p(\d{1,10})-e(\d{1,10})$/;
// Aligns with the Fastly edge TTL for this path (fetch/100-aso-overlay-ttl.vcl).
const OVERLAY_TTL_SECONDS = 10;

// RFC 7232 §2.3.2 weak comparison: two validators are equal if their opaque
// tags match character-by-character *ignoring* the optional `W/` weak-prefix.
// If-None-Match uses weak comparison (§3.2), so `W/"abc"` and `"abc"` match.
function stripWeakPrefix(v) {
  const t = v.trim();
  return t.startsWith('W/') ? t.slice(2) : t;
}

// RFC 7232 §3.2: If-None-Match matches when the header value is "*" (any
// existing resource) or when any comma-separated validator in the list weakly
// compares equal to the current ETag. S3 emits strong quoted ETags, but we
// still normalize both sides so a client that tags its cached validator weak
// (some caches do) matches correctly.
function ifNoneMatchMatches(headerValue, currentEtag) {
  if (!headerValue || !currentEtag) {
    return false;
  }
  const trimmed = headerValue.trim();
  if (trimmed === '*') {
    return true;
  }
  const normCurrent = stripWeakPrefix(currentEtag);
  return trimmed.split(',').some((tok) => stripWeakPrefix(tok) === normCurrent);
}

/**
 * Redirects Controller — serves the ASO dispatcher-layer redirect overlay
 * (`config/cm-pXXX-eYYY/redirects.txt`) from the per-env overlay S3 bucket.
 *
 * This is the "Lite-E" read path from ADR aso-dispatcher-overlay: Fastly proxies
 * `/config/*` to api-service (instead of signing SigV4 to S3 directly), and
 * api-service reads the object with its own Lambda execution role.
 *
 * AuthN is handled upstream by `AsoOverlayKeyHandler` (validates the inbound
 * `X-ASO-API-Key`), so by the time this controller runs the caller is the
 * dispatcher. This controller performs per-request AUTHZ: it resolves the Cloud
 * Manager `(program, environment)` to a provisioned, ASO-entitled site and only
 * then serves the overlay. Every authz failure returns an indistinguishable 404
 * so the endpoint cannot be used to enumerate which programs exist or are
 * entitled (this is the property that makes Lite-E safer than a bare shared key
 * — see the ADR's OQ-1 / Lite-E note).
 *
 * @param {object} ctx - Context with `s3`, `dataAccess`, `log`, and `env`.
 * @returns {object} controller with `getRedirects`.
 */
function RedirectsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const {
    s3, dataAccess, log, env,
  } = ctx;
  const { s3Client, GetObjectCommand } = s3;
  const { Site, Entitlement, SiteEnrollment } = dataAccess;
  const { S3_ASO_OVERLAYS_BUCKET: bucketName } = env;

  /**
   * GET /config/:service/redirects.txt
   *
   * @param {object} context - Request context.
   * @param {object} context.params - `{ service }` from the path (cm-pXXX-eYYY).
   * @returns {Promise<Response>} 200 text/plain redirects file, or 400/404/500.
   */
  async function getRedirects(context) {
    const { service } = context.params;

    const match = SERVICE_RE.exec(service);
    if (!match) {
      return badRequest('Invalid service identifier');
    }
    if (!bucketName) {
      log.error('[aso-overlay] S3_ASO_OVERLAYS_BUCKET is not configured');
      return internalServerError('Overlay endpoint not configured');
    }

    const [, programId, environmentId] = match;

    // Resolve (program, env) -> Site via the indexed external-id accessor. The
    // p<programId>/e<environmentId> encoding matches Site.computeExternalIds for
    // AEM CS sites (see spacecat-shared site.model.js / SiteCollection.findByPreviewURL).
    const site = await Site.findByExternalOwnerIdAndExternalSiteId(
      `p${programId}`,
      `e${environmentId}`,
    );
    if (!site) {
      log.info('[aso-overlay] no site resolves for service', { service });
      return notFound('No redirect overlay found');
    }

    // Authorize: the site's org must hold an ASO entitlement AND the site must be
    // enrolled in it. Same gate pattern as edge-routing-auth / tier-client.
    const entitlement = await Entitlement.findByOrganizationIdAndProductCode(
      site.getOrganizationId(),
      EntitlementModel.PRODUCT_CODES.ASO,
    );
    if (!entitlement) {
      log.info('[aso-overlay] site org not ASO-entitled', { siteId: site.getId() });
      return notFound('No redirect overlay found');
    }
    const enrollments = await SiteEnrollment.allBySiteId(site.getId());
    const enrolled = enrollments.some((se) => se.getEntitlementId() === entitlement.getId());
    if (!enrolled) {
      log.info('[aso-overlay] site not enrolled for ASO', { siteId: site.getId() });
      return notFound('No redirect overlay found');
    }

    // Read the overlay with the Lambda's own execution role (no SigV4 from caller).
    const key = `config/${service}/redirects.txt`;
    try {
      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3Client.send(command);

      // S3 returns the object's ETag already quoted (RFC 7232 opaque-tag form),
      // e.g. `"d41d8cd98f00b204e9800998ecf8427e"`. Passthrough gives the client
      // a strong validator without hashing the body — the writer is single-part,
      // so this is an MD5 today; multipart uploads would surface an opaque S3
      // ETag which is still a valid strong validator for If-None-Match compares.
      // S3 returns the object's ETag already quoted (RFC 7232 opaque-tag form),
      // e.g. `"d41d8cd98f00b204e9800998ecf8427e"`. Passthrough gives the client
      // a strong validator without hashing the body — the writer is single-part
      // (small overlays), so this is an MD5 today; multipart uploads would
      // surface an opaque S3 ETag which is still a valid strong validator.
      // Missing ETag (defensive — S3 always returns one for a successful GET,
      // but a mock or a future storage backend might not) simply disables the
      // conditional-GET path and we serve the body unconditionally.
      const etag = response.ETag;
      const ifNoneMatch = getHeader(context, 'if-none-match');
      if (etag && ifNoneMatchMatches(ifNoneMatch, etag)) {
        log.info('[aso-overlay] 304 Not Modified', { service, etag });
        // 304 MUST NOT include a message body (RFC 7230 §3.3.3); MUST include
        // any Cache-Control/ETag we would have sent on a 200 (RFC 7232 §4.1).
        // We set content-type explicitly to text/plain — createResponse would
        // otherwise default to application/json (misleading on this endpoint)
        // and would run the JSON stringify branch on the empty body.
        return createResponse('', 304, {
          'content-type': 'text/plain; charset=utf-8',
          etag,
          'cache-control': `max-age=${OVERLAY_TTL_SECONDS}`,
        });
      }

      const body = await response.Body.transformToString();
      return createResponse(body, 200, {
        'content-type': 'text/plain; charset=utf-8',
        // Cache-friendly for Fastly request-collapsing; edge TTL also set in VCL.
        'cache-control': `max-age=${OVERLAY_TTL_SECONDS}`,
        // Include ETag so a subsequent poll can conditionally revalidate.
        ...(etag ? { etag } : {}),
      });
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (err.name === 'NoSuchKey' || code === 404) {
        return notFound('No redirect overlay found');
      }
      // The reader role intentionally lacks s3:ListBucket (least privilege, no key
      // enumeration), so a *missing* object surfaces as 403 AccessDenied rather
      // than 404. The authz above already proved the tenant is legitimate, so map
      // it to 404 for the caller — but log at error level so a genuine permissions
      // misconfiguration (every request 403, e.g. the IAM grant not applied) stays
      // alertable. See spacecat-infrastructure#620.
      if (err.name === 'AccessDenied' || code === 403) {
        log.error(
          `[aso-overlay] AccessDenied reading ${key} from ${bucketName} `
          + '— missing object or missing s3:GetObject grant',
          err,
        );
        return notFound('No redirect overlay found');
      }
      log.error(`[aso-overlay] failed to read ${key} from ${bucketName}`, err);
      return internalServerError('Failed to retrieve redirect overlay');
    }
  }

  return { getRedirects };
}

export default RedirectsController;
