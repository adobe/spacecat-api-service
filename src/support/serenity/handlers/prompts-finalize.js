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

import { ErrorWithStatusCode } from '../../utils.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { ERROR_CODES, isMeteredQuota } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import {
  PUBLISH_STATUS, PUBLISH_OUTCOME, readPublishStatus, pollProjectPublished,
} from './publish-status.js';
import { buildSliceProjectMap, sliceKey } from '../subworkspace-projects.js';
import { mapLimit, BULK_CREATE_CONCURRENCY } from './prompts.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * POST .../serenity/prompts/finalize (serenity-docs#472 §4 / LLMO-7533).
 *
 * Short-term recovery surface for the CSV-import path: the browser-orchestrated
 * import writes deferred-publish (draft) batches, and reaching the ORIGINAL
 * final batch was previously the only way to publish them. A failure,
 * cancellation, or rejected row anywhere in the run left acknowledged draft
 * writes stranded — visible to nobody until the customer's NEXT import. This
 * endpoint publishes whatever a set of (geoTargetId, languageCode) slices is
 * currently owed, independent of how the import that staged them ended.
 *
 * Idempotent per slice by construction — the state read on each call decides
 * the action, never the caller:
 *   - `live` (no unpublished draft)         → no-op, `alreadyPublished`.
 *   - `draft` / `live_with_unpublished_updates` → publish, then bounded-confirm.
 *   - `publishing`                          → do NOT resend publish; poll only.
 *   - `initial_publish_failed`              → terminal `failed` (no retry here).
 *
 * A slice is resolved to its project through the SAME org/brand/workspace
 * authorization the caller already applied to reach this handler (the flat
 * twin via `BrandSemrushProject.allByBrandId`, the subworkspace twin via
 * {@link buildSliceProjectMap}) — the request body carries only
 * (geoTargetId, languageCode), never a caller-supplied project or workspace id.
 */

export const FINALIZE_OUTCOME = {
  ALREADY_PUBLISHED: 'alreadyPublished',
  PUBLISHED: 'published',
  PENDING: 'pending',
  FAILED: 'failed',
};

// Independently chosen (not tied to any existing per-brand market cap) — a
// CSV import supplies exactly one slice in practice (serenity-docs#472 §4);
// this just bounds the generic multi-slice contract against an unbounded
// caller-supplied array, mirroring BULK_PROMPTS_MAX_ITEMS's role for creates.
export const MAX_FINALIZE_SLICES = 50;

// Caps a caller-supplied value reflected back into an error entry — an
// unresolvable slice's raw geoTargetId/languageCode round-trip into the
// response for the caller's own debugging, but must never carry an
// unbounded string/object straight from the request body.
const MAX_ECHO_LEN = 200;
/**
 * @param {unknown} value
 * @returns {string | number | boolean | null}
 */
function sanitizeEchoValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > MAX_ECHO_LEN ? value.slice(0, MAX_ECHO_LEN) : value;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {{ geoTargetId: number, languageCode: string } | null}
 */
function normalizeSlice(raw) {
  const geoTargetId = normalizeGeoTargetId(Number(/** @type {any} */ (raw)?.geoTargetId));
  const languageCode = normalizeLanguageCode(/** @type {any} */ (raw)?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    return null;
  }
  return { geoTargetId, languageCode };
}

/**
 * @param {unknown} rawSlices
 * @returns {Array<unknown>}
 */
function assertSlices(rawSlices) {
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty slices array', 400);
  }
  if (rawSlices.length > MAX_FINALIZE_SLICES) {
    throw new ErrorWithStatusCode(
      `slices array exceeds maxItems=${MAX_FINALIZE_SLICES}`,
      400,
    );
  }
  return rawSlices;
}

/**
 * @param {{outcome: string, status: (string|null), failedReason: (string|null)}} confirm
 * @param {any} [log]
 */
function outcomeFromConfirm(confirm, log) {
  // `confirm.status` is Semrush's raw `publish_status` string, echoed to the
  // caller as diagnostic context (the ticket's acceptance criteria explicitly
  // calls for surfacing "the observed upstream status", so this deliberately
  // is NOT collapsed to a closed enum the way `outcome` already is) — length-
  // bounded the same way an unresolvable slice's caller-supplied fields are,
  // since it is still upstream-controlled content.
  const publishStatus = typeof confirm.status === 'string'
    ? confirm.status.slice(0, MAX_ECHO_LEN)
    : confirm.status;
  if (confirm.outcome === PUBLISH_OUTCOME.PUBLISHED) {
    return { outcome: FINALIZE_OUTCOME.PUBLISHED, publishStatus };
  }
  if (confirm.outcome === PUBLISH_OUTCOME.FAILED) {
    // `confirm.failedReason` is Semrush's raw `publishing_failed_reason` text —
    // logged server-side only, never returned to the caller verbatim (matches
    // the redaction discipline `finalizeProjectPublish`'s other failure branches
    // use via redactUpstreamMessage). Length is logged alongside it so an
    // unusually large upstream payload is visible without printing it.
    if (confirm.failedReason) {
      log?.error?.('finalizeProjectPublish: publish reported failed by upstream', {
        publishStatus,
        failedReason: confirm.failedReason,
        failedReasonLength: confirm.failedReason.length,
      });
    }
    return {
      outcome: FINALIZE_OUTCOME.FAILED,
      publishStatus,
      error: confirm.status || 'initial_publish_failed',
    };
  }
  // PENDING — accepted (or already publishing), not confirmed live within budget.
  return { outcome: FINALIZE_OUTCOME.PENDING, publishStatus };
}

