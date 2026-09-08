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

import { hasText } from '@adobe/spacecat-shared-utils';
import { notFound } from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from './access-control-util.js';

/**
 * Loads an {@link AsyncJob} by id, scoped to the calling tenant, for the generic
 * `GET .../jobs/:jobId` readers.
 *
 * `AsyncJob` is a single polymorphic table keyed only by a UUID: `findById` alone
 * is an IDOR — any authenticated caller holding any job UUID can read any other
 * tenant's job, including token-bearing job types (e.g. `serenity-classify-prompts`,
 * which persists a live promise token on `metadata`). This primitive is the shared
 * enforcement point that closes that exposure:
 *
 *  1. **jobType allowlist** — a job whose `metadata.jobType` is not in
 *     `allowedJobTypes` is reported as *not found* (404), never revealing that a job
 *     of a different type exists. An endpoint scoped to `['preflight']` therefore can
 *     never be used to read a `serenity-classify-prompts` (token-bearing) job.
 *  2. **owner scoping** — when `resolveOwnerSiteId` yields a siteId, the caller must
 *     hold access to that site (the same org-membership check `site:read` routes
 *     already enforce via {@link AccessControlUtil#hasAccess}). A caller without
 *     access gets 404 (again, no existence disclosure). Job types with no owning
 *     site (e.g. `site-detection`, whose metadata carries `{ domain, hlxVersion }`
 *     and no siteId) omit the resolver and are scoped by jobType only.
 *
 * The caller projects a response DTO from the returned job — this primitive never
 * returns raw metadata to the client.
 *
 * @param {object} context - The universal request context (dataAccess, attributes,
 *   pathInfo). Also used to build the {@link AccessControlUtil}.
 * @param {object} params
 * @param {string} params.jobId - The AsyncJob UUID (already format-validated by the caller).
 * @param {string[]} params.allowedJobTypes - Job types this endpoint may return.
 * @param {(job: object) => (string|undefined)} [params.resolveOwnerSiteId] - Resolves the
 *   owning siteId from the job; omit for ownerless job types.
 * @returns {Promise<{ job?: object, error?: object }>} Exactly one of `job`
 *   (authorized) or `error` (an HTTP response to return as-is).
 */
export async function loadJobScopedToCaller(context, {
  jobId,
  allowedJobTypes,
  resolveOwnerSiteId,
}) {
  const { dataAccess, log } = context;

  const job = await dataAccess.AsyncJob.findById(jobId);

  const jobType = job?.getMetadata?.()?.jobType;
  if (!job || !allowedJobTypes.includes(jobType)) {
    // Do not disclose the existence of a job of a different type / another tenant.
    return { error: notFound(`Job with ID ${jobId} not found`) };
  }

  const siteId = resolveOwnerSiteId ? resolveOwnerSiteId(job) : undefined;
  if (hasText(siteId)) {
    const site = await dataAccess.Site.findById(siteId);
    if (!site) {
      log?.warn?.(`[async-job-access] job ${jobId} references missing site ${siteId}; denying`);
      return { error: notFound(`Job with ID ${jobId} not found`) };
    }
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      log?.warn?.(`[async-job-access] caller lacks access to site ${siteId} owning job ${jobId}; denying`);
      return { error: notFound(`Job with ID ${jobId} not found`) };
    }
  }

  return { job };
}
