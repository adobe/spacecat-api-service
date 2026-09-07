/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0.
 */

// @ts-check

import { createHash } from 'node:crypto';
import { ErrorWithStatusCode } from '../../utils.js';
import { createSerenityTransport } from '../rest-transport.js';
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { resolveProject } from '../subworkspace-projects.js';
import { readTagTreeSnapshot, incompatibleTaxonomyError } from '../tag-tree.js';
import { createAndEnqueueJob } from '../async-job-runner.js';
import {
  assertPromptTagLimit,
  listAllProjectPrompts,
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

export const BULK_TAGS_JOB_TYPE = 'serenity-bulk-tags';
export const BULK_TAGS_PUBLIC_JOB_TYPE = 'bulkTags';
export const BULK_FAILURE_PAGE_LIMIT = 100;

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

function matchesFacets(prompt, groups) {
  if (groups.length === 0) {
    return true;
  }
  const ids = new Set(promptTagIds(prompt));
  return groups.every((group) => [...group].some((id) => ids.has(id)));
}

function applyOperation(currentIds, operation, selected, snapshot) {
  const result = new Set(currentIds);
  if (operation === 'assign') {
    for (const item of selected) {
      result.add(item.id);
      if (item.rootName === 'tag' && item.depth === 3) {
        result.add(item.fullPath[1].id);
      }
    }
  } else {
    for (const item of selected) {
      result.delete(item.id);
      if (item.rootName === 'tag' && item.depth === 2) {
        for (const candidate of snapshot.items) {
          if (candidate.fullPath.some((part) => part.id === item.id)) {
            result.delete(candidate.id);
          }
        }
      }
    }
  }

  for (const id of [...result]) {
    const item = snapshot.byId.get(id);
    if (item?.rootName === 'tag' && item.depth === 3) {
      result.add(item.fullPath[1].id);
    }
  }
  const ids = [...result];
  assertPromptTagLimit(ids);
  return ids;
}

function canonicalHash(body) {
  const canonical = {
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

function idempotencyJobId(scope) {
  const hex = createHash('sha256').update(scope).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20).join(''),
  ].join('-');
}

function parseBody(body) {
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw codedError(
      'geoTargetId and languageCode identify one active project',
      400,
      'invalidRequest',
    );
  }
  if (!['assign', 'remove'].includes(body?.operation)) {
    throw codedError('operation must be assign or remove', 400, 'invalidRequest');
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
  return {
    geoTargetId,
    languageCode,
    operation: body.operation,
    tagIds,
    filter: {
      tagIds: filterTagIds,
      tagFilterMode: 'faceted-v1',
      ...(typeof filter.search === 'string' && filter.search.trim()
        ? { search: filter.search.trim() }
        : {}),
    },
  };
}

async function acceptBulkTags({
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
}) {
  const parsed = parseBody(body);
  const hash = canonicalHash(parsed);
  const key = idempotencyKey == null ? null : String(idempotencyKey).trim();
  if (key && key.length > 256) {
    throw codedError('Idempotency-Key must not exceed 256 characters', 400, 'invalidRequest');
  }
  const scope = `${orgId}:${brandId}:${projectId}:${callerId}:${key ?? ''}`;
  const now = Date.now();
  const deterministicJobId = key ? idempotencyJobId(scope) : undefined;
  if (key) {
    const existing = await context.dataAccess.AsyncJob.findById(deterministicJobId);
    const existingMetadata = existing?.getMetadata?.() ?? {};
    if (existing && Number(existingMetadata.idempotencyExpiresAt) > now) {
      if (existingMetadata.requestHash !== hash) {
        throw codedError(
          'Idempotency-Key was reused with a different bulk tag request',
          409,
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
      }
      return {
        status: 200,
        body: {
          jobId: existing.getId(),
          jobType: BULK_TAGS_PUBLIC_JOB_TYPE,
          status: existing.getStatus(),
          matchedCount: existingMetadata.matchedCount,
          replayed: true,
        },
      };
    }
    if (existing) {
      await existing.remove();
    }
  }
  const snapshot = await readTagTreeSnapshot(transport, workspaceId, projectId, log);
  const selected = parsed.tagIds.map((id) => snapshot.byId.get(id));
  if (selected.some((item) => !item || item.depth === 1)) {
    throw codedError(
      'One or more mutation tagIds are unknown in this project',
      400,
      ERROR_CODES.INVALID_TAG_FILTER,
    );
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
  );
  const prompts = (await listAllProjectPrompts(transport, workspaceId, projectId, {
    tagIds: resolvedFilter.candidateIds,
    search: parsed.filter.search,
  })).filter((prompt) => matchesFacets(prompt, resolvedFilter.groups));

  for (const prompt of prompts) {
    applyOperation(promptTagIds(prompt), parsed.operation, selected, snapshot);
  }

  let job;
  try {
    job = await createAndEnqueueJob(context, {
      jobType: BULK_TAGS_JOB_TYPE,
      jobId: deterministicJobId,
      metadata: {
        brandId,
        orgId,
        workspaceId,
        projectId,
        geoTargetId: parsed.geoTargetId,
        languageCode: parsed.languageCode,
        operation: parsed.operation,
        tagIds: parsed.tagIds,
        promptIds: prompts.map((prompt) => String(prompt.id)),
        matchedCount: prompts.length,
        ...(key ? {
          requestHash: hash,
          idempotencyExpiresAt: now + BULK_IDEMPOTENCY_TTL_SECONDS * 1000,
        } : {}),
      },
    });
  } catch (error) {
    if (!deterministicJobId) {
      throw error;
    }
    const raced = await context.dataAccess.AsyncJob.findById(deterministicJobId);
    const racedMetadata = raced?.getMetadata?.() ?? {};
    if (!raced || racedMetadata.requestHash !== hash) {
      throw error;
    }
    return {
      status: 200,
      body: {
        jobId: raced.getId(),
        jobType: BULK_TAGS_PUBLIC_JOB_TYPE,
        status: raced.getStatus(),
        matchedCount: racedMetadata.matchedCount,
        replayed: true,
      },
    };
  }
  return {
    status: 202,
    body: {
      jobId: job.getId(),
      jobType: BULK_TAGS_PUBLIC_JOB_TYPE,
      status: job.getStatus(),
      matchedCount: prompts.length,
      replayed: false,
    },
  };
}

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
) {
  const parsed = parseBody(body);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    parsed.geoTargetId,
    parsed.languageCode,
  );
  if (!row) {
    throw codedError('No market for this brand and slice', 404, ERROR_CODES.MARKET_NOT_FOUND);
  }
  return acceptBulkTags({
    context,
    transport,
    brandId,
    orgId,
    workspaceId,
    projectId: row.getSemrushProjectId(),
    body: parsed,
    callerId,
    idempotencyKey,
    log,
  });
}

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
) {
  const parsed = parseBody(body);
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
  return acceptBulkTags({
    context,
    transport,
    brandId,
    orgId,
    workspaceId,
    projectId: String(project.id),
    body: parsed,
    callerId,
    idempotencyKey,
    log,
  });
}

