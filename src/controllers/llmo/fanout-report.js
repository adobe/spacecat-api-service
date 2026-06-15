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
  badRequest, created, found, internalServerError, notFound,
} from '@adobe/spacecat-shared-http-utils';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { COUNTRY_ENUM, LLM_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import AccessControlUtil from '../../support/access-control-util.js';
import { getGrpcClients } from '../../support/ai-visibility/grpc-transport.js';
import { curateFanoutReport, gzipReport } from '../../support/fanout/curate.js';

const PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — mirrors brand-claims
const REPORT_FILENAME = 'data.json.gz';

// Hardcoded constants for the initial version (Q2). Promote to query params
// when we expand market/LLM coverage.
const COUNTRY_NAME = 'US';
const LLM_NAME = 'chatgpt';
const COUNTRY_VALUE = COUNTRY_ENUM.US;
const LLM_VALUE = LLM_ENUM.CHAT_GPT;
const WINDOW_DAYS = 7; // Q15

const DEFAULT_CONCURRENCY = 5; // Q29
const DEFAULT_BATCH_SIZE = 100; // Q25 (Semrush max)

const buildS3Key = (spaceCatId, brandId) => (
  `fanout/llmo/${spaceCatId}/${brandId}/${REPORT_FILENAME}`
);

/**
 * Controller for the Query Fan-Out report.
 *
 * Two endpoints under `/org/{spaceCatId}/brands/{brandId}/fanout-report`:
 *   GET  — 302 redirect to a presigned S3 URL (or 404 if no report exists).
 *   POST — synchronously regenerate the report. (Phase 2 — not yet implemented.)
 *
 * The Lambda never loads the report body — the client follows the redirect
 * straight to S3 and decodes the gzipped JSON itself.
 *
 * @param {object} ctx - Request context (carries log, dataAccess, s3, env, params).
 */
export default function FanoutReportController(ctx) {
  const accessControlUtil = AccessControlUtil.fromContext(ctx);
  const hasLlmoOrganizationAccess = (organization) => (
    accessControlUtil.hasAccess(organization, '', 'LLMO')
  );

  const getOrgAndValidateAccess = async (context) => {
    const { spaceCatId } = context.params;
    const { Organization } = context.dataAccess;

    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    if (!await hasLlmoOrganizationAccess(organization)) {
      // Mirror "not found" rather than 403 to avoid leaking org existence.
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    return { organization };
  };

  /**
   * GET /org/{spaceCatId}/brands/{brandId}/fanout-report
   *
   * Returns 302 with `Location: <presigned S3 URL>` when the report exists,
   * or 404 when it doesn't. The presigned URL is valid for 1 hour.
   */
  const getFanoutReport = async (context) => {
    const { log, s3 } = context;
    const { spaceCatId, brandId } = context.params;

    if (!s3 || !s3.s3Client || !s3.s3Bucket) {
      return badRequest('S3 storage is not configured for this environment');
    }

    const { error } = await getOrgAndValidateAccess(context);
    if (error) {
      return error;
    }

    const key = buildS3Key(spaceCatId, brandId);

    // HeadObject first — avoids signing a URL for a missing object and lets
    // us return a clean 404 instead of letting the client hit S3 with a doomed
    // request.
    try {
      await s3.s3Client.send(new HeadObjectCommand({ Bucket: s3.s3Bucket, Key: key }));
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
        log.info(`Fan-out report not found at ${key}`);
        return notFound('Fan-out report not found for this brand');
      }
      log.error(`HeadObject failed for ${key}: ${e.message}`, e);
      return badRequest(`Error retrieving fan-out report: ${e.message}`);
    }

    const { getSignedUrl, GetObjectCommand } = s3;
    const command = new GetObjectCommand({ Bucket: s3.s3Bucket, Key: key });
    const url = await getSignedUrl(s3.s3Client, command, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });

    log.info(`Fan-out report served for org ${spaceCatId}, brand ${brandId}`);
    return found(url);
  };

  /**
   * POST /org/{spaceCatId}/brands/{brandId}/fanout-report
   *
   * Synchronously regenerates the report: reads tracked topics + per-prompt
   * rates from Mysticat, calls Semrush's fan-out service in batches, drops
   * topics below the similarity threshold, keeps the top 5 by priority score,
   * writes the gzipped JSON to S3. Returns 201 with an empty body. Caller
   * follows up with GET to fetch the presigned URL.
   *
   * country and llm are hard-coded to US/chatgpt for the initial version.
   */
  const triggerFanoutReport = async (context) => {
    const { log, s3, env } = context;
    const { spaceCatId, brandId } = context.params;

    if (!s3 || !s3.s3Client || !s3.s3Bucket) {
      return badRequest('S3 storage is not configured for this environment');
    }

    const { error } = await getOrgAndValidateAccess(context);
    if (error) {
      return error;
    }

    const postgrestClient = context.dataAccess?.services?.postgrestClient;
    if (!postgrestClient) {
      return badRequest('PostgREST is not configured for this environment');
    }

    let fanoutClient;
    try {
      ({ fanoutClient } = getGrpcClients(env));
    } catch (e) {
      log.error(`Failed to initialize Semrush gRPC clients: ${e.message}`, e);
      return badRequest(`Semrush is not configured for this environment: ${e.message}`);
    }

    const t0 = Date.now();
    try {
      const { report, stats } = await curateFanoutReport({
        organizationId: spaceCatId,
        brandId,
        country: COUNTRY_VALUE,
        llm: LLM_VALUE,
        countryName: COUNTRY_NAME,
        llmName: LLM_NAME,
        windowDays: WINDOW_DAYS,
        postgrestClient,
        fanoutClient,
        concurrency: Number(env.SEMRUSH_FANOUT_CONCURRENCY ?? DEFAULT_CONCURRENCY),
        batchSize: Number(env.SEMRUSH_FANOUT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE),
        log,
      });

      const body = gzipReport(report);
      const key = buildS3Key(spaceCatId, brandId);
      await s3.s3Client.send(new PutObjectCommand({
        Bucket: s3.s3Bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }));

      const totalMs = Date.now() - t0;
      log.info('fanout-report curated', {
        orgId: spaceCatId,
        brandId,
        key,
        totalMs,
        ...stats,
      });
      return created();
    } catch (e) {
      log.error(
        `fanout-report POST failed for org ${spaceCatId}, brand ${brandId}: ${e.message}`,
        e,
      );
      return internalServerError(`Failed to generate fan-out report: ${e.message}`);
    }
  };

  return {
    getFanoutReport,
    triggerFanoutReport,
  };
}
