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
// Single source of truth so the 200 and 304 responses can't drift under future edits.
const OVERLAY_TTL_SECONDS = 10;
const OVERLAY_CACHE_CONTROL = `max-age=${OVERLAY_TTL_SECONDS}`;
// Every non-2xx/3xx response advertises `no-store` so Fastly (and any other
// intermediary) will not cache negative responses. Without this, the Fastly VCL
// at `fastly/vcl/aso-prod/fetch/100-aso-overlay-ttl.vcl` applies its default
// TTL (10s) + stale-while-revalidate (30s) + stale_if_error (86400s) uniformly
// across all statuses, which pins a 404 for up to 24 h under any subsequent
// origin blip — creating the customer-provisioning race where a dispatcher
// poll made *before* a site's ASO entitlement lands keeps serving stale 404s
// long after provisioning completes. `no-store` at the origin overrides that
// VCL default (Fastly respects the response Cache-Control) so the negative
// cache never sticks. Belt-and-braces: even if the VCL is later tightened
// to short-TTL 4xx, the origin still declares "do not cache" and any future
// consumer (different CDN, direct-to-origin traffic, offline replay) gets the
// correct semantics without needing to replicate the VCL rule.
const NEGATIVE_CACHE_CONTROL = 'no-store';
const NO_STORE_HEADERS = { 'cache-control': NEGATIVE_CACHE_CONTROL };

// RFC 7232 §2.3 opaque-tag: the validator MUST be a double-quoted string,
// optionally preceded by the case-sensitive `W/` weak indicator. Anything that
// doesn't parse as `"..."` (e.g. a shell-stripped `abc123`) is rejected — better
// to force a body re-fetch than silently 304 against a corrupted validator.
// `W/` is intentionally case-sensitive per §2.3; lowercase `w/` is malformed
// and we do not normalize it.
function normalizeValidator(v) {
  const t = v.trim();
  const stem = t.startsWith('W/') ? t.slice(2) : t;
  if (stem.length < 2 || stem[0] !== '"' || stem[stem.length - 1] !== '"') {
    return null;
  }
  return stem;
}