/**
 * One project's finalize-publish step — shared by both the flat and
 * subworkspace entry points below, once each has resolved its own projectId.
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {object} [options]
 * @param {number} [options.confirmAttempts=1] - bounded getProjectStatus reads
 *   after a publish this call issues (the unbounded reconcile is the worker's job).
 * @param {number} [options.confirmIntervalMs=0]
 * @param {any} [options.log]
 * @returns {Promise<{ outcome: string, publishStatus?: (string|null), error?: string,
 *   code?: string, permanent?: boolean }>}
 */
export async function finalizeProjectPublish(
  transport,
  semrushWorkspaceId,
  projectId,
  options = {},
) {
  const { confirmAttempts = 1, confirmIntervalMs = 0, log } = options;

  let currentProject;
  try {
    currentProject = await transport.getProjectStatus(semrushWorkspaceId, projectId);
  } catch (e) {
    log?.error?.('finalizeProjectPublish: status read failed', { projectId, error: e.message });
    return { outcome: FINALIZE_OUTCOME.FAILED, error: redactUpstreamMessage(e) };
  }
  const status = readPublishStatus(currentProject);

  if (status === PUBLISH_STATUS.LIVE) {
    return { outcome: FINALIZE_OUTCOME.ALREADY_PUBLISHED, publishStatus: status };
  }
  if (status === PUBLISH_STATUS.INITIAL_PUBLISH_FAILED) {
    return { outcome: FINALIZE_OUTCOME.FAILED, publishStatus: status, error: status };
  }
  if (status === PUBLISH_STATUS.PUBLISHING) {
    // Already in flight from an earlier publish — poll, never resend.
    const confirm = await pollProjectPublished(transport, semrushWorkspaceId, projectId, {
      attempts: confirmAttempts, intervalMs: confirmIntervalMs, log,
    });
    return outcomeFromConfirm(confirm, log);
  }

  // draft, live_with_unpublished_updates, or unknown/absent status → publish.
  try {
    await transport.publishProject(semrushWorkspaceId, projectId);
  } catch (e) {
    if (isMeteredQuota(e)) {
      log?.error?.(
        'finalizeProjectPublish: publish rejected — workspace has no ai.projects quota '
        + '(PERMANENT, not retried)',
        { projectId, code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED },
      );
      return {
        outcome: FINALIZE_OUTCOME.FAILED,
        error: 'publish rejected: workspace has no ai.projects quota',
        code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED,
        permanent: true,
      };
    }
    log?.error?.('finalizeProjectPublish: publish failed', { projectId, error: e.message });
    return { outcome: FINALIZE_OUTCOME.FAILED, error: redactUpstreamMessage(e) };
  }

  const confirm = await pollProjectPublished(transport, semrushWorkspaceId, projectId, {
    attempts: confirmAttempts, intervalMs: confirmIntervalMs, log,
  });
  return outcomeFromConfirm(confirm, log);
}

/**
 * Resolves every raw slice to a project id via the caller-supplied per-mode
 * `resolveProjectId`, then fans the actual finalize work out ONE call per
 * DISTINCT resolved project — never one call per slice. Two slices that
 * resolve to the same project (a caller-supplied duplicate, or a market
 * shared across slices) are deduped here so they trigger exactly one
 * `finalizeProjectPublish`, never redundant concurrent publishes against the
 * same project. Bounded by `BULK_CREATE_CONCURRENCY`, matching the same
 * concurrency ceiling `handleCreatePrompts` fans its own per-project work out
 * with — an unbounded `Promise.all` here would let a caller-supplied slices
 * array (already capped at {@link MAX_FINALIZE_SLICES}, but still sizable)
 * drive that many concurrent upstream requests with no ceiling.
 * @param {Array<unknown>} rawSlices
 * @param {(slice: { geoTargetId: number, languageCode: string }) =>
 *   (string | undefined)} resolveProjectId
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {any} log
 * @param {object} options
 * @returns {Promise<Array<object>>}
 */
