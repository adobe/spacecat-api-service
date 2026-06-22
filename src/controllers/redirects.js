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

// Cloud Manager service identifier, e.g. cm-p154709-e1629980. Digit runs are
// capped to a realistic length to avoid arbitrarily long lookups; the capture
// groups yield the program id (pXXXX) and environment id (eYYYY).
const SERVICE_RE = /^cm-p(\d{1,10})-e(\d{1,10})$/;
// Aligns with the Fastly edge TTL for this path (fetch/100-aso-overlay-ttl.vcl).
const OVERLAY_TTL_SECONDS = 10;

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
      const body = await response.Body.transformToString();
      return createResponse(body, 200, {
        'content-type': 'text/plain; charset=utf-8',
        // Cache-friendly for Fastly request-collapsing; edge TTL also set in VCL.
        'cache-control': `max-age=${OVERLAY_TTL_SECONDS}`,
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