// RFC 7232 §3.2: If-None-Match matches when the header value is `*` (any
// existing representation) or when any comma-separated validator in the list
// weakly compares equal to the current ETag. S3 emits strong quoted ETags; we
// still normalize both sides so a client tagging its cached validator weak
// (`W/"..."`) matches. Note: this assumes opaque-tags don't contain commas,
// which is true for every ETag S3 produces (hex digests / opaque part IDs).
//
// We deliberately compare in-app rather than pushing `IfNoneMatch` down to
// `GetObjectCommand`: the S3 SDK only accepts a single strong validator, so
// `*` and multi-value lists would still need app handling. At current fleet
// scale the ~10 KB overlay body is cheap; revisit if bandwidth or Lambda
// memory becomes measurable.
function ifNoneMatchMatches(headerValue, currentEtag) {
  if (!headerValue) {
    return false;
  }
  const trimmed = headerValue.trim();
  // `*` matches any existing representation — the caller has reached here
  // only after a successful S3 GET, so a representation exists regardless
  // of whether S3 surfaced an ETag on the response.
  if (trimmed === '*') {
    return true;
  }
  const normCurrent = normalizeValidator(currentEtag || '');
  if (!normCurrent) {
    return false;
  }
  return trimmed.split(',').some((tok) => {
    const norm = normalizeValidator(tok);
    return norm !== null && norm === normCurrent;
  });
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
      return badRequest('Invalid service identifier', NO_STORE_HEADERS);
    }
    if (!bucketName) {
      log.error('[aso-overlay] S3_ASO_OVERLAYS_BUCKET is not configured');
      return internalServerError('Overlay endpoint not configured', NO_STORE_HEADERS);
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
      return notFound('No redirect overlay found', NO_STORE_HEADERS);
    }

    // Authorize: the site's org must hold an ASO entitlement AND the site must be
    // enrolled in it. Same gate pattern as edge-routing-auth / tier-client.
    const entitlement = await Entitlement.findByOrganizationIdAndProductCode(
      site.getOrganizationId(),
      EntitlementModel.PRODUCT_CODES.ASO,
    );
    if (!entitlement) {
      log.info('[aso-overlay] site org not ASO-entitled', { siteId: site.getId() });
      return notFound('No redirect overlay found', NO_STORE_HEADERS);
    }
    const enrollments = await SiteEnrollment.allBySiteId(site.getId());
    const enrolled = enrollments.some((se) => se.getEntitlementId() === entitlement.getId());
    if (!enrolled) {
      log.info('[aso-overlay] site not enrolled for ASO', { siteId: site.getId() });
      return notFound('No redirect overlay found', NO_STORE_HEADERS);
    }

    // Read the overlay with the Lambda's own execution role (no SigV4 from caller).
    const key = `config/${service}/redirects.txt`;
    try {
      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3Client.send(command);

      // S3 returns the object's ETag already quoted (RFC 7232 opaque-tag form),
      // e.g. `"d41d8cd98f00b204e9800998ecf8427e"`. Passthrough gives the client
      // a strong validator without hashing the body — the writer is single-part
      // (small overlays), so this is an MD5 today; multipart uploads would
      // surface an opaque S3 ETag which is still a valid strong validator.
      // If S3 doesn't surface an ETag (defensive — mock or future backend), we
      // just serve the body without ETag; the conditional-GET path degrades to
      // a plain 200 rather than breaking.
      const etag = response.ETag;
      const ifNoneMatch = getHeader(context, 'if-none-match');
      if (ifNoneMatchMatches(ifNoneMatch, etag)) {
        // Deliberately no per-request 304 log — this is the *expected* path at
        // steady state and would dominate log volume across the dispatcher fleet.
        // If 304-rate visibility becomes necessary, emit a metric rather than a
        // log line.
        //
        // 304 MUST NOT include a message body (RFC 7230 §3.3.3); MUST carry any
        // Cache-Control / ETag we would have sent on a 200 (RFC 7232 §4.1).
        // Content-type is set explicitly because createResponse would otherwise
        // default to application/json for an empty body and run the JSON
        // stringify branch — text/plain matches the 200 shape.
        return createResponse('', 304, {
          'content-type': 'text/plain; charset=utf-8',
          ...(etag ? { etag } : {}),
          'cache-control': OVERLAY_CACHE_CONTROL,
          // Same Surrogate-Key as the 200 so any 304 stragglers still on the
          // old TTL can be purged by the same call. Fastly stores the header
          // for edge state; RFC 7232 requires we carry cache-control + etag,
          // and Surrogate-Key is an operationally-linked companion.
          'surrogate-key': `aso-overlay-${service}`,
        });
      }

      const body = await response.Body.transformToString();
      return createResponse(body, 200, {
        'content-type': 'text/plain; charset=utf-8',
        // Cache-friendly for Fastly request-collapsing; edge TTL also set in VCL.
        'cache-control': OVERLAY_CACHE_CONTROL,
        // Include ETag so a subsequent poll can conditionally revalidate.
        ...(etag ? { etag } : {}),
        // Fastly surrogate key so Mystique can targeted-purge this tenant's
        // overlay on Deploy (see mystique#3381). Namespaced with `aso-overlay-`
        // prefix so future overlays under different routes don't collide with
        // this key space. Fastly VCL strips the /config/<tier>/ prefix before
        // reaching origin, so we only need per-service uniqueness (not per-tier).
        'surrogate-key': `aso-overlay-${service}`,
      });
    } catch (err) {
      const code = err.$metadata?.httpStatusCode;
      if (err.name === 'NoSuchKey' || code === 404) {
        return notFound('No redirect overlay found', NO_STORE_HEADERS);
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
        return notFound('No redirect overlay found', NO_STORE_HEADERS);
      }
      log.error(`[aso-overlay] failed to read ${key} from ${bucketName}`, err);
      return internalServerError('Failed to retrieve redirect overlay', NO_STORE_HEADERS);
    }
  }

  return { getRedirects };
}

export default RedirectsController;