async function resolveAndFinalizeSlices(
  rawSlices,
  resolveProjectId,
  transport,
  semrushWorkspaceId,
  log,
  options,
) {
  const resolved = rawSlices.map((raw) => {
    const slice = normalizeSlice(raw);
    if (!slice) {
      return {
        geoTargetId: sanitizeEchoValue(/** @type {any} */ (raw)?.geoTargetId),
        languageCode: sanitizeEchoValue(/** @type {any} */ (raw)?.languageCode),
        outcome: FINALIZE_OUTCOME.FAILED,
        error: 'geoTargetId and languageCode are required',
      };
    }
    const projectId = resolveProjectId(slice);
    if (!projectId) {
      return {
        ...slice,
        outcome: FINALIZE_OUTCOME.FAILED,
        error: 'No market for slice',
        code: ERROR_CODES.MARKET_NOT_FOUND,
      };
    }
    return { ...slice, projectId };
  });

  const projectIds = [...new Set(
    resolved.map((r) => /** @type {any} */ (r).projectId).filter(Boolean),
  )];
  /** @type {Map<string, object>} */
  const resultByProjectId = new Map();
  await mapLimit(projectIds, BULK_CREATE_CONCURRENCY, async (projectId) => {
    resultByProjectId.set(
      projectId,
      await finalizeProjectPublish(transport, semrushWorkspaceId, projectId, { ...options, log }),
    );
  });

  return resolved.map((r) => {
    const { projectId, ...slice } = /** @type {any} */ (r);
    return projectId ? { ...slice, ...resultByProjectId.get(projectId) } : slice;
  });
}

/**
 * Flat-mode entry point: resolves each slice's project via the brand's
 * `BrandSemrushProject` DB rows — same lookup `handleCreatePrompts` uses, so
 * finalize can only ever touch a project this brand's prompt-create call
 * could already reach.
 * @param {SerenityTransport} transport
 * @param {object} dataAccess
 * @param {string} brandId
 * @param {string} semrushWorkspaceId
 * @param {object} body - `{ slices: Array<{ geoTargetId, languageCode }> }`
 * @param {any} [log]
 * @param {object} [options]
 * @returns {Promise<{ slices: Array<object> }>}
 */
export async function handleFinalizePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  options = {},
) {
  const rawSlices = assertSlices(body?.slices);

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectsBySlice = new Map();
  for (const p of projects || []) {
    projectsBySlice.set(`${p.getGeoTargetId()}:${p.getLanguageCode()}`, p);
  }

  const slices = await resolveAndFinalizeSlices(
    rawSlices,
    (slice) => projectsBySlice.get(`${slice.geoTargetId}:${slice.languageCode}`)
      ?.getSemrushProjectId(),
    transport,
    semrushWorkspaceId,
    log,
    options,
  );

  return { slices };
}

/**
 * Subworkspace-mode entry point: resolves every slice's project from ONE live
 * listing ({@link buildSliceProjectMap}) instead of a DB row — the twin of
 * {@link handleFinalizePrompts}.
 *
 * `buildSliceProjectMap` is itself a live upstream call (unlike the flat
 * twin's local DB read), so it carries the same transient-failure profile the
 * existing-prompt-index read had before this ticket's containment fix. A
 * failed listing is therefore CONTAINED here too: every requested slice comes
 * back `failed` with the listing error, rather than throwing an outer 502
 * that discards the itemized-per-slice contract this endpoint exists to
 * provide.
 * @param {SerenityTransport} transport
 * @param {string} workspaceId
 * @param {object} body - `{ slices: Array<{ geoTargetId, languageCode }> }`
 * @param {any} [log]
 * @param {object} [options]
 * @returns {Promise<{ slices: Array<object> }>}
 */
export async function handleFinalizePromptsSubworkspace(
  transport,
  workspaceId,
  body,
  log,
  options = {},
) {
  const rawSlices = assertSlices(body?.slices);

  let projectsBySlice;
  try {
    projectsBySlice = await buildSliceProjectMap(transport, workspaceId, log);
  } catch (e) {
    log?.error?.(
      'handleFinalizePromptsSubworkspace: project listing failed — failing every '
      + 'requested slice rather than throwing an outer error',
      { workspaceId, error: e.message },
    );
    const message = redactUpstreamMessage(e);
    return {
      slices: rawSlices.map((raw) => ({
        geoTargetId: sanitizeEchoValue(/** @type {any} */ (raw)?.geoTargetId),
        languageCode: sanitizeEchoValue(/** @type {any} */ (raw)?.languageCode),
        outcome: FINALIZE_OUTCOME.FAILED,
        error: message,
      })),
    };
  }

  const slices = await resolveAndFinalizeSlices(
    rawSlices,
    (slice) => {
      const project = projectsBySlice.get(sliceKey(slice.geoTargetId, slice.languageCode));
      return project ? String(project.id) : undefined;
    },
    transport,
    workspaceId,
    log,
    options,
  );

  return { slices };
}