export async function bulkTagsHandler(context, job, accessToken) {
  const metadata = job.getMetadata() ?? {};
  const transport = createSerenityTransport({ env: context.env, imsToken: accessToken });
  const snapshot = await readTagTreeSnapshot(
    transport,
    metadata.workspaceId,
    metadata.projectId,
    context.log,
  );
  const requestedTagIds = Array.isArray(metadata.tagIds) ? metadata.tagIds : [];
  const selected = requestedTagIds.map((id) => snapshot.byId.get(id)).filter(Boolean);
  if (selected.length !== requestedTagIds.length
    || selected.some((item) => item.compatibility?.state === 'readOnly')) {
    throw codedError(
      'The bulk tag mutation no longer resolves to a canonical taxonomy',
      409,
      ERROR_CODES.INCOMPATIBLE_TAG_TAXONOMY,
    );
  }
  const currentPrompts = await listAllProjectPrompts(
    transport,
    metadata.workspaceId,
    metadata.projectId,
  );
  const byId = new Map(currentPrompts.map((prompt) => [String(prompt.id), prompt]));
  const failures = [];
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const promptId of metadata.promptIds) {
    const prompt = byId.get(promptId);
    if (!prompt) {
      failures.push({
        semrushPromptId: promptId,
        code: 'promptNotFound',
        message: 'The prompt no longer exists',
        retryable: false,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    const current = promptTagIds(prompt);
    let next;
    try {
      next = applyOperation(current, metadata.operation, selected, snapshot);
    } catch (error) {
      failures.push({
        semrushPromptId: promptId,
        code: error.code ?? ERROR_CODES.TAG_LIMIT_EXCEEDED,
        message: error.message,
        retryable: false,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (next.length === current.length && next.every((id) => current.includes(id))) {
      unchangedCount += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.updatePromptTagsByIds(metadata.workspaceId, metadata.projectId, [{
        id: promptId,
        references: next,
        replace: true,
      }]);
      updatedCount += 1;
    } catch (error) {
      failures.push({
        semrushPromptId: promptId,
        code: isUpstreamGone(error) ? 'promptNotFound' : 'serenityUpstreamError',
        message: isUpstreamGone(error)
          ? 'The prompt no longer exists'
          : 'The prompt could not be updated',
        retryable: !isUpstreamGone(error),
      });
    }
  }

  invalidateTagCacheForProject(metadata.workspaceId, metadata.projectId);
  const publishErrors = await publishAffected(
    transport,
    metadata.workspaceId,
    updatedCount > 0 ? [metadata.projectId] : [],
    context.log,
  );
  const publish = publishErrors.length === 0
    ? { state: 'SUCCEEDED', error: null }
    : {
      state: 'FAILED',
      error: {
        code: 'serenityUpstreamError',
        message: 'The project could not be published',
        retryable: true,
      },
    };
  return {
    matchedCount: metadata.matchedCount,
    processedCount: metadata.matchedCount,
    updatedCount,
    unchangedCount,
    failureCount: failures.length,
    failures,
    publish,
  };
}

export function pageBulkFailures(result, cursor, limit = BULK_FAILURE_PAGE_LIMIT) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const start = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10) : 0;
  const safeStart = Number.isInteger(start) && start >= 0 ? start : 0;
  const safeLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, BULK_FAILURE_PAGE_LIMIT)
    : BULK_FAILURE_PAGE_LIMIT;
  const items = failures.slice(safeStart, safeStart + safeLimit);
  const next = safeStart + items.length;
  const { failures: ignored, ...rest } = result;
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
