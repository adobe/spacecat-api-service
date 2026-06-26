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
// Per ADR-005, this file opts into JSDoc type checking; tsconfig.json `include`
// must list it so tsc actually validates the annotations (otherwise the pragma
// is editor-only). Type-check is a blocking gate in CI — see package.json
// `type-check` script.

/**
 * Wire-contract typedefs for the site-scoped Preflight GET endpoints. The
 * MFE polls `status` and consumes `result`/`error`. Field-content typing
 * (esp. the shape of `result`) is the deeper exercise tracked in
 * SITES-47180; passthrough `object` is intentional for now.
 *
 * Entity getters are typed locally rather than imported from
 * `@adobe/spacecat-shared-data-access` because that package's main type
 * entry does not re-export `Preflight` / `AsyncJob` (the per-entity
 * `index.d.ts` exists but isn't in `src/models/index.d.ts`'s barrel as
 * of v3.79.1). Capturing only the methods we consume keeps the contract
 * narrow and decouples this file from upstream typing gaps.
 *
 * @typedef {'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED'} PreflightStatus
 *
 * @typedef {{ email: string, displayName?: string }} PreflightActor
 *
 * @typedef {{ code: string, message: string, details?: object }} PreflightError
 *
 * @typedef {Object} PreflightEntity
 * @property {() => string} getId
 * @property {() => string} getSiteId
 * @property {() => string} getStatus
 * @property {() => string} getUrl
 * @property {() => string} getCreatedAt
 * @property {() => string} getUpdatedAt
 * @property {() => (string | null)} getEndedAt
 * @property {() => PreflightActor} getCreatedBy
 *
 * @typedef {Object} AsyncJobEntity
 * @property {() => string} getStatus
 * @property {() => (string | null)} getEndedAt
 * @property {() => (object | null)} getResult
 * @property {() => (PreflightError | null)} getError
 *
 * @typedef {Object} PreflightCreated
 * @property {string} preflightId
 * @property {string} siteId
 * @property {PreflightStatus} status
 * @property {string} url
 * @property {string} createdAt              ISO 8601
 * @property {PreflightActor} createdBy
 *
 * @typedef {PreflightCreated & {
 *   updatedAt: string,
 *   endedAt: string | null,
 * }} PreflightListItem
 *
 * @typedef {PreflightListItem & {
 *   result: object | null,
 *   error: PreflightError | null,
 * }} PreflightDetail
 */

export const PreflightDto = {
  /**
   * Just-created DTO for the 202 response on POST. Omits `updatedAt` and
   * `endedAt` because they carry no information at creation time
   * (updatedAt === createdAt; endedAt is always null for IN_PROGRESS).
   * The full shape returns on subsequent GETs.
   *
   * @param {PreflightEntity} preflight
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
   * the list path stays index-only without joining `async_jobs`. The detail
   * view (`toDetailJSON`) re-reads these two fields from the AsyncJob row
   * (truth) to avoid the projector-window split-brain (see ADR-003
   * amendment, SITES-47254).
   *
   * @param {PreflightEntity} preflight
   * @returns {PreflightListItem}
   */
  toJSON: (preflight) => ({
    ...PreflightDto.toCreatedJSON(preflight),
    updatedAt: preflight.getUpdatedAt(),
    endedAt: preflight.getEndedAt(),
  }),

  /**
   * Detail-view DTO. Lifecycle fields (`status`, `endedAt`, `result`,
   * `error`) source from the joined AsyncJob row — that's where the
   * projector writes terminal state first, so reading them together
   * eliminates the split-brain window where Preflight.status could lag
   * AsyncJob.result by the time between the projector's two writes.
   *
   * `startedAt` is intentionally not on the wire — it's an AsyncJob concern,
   * not a Preflight attribute. Consumers that need timing internals can
   * read them out of `result`.
   *
   * The caller MUST pass a valid AsyncJob. The controller returns 503 on
   * a transient fetch failure rather than degrading silently to nulls
   * (that path would be indistinguishable from a legitimate empty scan
   * on the wire). `asyncJob` may legitimately be `null` only when no
   * AsyncJob row exists for the preflight yet (transitional / legacy
   * flow) — in that case lifecycle fields fall back to the Preflight
   * cache and `result`/`error` surface as `null`.
   *
   * @param {PreflightEntity} preflight
   * @param {AsyncJobEntity | null} asyncJob
   * @returns {PreflightDetail}
   */
  toDetailJSON: (preflight, asyncJob) => ({
    ...PreflightDto.toJSON(preflight),
    ...(asyncJob && {
      status: /** @type {PreflightStatus} */ (asyncJob.getStatus()),
      endedAt: asyncJob.getEndedAt(),
    }),
    result: asyncJob ? asyncJob.getResult() : null,
    error: asyncJob ? asyncJob.getError() : null,
  }),
};
