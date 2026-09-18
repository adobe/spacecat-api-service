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

import { createHash } from 'node:crypto';
import { ErrorWithStatusCode } from '../../utils.js';
import { createSerenityTransport } from '../rest-transport.js';
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { resolveProject } from '../subworkspace-projects.js';
import { readTagTreeSnapshot, incompatibleTaxonomyError } from '../tag-tree.js';
import { createAndEnqueueJob, retryableJobError } from '../async-job-runner.js';
import {
  assertPromptTagLimit,
  BULK_CREATE_CONCURRENCY,
  listAllProjectPrompts,
  mapLimit,
  publishAffected,
  resolveFacetedTagFilter,
  validateTagIds,
} from './prompts.js';
import {
  BULK_IDEMPOTENCY_TTL_SECONDS,
  MAX_TAG_FILTER_VALUES,
  invalidateTagCacheForProject,
} from './markets.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { dimensionOfRootName, isServerOwnedDimension } from '../prompt-tags.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */
/** @typedef {Awaited<ReturnType<typeof readTagTreeSnapshot>>['items'][number]} TagTreeItem */

export const BULK_TAGS_JOB_TYPE = 'serenity-bulk-tags';
export const BULK_TAGS_PUBLIC_JOB_TYPE = 'bulkTags';
export const BULK_FAILURE_PAGE_LIMIT = 100;
export const MAX_BULK_TAG_SEARCH_LENGTH = 500;
const MAX_PUBLISH_RECOVERY_DEPTH = 5;
const BULK_TAGS_IDEMPOTENCY_ENDPOINT = 'POST /serenity/prompts/bulk-tags';
const IDEMPOTENCY_REPLAY_ATTEMPTS = 100;
const IDEMPOTENCY_REPLAY_DELAY_MS = 25;

function codedError(message, status, code, details) {
  const error = new ErrorWithStatusCode(message, status);
  error.code = code;
  if (details) {
    /** @type {any} */ (error).details = details;
  }
  return error;
}

function promptTagIds(prompt) {
  return [...new Set((Array.isArray(prompt?.tags) ? prompt.tags : [])
    .map((tag) => (typeof tag === 'string' ? tag : String(tag?.id ?? '')))
    .filter(Boolean))];
}

function serverOwnedDimensionOf(item) {
  const dimension = dimensionOfRootName(item.rootName);
  return isServerOwnedDimension(dimension) ? dimension : null;
}

/**
 * @param {object} prompt
 * @param {Array<Set<string>>} groups
 * @returns {boolean}
 */
export function matchesBulkTagFacets(prompt, groups) {
  if (groups.length === 0) {
    return true;
  }
  const ids = new Set(promptTagIds(prompt));
  return groups.every((group) => [...group].some((id) => ids.has(id)));
}

function buildBulkTagMutationIds(operation, selected, snapshot) {
  const ids = new Set();
  for (const item of selected) {
    ids.add(item.id);
    if (operation === 'assign' && item.rootName === 'tag') {
      for (const ancestor of item.fullPath.slice(1, -1)) {
        ids.add(ancestor.id);
      }
    }
    if (operation === 'remove' && item.rootName === 'tag') {
      for (const candidate of snapshot.items) {
        if (candidate.fullPath.some((part) => part.id === item.id)) {
          ids.add(candidate.id);
        }
      }
    }
  }
  return ids;
}

/**
 * @param {string[]} currentIds
 * @param {'assign' | 'remove'} operation
 * @param {TagTreeItem[]} selected
 * @param {Awaited<ReturnType<typeof readTagTreeSnapshot>>} snapshot
 * @param {Set<string>} [mutationIds]
 * @returns {string[]}
 */
