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
// @ts-check

/**
 * Wire-contract typedefs for the site-scoped Preflight GET endpoints. The
 * MFE polls `status` and consumes `result`/`error`. Field-content typing
 * (esp. the shape of `result`) is the deeper exercise tracked in
 * SITES-47180; passthrough `object` is intentional for now.
 *
 * @typedef {'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED'} PreflightStatus
 *
 * @typedef {{ email: string, displayName?: string }} PreflightActor
 *
 * @typedef {Object} PreflightCreated
 * @property {string} preflightId
 * @property {string} siteId
 * @property {PreflightStatus} status
 * @property {string} url
 * @property {string} createdAt              ISO 8601
 * @property {PreflightActor} createdBy
 *
 * @typedef {Object} PreflightListItem
 * @property {string} preflightId
 * @property {string} siteId
 * @property {PreflightStatus} status
 * @property {string} url
 * @property {string} createdAt              ISO 8601
 * @property {string} updatedAt              ISO 8601
 * @property {string | null} endedAt         ISO 8601, null while not terminal
 * @property {PreflightActor} createdBy
 *
 * @typedef {Object} PreflightDetail
 * @property {string} preflightId
 * @property {string} siteId
 * @property {PreflightStatus} status
 * @property {string} url
 * @property {string} createdAt              ISO 8601
 * @property {string} updatedAt              ISO 8601
 * @property {string | null} endedAt         ISO 8601
 * @property {PreflightActor} createdBy
 * @property {object | null} result          Sourced from AsyncJob; null while not terminal
 * @property {PreflightError | null} error   Sourced from AsyncJob
 *
 * @typedef {{ code: string, message: string, details?: object }} PreflightError
 */

export const PreflightDto = {
  /**
   * Just-created DTO for the 202 response on POST. Omits `updatedAt` and
   * `endedAt` because they carry no information at creation time
   * (updatedAt === createdAt; endedAt is always null for IN_PROGRESS).
   * The full shape returns on subsequent GETs.
   *
   * @param {import('@adobe/spacecat-shared-data-access').Preflight} preflight
   * @returns {PreflightCreated}
   */
  toCreatedJSON: (preflight) => ({
    preflightId: preflight.getId(),
    siteId: preflight.getSiteId(),
    status: /** @type {PreflightStatus} */ (preflight.getStatus()),
    url: preflight.getUrl(),
    createdAt: preflight.getCreatedAt(),
    createdBy: preflight.getCreatedBy(),
  }),

  /**
   * List-view DTO. Sources entirely from the Preflight entity — `status` and
   * `endedAt` are denormalized on the row (kept in sync by the projector) so
   * the list path stays index-only without joining `async_jobs`.
   *
   * @param {import('@adobe/spacecat-shared-data-access').Preflight} preflight
   * @returns {PreflightListItem}
   */
  toJSON: (preflight) => ({
    preflightId: preflight.getId(),
    siteId: preflight.getSiteId(),
    status: /** @type {PreflightStatus} */ (preflight.getStatus()),
    url: preflight.getUrl(),
    createdAt: preflight.getCreatedAt(),
    updatedAt: preflight.getUpdatedAt(),
    endedAt: preflight.getEndedAt(),
    createdBy: preflight.getCreatedBy(),
  }),

  /**
   * Detail-view DTO. `result` and `error` are AsyncJob-owned (the projector
   * writes them there, not on the Preflight row), so the caller fetches the
   * joined AsyncJob and passes it in. When `asyncJob` is null (defensive
   * degrade — caller logs the gap), the two fields surface as null rather
   * than 404'ing the whole response.
   *
   * `startedAt` is intentionally not surfaced — it's an AsyncJob concern,
   * not a Preflight attribute. Consumers that need timing internals can
   * read them out of `result`.
   *
   * @param {import('@adobe/spacecat-shared-data-access').Preflight} preflight
   * @param {import('@adobe/spacecat-shared-data-access').AsyncJob | null} asyncJob
   * @returns {PreflightDetail}
   */
  toDetailJSON: (preflight, asyncJob) => ({
    preflightId: preflight.getId(),
    siteId: preflight.getSiteId(),
    status: /** @type {PreflightStatus} */ (preflight.getStatus()),
    url: preflight.getUrl(),
    createdAt: preflight.getCreatedAt(),
    updatedAt: preflight.getUpdatedAt(),
    endedAt: preflight.getEndedAt(),
    createdBy: preflight.getCreatedBy(),
    result: asyncJob ? asyncJob.getResult() : null,
    error: asyncJob ? asyncJob.getError() : null,
  }),
};
