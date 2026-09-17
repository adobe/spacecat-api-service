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

// @ts-check

/**
 * LLMO-5492 / AC3 — publish-completion status reading.
 *
 * Semrush publishes a project asynchronously: POST .../publish returns 202 and
 * the project's `publish_status` attribute transitions in the background, with
 * no completion webhook. Completion is therefore observed by re-reading the
 * project (transport.getProjectStatus) and inspecting `publish_status`.
 *
 * This module is the reusable read/classify/poll mechanism. Two consumers:
 *   - finalize.js does a BOUNDED, best-effort confirm within the Lambda's wall
 *     budget (one or a few reads) to catch an early hard failure.
 *   - the DRS/audit worker (a separate repo, SQS-driven, ≤900s) drives the
 *     UNBOUNDED long-poll using the same classify logic.
 *
 * Enum (serenity-docs §6):
 *   draft | publishing | initial_publish_failed | live | live_with_unpublished_updates
 */

export const PUBLISH_STATUS = {
  DRAFT: 'draft',
  PUBLISHING: 'publishing',
  INITIAL_PUBLISH_FAILED: 'initial_publish_failed',
  LIVE: 'live',
  LIVE_WITH_UNPUBLISHED_UPDATES: 'live_with_unpublished_updates',
};

// "Published" = the project is live to consumers, whether or not it carries
// later unpublished draft edits.
const PUBLISHED_STATES = new Set([
  PUBLISH_STATUS.LIVE,
  PUBLISH_STATUS.LIVE_WITH_UNPUBLISHED_UPDATES,
]);

// Terminal failure of the FIRST publish. `publishing` is in-progress (not a
// failure); only `initial_publish_failed` is terminal-bad.
const FAILED_STATES = new Set([PUBLISH_STATUS.INITIAL_PUBLISH_FAILED]);

/**
 * Outcome buckets returned by classifyPublishStatus / pollProjectPublished.
 * `pending` covers draft, publishing, and any unknown/absent status — i.e.
 * "not yet confirmed live, not yet confirmed failed".
 */
export const PUBLISH_OUTCOME = {
  PUBLISHED: 'published',
  FAILED: 'failed',
  PENDING: 'pending',
};

const DEFAULT_ATTEMPTS = 1;
const DEFAULT_INTERVAL_MS = 0;

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Reads `publish_status` off a project payload, tolerating both the upstream
 * snake_case form and a normalised camelCase form.
 * @param {object} project - Raw project JSON from getProjectStatus.
 * @returns {string|null}
 */
export function readPublishStatus(project) {
  return project?.publish_status ?? project?.publishStatus ?? null;
}

/**
 * Maps a project payload to a PUBLISH_OUTCOME (`published`|`failed`|`pending`).
 * @param {object} project - Raw project JSON from getProjectStatus.
 * @returns {string}
 */
export function classifyPublishStatus(project) {
  const status = readPublishStatus(project);
  if (status && PUBLISHED_STATES.has(status)) {
    return PUBLISH_OUTCOME.PUBLISHED;
  }
  if (status && FAILED_STATES.has(status)) {
    return PUBLISH_OUTCOME.FAILED;
  }
  return PUBLISH_OUTCOME.PENDING;
}

/**
 * Polls getProjectStatus until the project is confirmed live or confirmed
 * failed, or the attempt budget is exhausted. A status-read error is non-fatal
 * to the poll (logged, retried, and reported as `pending` if it persists) —
 * the caller decides how to treat an unconfirmed publish.
 *
 * Bounded by `attempts`/`intervalMs`. finalize uses a tiny budget (the long
 * ≤900s reconcile loop is the worker's job); the worker passes a large one.
 *
 * @param {object} transport - Serenity REST transport (needs getProjectStatus).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {object} [opts]
 * @param {number} [opts.attempts=1] - Max status reads (>=1).
 * @param {number} [opts.intervalMs=0] - Delay between reads.
 * @param {object} [opts.log] - Logger.
 * @param {function} [opts.sleep] - Injectable delay (tests pass a no-op).
 * @returns {Promise<{outcome:string, status:(string|null), publishedAt:(string|null),
 *   failedReason:(string|null), attempts:number, error?:string}>}
 */
export async function pollProjectPublished(
  transport,
  semrushWorkspaceId,
  projectId,
  {
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    log,
    sleep = defaultSleep,
  } = {},
) {
  const total = Math.max(1, attempts);
  /** @type {{outcome:string, status:(string|null), publishedAt:(string|null),
   *   failedReason:(string|null), attempts:number, error?:string}} */
  let last = {
    outcome: PUBLISH_OUTCOME.PENDING,
    status: null,
    publishedAt: null,
    failedReason: null,
    attempts: 0,
  };

  for (let i = 0; i < total; i += 1) {
    let project;
    let readError;
    try {
      // eslint-disable-next-line no-await-in-loop
      project = await transport.getProjectStatus(semrushWorkspaceId, projectId);
    } catch (e) {
      readError = e;
      log?.warn?.('pollProjectPublished: status read failed', {
        projectId, attempt: i + 1, error: e.message,
      });
    }

    if (!readError) {
      const status = readPublishStatus(project);
      last = {
        outcome: classifyPublishStatus(project),
        status,
        publishedAt: project?.published_at ?? project?.publishedAt ?? null,
        failedReason: project?.publishing_failed_reason ?? project?.publishingFailedReason ?? null,
        attempts: i + 1,
      };
      if (last.outcome !== PUBLISH_OUTCOME.PENDING) {
        return last;
      }
    } else {
      last = { ...last, attempts: i + 1, error: readError.message };
    }

    if (i < total - 1 && intervalMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalMs);
    }
  }

  return last;
}