export function applyBulkTagOperation(currentIds, operation, selected, snapshot, mutationIds) {
  const result = new Set(currentIds);
  const effectiveIds = mutationIds ?? buildBulkTagMutationIds(operation, selected, snapshot);
  if (operation === 'assign') {
    for (const id of effectiveIds) {
      result.add(id);
    }
  } else {
    for (const id of effectiveIds) {
      result.delete(id);
    }
  }

  for (const id of [...result]) {
    const item = snapshot.byId.get(id);
    if (item?.rootName === 'tag') {
      for (const ancestor of item.fullPath.slice(1, -1)) {
        result.add(ancestor.id);
      }
    }
  }
  const ids = [...result];
  assertPromptTagLimit(ids);
  return ids;
}

function canonicalHash(body, scope) {
  const canonical = {
    scope,
    geoTargetId: body.geoTargetId,
    languageCode: body.languageCode,
    operation: body.operation,
    tagIds: [...new Set(body.tagIds)].sort(),
    filter: {
      search: body.filter.search ?? null,
      tagIds: [...new Set(body.filter.tagIds)].sort(),
      tagFilterMode: body.filter.tagFilterMode,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

function idempotencyStorageKey(key) {
  return createHash('sha256')
    .update(`${BULK_TAGS_JOB_TYPE}:${key}`)
    .digest('base64url');
}

function acceptedJobResponse(job, replayed) {
  const outcome = job.getResult?.()?.outcome;
  return {
    status: replayed ? 200 : 202,
    body: {
      jobId: job.getId(),
      jobType: BULK_TAGS_PUBLIC_JOB_TYPE,
      status: job.getStatus(),
      replayed,
      ...(['SUCCEEDED', 'PARTIAL_FAILURE'].includes(outcome) ? { outcome } : {}),
    },
  };
}

function isUniqueViolation(error) {
  let current = error;
  while (current) {
    if (current.code === '23505') {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function assertSameIdempotentRequest(entry, hash) {
  const response = entry?.getResponse?.() ?? {};
  if (response.requestHash !== hash) {
    throw codedError(
      'Idempotency-Key was reused with a different bulk tag request',
      409,
      ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );
  }
  return response;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function replayIdempotentJob(
  context,
  entry,
  key,
  orgId,
  hash,
  attemptsRemaining = IDEMPOTENCY_REPLAY_ATTEMPTS,
) {
  const response = assertSameIdempotentRequest(entry, hash);
  if (entry.getStatus() === 'completed') {
    if (typeof response.jobId !== 'string') {
      throw new Error('Completed bulk-tag idempotency record has no jobId');
    }
    const job = await context.dataAccess.AsyncJob.findById(response.jobId);
    if (!job) {
      throw new Error(`Bulk-tag idempotency record references missing job ${response.jobId}`);
    }
    return acceptedJobResponse(job, true);
  }
  if (entry.getStatus() === 'failed') {
    // A failed claim means cleanup previously degraded after no job was accepted.
    // Remove it so a fresh request can safely acquire and retry the operation.
    await entry.remove();
    return null;
  }
  if (attemptsRemaining > 1) {
    // A concurrent winner only holds PROCESSING across AsyncJob create + SQS send.
    // Wait briefly so the losing request can return the accepted job deterministically.
    await sleep(IDEMPOTENCY_REPLAY_DELAY_MS);
    const current = await context.dataAccess.IdempotencyKey.findActiveKey(key, orgId);
    if (!current) {
      return null;
    }
    return replayIdempotentJob(
      context,
      current,
      key,
      orgId,
      hash,
      attemptsRemaining - 1,
    );
  }
  throw codedError(
    'A request with this Idempotency-Key is still being accepted',
    409,
    ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
}

async function removeExpiredIdempotencyKey(context, key, orgId) {
  const postgrestClient = context.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    throw new Error('PostgREST is required for bulk-tag idempotency');
  }
  // The shared model only exposes a global expired-record cleanup. Use an endpoint-scoped
  // delete here so this request cannot remove another consumer's idempotency record.
  const { error } = await postgrestClient
    .from('idempotency_keys')
    .delete()
    .eq('key', key)
    .eq('organization_id', orgId)
    .eq('endpoint', BULK_TAGS_IDEMPOTENCY_ENDPOINT)
    .lte('expires_at', new Date().toISOString());
  if (error) {
    throw new Error('Failed to remove expired bulk-tag idempotency record', { cause: error });
  }
}

async function acquireIdempotencyKey(context, key, orgId, hash) {
  const existing = await context.dataAccess.IdempotencyKey.findActiveKey(key, orgId);
  if (existing) {
    return { entry: existing, owned: false };
  }

  const create = () => context.dataAccess.IdempotencyKey.create({
    key,
    organizationId: orgId,
    endpoint: BULK_TAGS_IDEMPOTENCY_ENDPOINT,
    status: 'processing',
    response: { requestHash: hash },
    expiresAt: new Date(Date.now() + BULK_IDEMPOTENCY_TTL_SECONDS * 1000).toISOString(),
  });

  try {
    return { entry: await create(), owned: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await context.dataAccess.IdempotencyKey.findActiveKey(key, orgId);
    if (raced) {
      return { entry: raced, owned: false };
    }
    await removeExpiredIdempotencyKey(context, key, orgId);
    try {
      return { entry: await create(), owned: true };
    } catch (retryError) {
      if (!isUniqueViolation(retryError)) {
        throw retryError;
      }
      const retryRace = await context.dataAccess.IdempotencyKey.findActiveKey(key, orgId);
      if (retryRace) {
        return { entry: retryRace, owned: false };
      }
      throw codedError(
        'Unable to reserve this bulk tag idempotency key',
        409,
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        { cause: retryError.message },
      );
    }
  }
}

async function reserveIdempotencyKey(context, key, orgId, hash, attemptsRemaining = 2) {
  const acquired = await acquireIdempotencyKey(context, key, orgId, hash);
  if (acquired.owned) {
    return { entry: acquired.entry };
  }
  const replay = await replayIdempotentJob(context, acquired.entry, key, orgId, hash);
  if (replay) {
    return { replay };
  }
  if (attemptsRemaining > 1) {
    return reserveIdempotencyKey(context, key, orgId, hash, attemptsRemaining - 1);
  }
  throw codedError(
    'Unable to reserve this bulk tag idempotency key',
    409,
    ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
}

/**
 * @param {object} context
 * @param {object} entry
 * @param {string} hash
 * @param {{ key?: string | null, orgId?: string }} [details]
 */
async function releaseIdempotencyKey(context, entry, hash, {
  key,
  orgId,
} = {}) {
  const claimId = entry.getId?.() ?? 'unknown';
  const diagnostic = `claim=${claimId} key=${key ?? 'unknown'} org=${orgId ?? 'unknown'} `
    + `endpoint="${BULK_TAGS_IDEMPOTENCY_ENDPOINT}"`;
  try {
    await entry.remove();
  } catch (removeError) {
    context.log?.warn?.(
      `[serenity-bulk-tags] Failed to remove idempotency record (${diagnostic}): `
      + `${removeError.message}`,
    );
    try {
      await entry
        .setStatus('failed')
        .setResponse({ requestHash: hash })
        .save();
    } catch (saveError) {
      context.log?.warn?.(
        `[serenity-bulk-tags] Failed to mark idempotency record failed (${diagnostic}): `
        + `${saveError.message}`,
      );
    }
  }
}

/**
 * Persists a publish-only resume phase, then fails the current SQS delivery so
 * the same IN_PROGRESS job is retried. The existing job id remains the polling
 * handle and no credential handoff or second-job enqueue is required.
 *
 * @param {object} context
 * @param {{
 *   getId: () => string,
 *   getResult?: () => object | null,
 *   setMetadata: (metadata: object) => void,
 *   setResult: (result: object) => void,
 *   save: () => Promise<void>,
 * }} job
 * @param {object} metadata
 * @param {object} result
 * @param {unknown} cause
 * @returns {Promise<boolean>}
 */
async function retryFailedPublish(context, job, metadata, result, cause) {
  const recoveryDepth = Number.isInteger(metadata.publishRecoveryDepth)
    ? metadata.publishRecoveryDepth
    : 0;
  if (recoveryDepth >= MAX_PUBLISH_RECOVERY_DEPTH) {
    context.log?.warn?.(
      `[serenity-bulk-tags] Publish recovery depth ${recoveryDepth} reached max `
      + `${MAX_PUBLISH_RECOVERY_DEPTH} for job ${job.getId()}`,
    );
    return false;
  }
  job.setMetadata({
    ...metadata,
    publishRecoveryPending: true,
    publishRecoveryDepth: recoveryDepth + 1,
  });
  job.setResult(result);
  await job.save();
  throw retryableJobError('Project publish failed; retrying publish-only phase', cause);
}

/**
 * Executes a publish-only recovery job. It deliberately skips taxonomy and
 * prompt-corpus reads so an earlier successful draft mutation can be published
 * without reapplying or widening the original operation.
 *
 * @param {object} context
 * @param {object} job
 * @param {object} metadata
 * @param {SerenityTransport} transport
 * @returns {Promise<object>}
 */
async function recoverFailedPublish(context, job, metadata, transport) {
  const publishErrors = await publishAffected(
    transport,
    metadata.workspaceId,
    metadata.projectId ? [metadata.projectId] : [],
    context.log,
  );
  const result = job.getResult?.() ?? {
    matchedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    failureCount: 0,
    failures: [],
  };
  if (publishErrors.length === 0) {
    return {
      ...result,
      outcome: result.failureCount === 0 ? 'SUCCEEDED' : 'PARTIAL_FAILURE',
      publish: { state: 'SUCCEEDED', error: null },
    };
  }
  const retrying = await retryFailedPublish(
    context,
    job,
    metadata,
    result,
    publishErrors[0],
  );
  return {
    ...result,
    outcome: 'PARTIAL_FAILURE',
    publish: {
      state: 'FAILED',
      error: {
        code: ERROR_CODES.SERENITY_UPSTREAM_ERROR,
        message: 'The project could not be published',
        retryable: retrying,
      },
    },
  };
}

/**
 * @param {any} body
 * @returns {{
 *   geoTargetId: number,
 *   languageCode: string,
 *   operation: 'assign' | 'remove',
 *   tagIds: string[],
 *   filter: { tagIds: string[], tagFilterMode: 'faceted-v1', search?: string },
 * }}
 */
export function parseBulkTagsBody(body) {
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw codedError(
      'geoTargetId and languageCode identify one active project',
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (!['assign', 'remove'].includes(body?.operation)) {
    throw codedError(
      'operation must be assign or remove',
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  const tagIds = validateTagIds(body?.tagIds, { required: true });
  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  if (filter.tagFilterMode !== 'faceted-v1') {
    throw codedError(
      'filter.tagFilterMode must be faceted-v1',
      400,
      ERROR_CODES.INVALID_TAG_FILTER,
    );
  }
  const filterTagIds = validateTagIds(filter.tagIds ?? [], {
    maximum: MAX_TAG_FILTER_VALUES,
    tooLargeCode: ERROR_CODES.TAG_FILTER_TOO_LARGE,
  });
  const rawSearch = typeof filter.search === 'string' ? filter.search : '';
  if (Array.from(rawSearch).length > MAX_BULK_TAG_SEARCH_LENGTH) {
    throw codedError(
      `filter.search must not exceed ${MAX_BULK_TAG_SEARCH_LENGTH} characters`,
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  const search = rawSearch.trim();
  return {
    geoTargetId,
    languageCode,
    operation: body.operation,
    tagIds,
    filter: {
      tagIds: filterTagIds,
      tagFilterMode: 'faceted-v1',
      ...(search ? { search } : {}),
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.context
 * @param {SerenityTransport} options.transport
 * @param {string} options.brandId
 * @param {string} options.orgId
 * @param {string} options.workspaceId
 * @param {string} options.projectId
 * @param {ReturnType<typeof parseBulkTagsBody>} options.parsed
 * @param {string} options.callerId
 * @param {string | null} [options.idempotencyKey]
 * @param {object} [options.log]
 * @param {{ promise_token: string, expires_in?: number, token_type?: string }} options.promiseToken
 * @param {string} options.promisePair
 * @returns {Promise<{ status: number, body: object }>}
 */
async function acceptParsedBulkTags({
  context,
  transport,
  brandId,
  orgId,
  workspaceId,
  projectId,
  parsed,
  callerId,
  idempotencyKey,
  log,
  promiseToken,
  promisePair,
}) {
  const hash = canonicalHash(parsed, {
    orgId,
    brandId,
    projectId,
    callerId,
  });
  const key = idempotencyKey == null ? null : String(idempotencyKey).trim();
  if (key && key.length > 256) {
    throw codedError(
      'Idempotency-Key must not exceed 256 characters',
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  const storageKey = key ? idempotencyStorageKey(key) : null;
  if (key) {
    const existing = await context.dataAccess.IdempotencyKey.findActiveKey(storageKey, orgId);
    if (existing) {
      const replay = await replayIdempotentJob(context, existing, storageKey, orgId, hash);
      if (replay) {
        return replay;
      }
    }
  }
  // A create-tag request may have landed on another Lambda container moments
  // earlier. Never validate a mutation against this container's cached taxonomy.
  const snapshot = await readTagTreeSnapshot(
    transport,
    workspaceId,
    projectId,
    log,
    { forceRefresh: true },
  );
  /** @type {TagTreeItem[]} */
  const selected = [];
  for (const id of parsed.tagIds) {
    const item = snapshot.byId.get(id);
    if (!item || item.depth === 1) {
      throw codedError(
        'One or more mutation tagIds are unknown in this project',
        400,
        ERROR_CODES.INVALID_TAG_FILTER,
      );
    }
    const serverOwnedDimension = serverOwnedDimensionOf(item);
    if (serverOwnedDimension) {
      throw codedError(
        `A value of the server-owned "${serverOwnedDimension}" dimension cannot be bulk edited`,
        400,
        ERROR_CODES.INVALID_TAG_FILTER,
      );
    }
    selected.push(item);
  }
  const incompatible = selected.filter((item) => item.compatibility?.state === 'readOnly');
  if (incompatible.length > 0) {
    throw incompatibleTaxonomyError(incompatible);
  }

  const resolvedFilter = await resolveFacetedTagFilter(
    transport,
    workspaceId,
    projectId,
    parsed.filter.tagIds,
    log,
    snapshot,
  );
  // Persist the acceptance-time facet expansion rather than prompt ids. The
  // worker owns the bounded corpus scan, while OR-within-family/AND-across-
  // family membership remains deterministic even if the taxonomy later grows.
  const normalizedFilter = {
    groups: resolvedFilter.groups.map((group) => [...group].sort()),
    candidateIds: [...resolvedFilter.candidateIds].sort(),
    ...(parsed.filter.search ? { search: parsed.filter.search } : {}),
  };

  if (!promiseToken?.promise_token || !promisePair) {
    throw codedError(
      'Bulk tag operations require caller promise credentials',
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }

  let idempotencyEntry;
  if (storageKey) {
    const reservation = await reserveIdempotencyKey(context, storageKey, orgId, hash);
    if (reservation.replay) {
      return reservation.replay;
    }
    idempotencyEntry = reservation.entry;
  }

  let job;
  try {
    job = await createAndEnqueueJob(context, {
      jobType: BULK_TAGS_JOB_TYPE,
      promiseToken,
      promisePair,
      metadata: {
        brandId,
        orgId,
        workspaceId,
        projectId,
        geoTargetId: parsed.geoTargetId,
        languageCode: parsed.languageCode,
        operation: parsed.operation,
        tagIds: parsed.tagIds,
        normalizedFilter,
        ...(key ? { requestHash: hash } : {}),
      },
    });
  } catch (error) {
    if (idempotencyEntry) {
      await releaseIdempotencyKey(context, idempotencyEntry, hash, {
        key: storageKey,
        orgId,
      });
    }
    throw error;
  }
  if (idempotencyEntry) {
    idempotencyEntry
      .setStatus('completed')
      .setResponse({ requestHash: hash, jobId: job.getId() });
    try {
      await idempotencyEntry.save();
    } catch (error) {
      context.log?.warn?.(
        `[serenity-bulk-tags] Accepted job ${job.getId()} but failed to complete idempotency `
        + `claim=${idempotencyEntry.getId?.() ?? 'unknown'} key=${storageKey} org=${orgId} `
        + `endpoint="${BULK_TAGS_IDEMPOTENCY_ENDPOINT}": ${error.message}`,
      );
    }
  }
  return acceptedJobResponse(job, false);
}

/**
 * @param {object} options
 * @param {object} options.context
 * @param {SerenityTransport} options.transport
 * @param {string} options.brandId
 * @param {string} options.orgId
 * @param {string} options.workspaceId
 * @param {string} options.projectId
 * @param {any} options.body
 * @param {string} options.callerId
 * @param {string | null} [options.idempotencyKey]
 * @param {object} [options.log]
 * @param {{ promise_token: string, expires_in?: number, token_type?: string }} options.promiseToken
 * @param {string} options.promisePair
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function acceptBulkTags({
  context,
  transport,
  brandId,
  orgId,
  workspaceId,
  projectId,
  body,
  callerId,
  idempotencyKey,
  log,
  promiseToken,
  promisePair,
}) {
  const parsed = parseBulkTagsBody(body);
  return acceptParsedBulkTags({
    context,
    transport,
    brandId,
    orgId,
    workspaceId,
    projectId,
    parsed,
    callerId,
    idempotencyKey,
    log,
    promiseToken,
    promisePair,
  });
}

/**
 * @param {object} context
 * @param {SerenityTransport} transport
 * @param {object} dataAccess
 * @param {string} brandId
 * @param {string} orgId
 * @param {string} workspaceId
 * @param {any} body
 * @param {string} callerId
 * @param {string | null} idempotencyKey
 * @param {object} log
 * @param {{ promise_token: string, expires_in?: number, token_type?: string }} promiseToken
 * @param {string} promisePair
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleBulkTags(
  context,
  transport,
  dataAccess,
  brandId,
  orgId,
  workspaceId,
  body,
  callerId,
  idempotencyKey,
  log,
  promiseToken,
  promisePair,
) {
  const parsed = parseBulkTagsBody(body);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    parsed.geoTargetId,
    parsed.languageCode,
  );
  if (!row) {
    throw codedError('No market for this brand and slice', 404, ERROR_CODES.MARKET_NOT_FOUND);
  }
  return acceptParsedBulkTags({
    context,
    transport,
    brandId,
    orgId,
    workspaceId,
    projectId: row.getSemrushProjectId(),
    parsed,
    callerId,
    idempotencyKey,
    log,
    promiseToken,
    promisePair,
  });
}

/**
 * @param {object} context
 * @param {SerenityTransport} transport
 * @param {string} brandId
 * @param {string} orgId
 * @param {string} workspaceId
 * @param {any} body
 * @param {string} callerId
 * @param {string | null} idempotencyKey
 * @param {object} log
 * @param {{ promise_token: string, expires_in?: number, token_type?: string }} promiseToken
 * @param {string} promisePair
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleBulkTagsSubworkspace(
  context,
  transport,
  brandId,
  orgId,
  workspaceId,
  body,
  callerId,
  idempotencyKey,
  log,
  promiseToken,
  promisePair,
) {
  const parsed = parseBulkTagsBody(body);
  const project = await resolveProject(
    transport,
    workspaceId,
    parsed.geoTargetId,
    parsed.languageCode,
    log,
  );
  if (!project) {
    throw codedError('No market for this brand and slice', 404, ERROR_CODES.MARKET_NOT_FOUND);
  }
  return acceptParsedBulkTags({
    context,
    transport,
    brandId,
    orgId,
    workspaceId,
    projectId: String(project.id),
    parsed,
    callerId,
    idempotencyKey,
    log,
    promiseToken,
    promisePair,
  });
}

/**
 * @param {object} context
 * @param {{
 *   getId: () => string,
 *   getMetadata: () => any,
 *   getResult?: () => object | null,
 *   setMetadata: (metadata: object) => void,
 *   setResult: (result: object) => void,
 *   save: () => Promise<void>,
 * }} job
 * @param {string} accessToken
 * @param {SerenityTransport} [injectedTransport]
 * @returns {Promise<object>}
 */
export async function bulkTagsHandler(context, job, accessToken, injectedTransport) {
  const metadata = job.getMetadata() ?? {};
  const transport = injectedTransport
    ?? createSerenityTransport({ env: context.env, imsToken: accessToken });
  if (metadata.publishRecoveryPending === true) {
    return recoverFailedPublish(context, job, metadata, transport);
  }
  const snapshot = await readTagTreeSnapshot(
    transport,
    metadata.workspaceId,
    metadata.projectId,
    context.log,
    { forceRefresh: true },
  );
  const requestedTagIds = Array.isArray(metadata.tagIds) ? metadata.tagIds : [];
  const selected = requestedTagIds.map((id) => snapshot.byId.get(id)).filter(Boolean);
  if (selected.length !== requestedTagIds.length
    || selected.some((item) => item.depth === 1
      || serverOwnedDimensionOf(item)
      || item.compatibility?.state === 'readOnly')) {
    throw codedError(
      'The bulk tag mutation no longer resolves to a canonical taxonomy',
      409,
      ERROR_CODES.INCOMPATIBLE_TAG_TAXONOMY,
    );
  }
  const mutationIds = buildBulkTagMutationIds(metadata.operation, selected, snapshot);
  const { normalizedFilter } = metadata;
  const hasNormalizedFilter = normalizedFilter
    && Array.isArray(normalizedFilter.groups)
    && Array.isArray(normalizedFilter.candidateIds);
  const filterGroups = hasNormalizedFilter
    ? normalizedFilter.groups.map((group) => new Set(group.map(String)))
    : [];
  const currentPrompts = await listAllProjectPrompts(
    transport,
    metadata.workspaceId,
    metadata.projectId,
    hasNormalizedFilter
      ? {
        tagIds: normalizedFilter.candidateIds.map(String),
        ...(typeof normalizedFilter.search === 'string'
          ? { search: normalizedFilter.search }
          : {}),
      }
      : undefined,
    context.log,
  );
  const currentPromptsById = new Map(
    currentPrompts.map((prompt) => [String(prompt.id), prompt]),
  );
  const workItems = hasNormalizedFilter
    ? currentPrompts
      .filter((prompt) => matchesBulkTagFacets(prompt, filterGroups))
      .map((prompt) => ({ promptId: String(prompt.id), prompt }))
    : (Array.isArray(metadata.promptIds) ? metadata.promptIds : []).map((promptId) => ({
      promptId: String(promptId),
      prompt: currentPromptsById.get(String(promptId)),
    }));
  const outcomes = await mapLimit(workItems, BULK_CREATE_CONCURRENCY, async ({
    promptId,
    prompt,
  }) => {
    if (!prompt) {
      return {
        failure: {
          semrushPromptId: promptId,
          code: ERROR_CODES.PROMPT_NOT_FOUND,
          message: 'The prompt no longer exists',
          retryable: false,
        },
      };
    }
    const current = promptTagIds(prompt);
    let next;
    try {
      next = applyBulkTagOperation(
        current,
        metadata.operation,
        selected,
        snapshot,
        mutationIds,
      );
    } catch (error) {
      return {
        failure: {
          semrushPromptId: promptId,
          code: error.code ?? ERROR_CODES.TAG_LIMIT_EXCEEDED,
          message: 'The requested tag set exceeds the prompt tag limit',
          retryable: false,
        },
      };
    }
    if (next.length === current.length && next.every((id) => current.includes(id))) {
      return { unchanged: true };
    }
    try {
      await transport.updatePromptTagsByIds(metadata.workspaceId, metadata.projectId, [{
        id: promptId,
        references: next,
        replace: true,
      }]);
      return { updated: true };
    } catch (error) {
      return {
        failure: {
          semrushPromptId: promptId,
          code: isUpstreamGone(error)
            ? ERROR_CODES.PROMPT_NOT_FOUND
            : ERROR_CODES.SERENITY_UPSTREAM_ERROR,
          message: isUpstreamGone(error)
            ? 'The prompt no longer exists'
            : 'The prompt could not be updated',
          retryable: !isUpstreamGone(error),
        },
      };
    }
  });
  const failures = outcomes.filter((outcome) => outcome.failure).map((outcome) => outcome.failure);
  const updatedCount = outcomes.filter((outcome) => outcome.updated).length;
  const unchangedCount = outcomes.filter((outcome) => outcome.unchanged).length;

  if (updatedCount > 0) {
    invalidateTagCacheForProject(metadata.workspaceId, metadata.projectId);
  }
  /** @type {{
   *   state: 'SKIPPED' | 'SUCCEEDED' | 'FAILED',
   *   error: null | { code: string, message: string, retryable: boolean },
   * }} */
  let publish = { state: 'SKIPPED', error: null };
  if (updatedCount > 0) {
    const publishErrors = await publishAffected(
      transport,
      metadata.workspaceId,
      metadata.projectId ? [metadata.projectId] : [],
      context.log,
    );
    if (publishErrors.length === 0) {
      publish = { state: 'SUCCEEDED', error: null };
    } else {
      const result = {
        matchedCount: workItems.length,
        updatedCount,
        unchangedCount,
        failureCount: failures.length,
        failures,
      };
      await retryFailedPublish(context, job, metadata, result, publishErrors[0]);
      publish = {
        state: 'FAILED',
        error: {
          code: ERROR_CODES.SERENITY_UPSTREAM_ERROR,
          message: 'The project could not be published',
          retryable: false,
        },
      };
    }
  }
  return {
    outcome: failures.length === 0 && publish.state !== 'FAILED'
      ? 'SUCCEEDED'
      : 'PARTIAL_FAILURE',
    matchedCount: workItems.length,
    updatedCount,
    unchangedCount,
    failureCount: failures.length,
    failures,
    publish,
  };
}

/**
 * @param {object} result
 * @param {string} [cursor]
 * @param {number} [limit]
 * @returns {object}
 */
export function pageBulkFailures(result, cursor, limit = BULK_FAILURE_PAGE_LIMIT) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const start = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10) : 0;
  const safeStart = Number.isInteger(start) && start >= 0 ? start : 0;
  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), BULK_FAILURE_PAGE_LIMIT)
    : BULK_FAILURE_PAGE_LIMIT;
  const items = failures.slice(safeStart, safeStart + safeLimit);
  const next = safeStart + items.length;
  const rest = { ...result };
  delete rest.failures;
  return {
    ...rest,
    failuresPage: {
      items,
      nextCursor: next < failures.length
        ? Buffer.from(String(next)).toString('base64url')
        : null,
    },
  };
}
