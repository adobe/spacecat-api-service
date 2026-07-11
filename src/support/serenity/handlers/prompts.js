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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode, isValidTagIdFormat } from '../validation.js';
import { invalidateTagCacheForProject } from './markets.js';
import { resolveTypeTagInjection, resolveIntentTagInjection } from './tags.js';
import { TAG_DIMENSION, INTENT_TAG } from '../prompt-tags.js';
import { classifyPromptIntents } from '../intent-classification.js';

// TWIN FILE: the slice→project orchestration here is paralleled by the
// subworkspace-mode handlers in prompts-subworkspace.js. The duplication is
// DEFERRED, not accidental — this flat path (BrandSemrushProject DB lookup) is
// slated for removal once every brand is migrated to sub-workspaces. Until then,
// a behavioural change here almost always needs the same change in the twin; keep
// them in lockstep.
//
// Exported (additively) so the subworkspace-mode handlers (prompts-subworkspace.js) share
// the exact same limits — the only thing that differs between flat and subworkspace
// is slice→project resolution (DB row vs live listing), never the contract.
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 1000;
export const MAX_TAG_IDS = 50;
// Caps the inflight upstream calls when fanning out a bulk create.
// 8 keeps per-call wall time reasonable without overwhelming upstream rate
// limits — the prior `serenity` testing exhausted Semrush's shared limit
// with higher concurrency.
export const BULK_CREATE_CONCURRENCY = 8;
// Matches the OpenAPI declaration (`maxItems: 500` on
// SerenityCreatePromptsRequest.prompts and SerenityBulkDeletePromptsRequest.prompts).
// Enforced here because the api-service does not run OpenAPI request validation
// as middleware — without this cap, an IMS-authenticated caller could submit
// tens of thousands of items inside API Gateway's request envelope and the
// handler would faithfully build per-project Maps + upstream payloads for all
// of them. Defense-in-depth, not a correctness gate.
export const BULK_PROMPTS_MAX_ITEMS = 500;

/**
 * Validates the optional `deferPublish` body flag (serenity-docs#32 CSV-chunking).
 * Present-but-non-boolean is a hard 400 (so a caller typo like `"yes"`/`1` is
 * rejected at the write boundary rather than silently treated as "publish");
 * absent, `false`, or `true` are all accepted. Returns the resolved boolean
 * (absent → false).
 *
 * @param {object} body - request body.
 * @returns {boolean} whether the caller asked to skip the trailing publish.
 */
export function validateDeferPublish(body) {
  const deferPublish = body?.deferPublish;
  if (deferPublish !== undefined && typeof deferPublish !== 'boolean') {
    throw new ErrorWithStatusCode('deferPublish must be a boolean', 400);
  }
  return deferPublish === true;
}

// Builds { tagName → semrushTagId } from the upstream prompt item.
// Object-form tags (the normal Semrush shape) carry both name and id.
// String-form tags (defensive fallback) are included with an empty id so
// callers can still read the name via Object.keys() — they are excluded
// from tag_ids filtering because filter(Boolean) drops empty strings.
function buildTagMapOf(item) {
  if (!Array.isArray(item?.tags)) {
    return {};
  }
  return item.tags.reduce((acc, t) => {
    if (typeof t === 'string' && t) {
      acc[t] = '';
    } else if (typeof t === 'object' && t?.name) {
      acc[t.name] = t.id ? String(t.id) : '';
    }
    return acc;
  }, {});
}

export function buildPromptDto(geoTargetId, languageCode, item) {
  const text = item?.name || '';
  if (!text) {
    return null;
  }
  return {
    semrushPromptId: String(item?.id ?? ''),
    geoTargetId,
    languageCode,
    text,
    tagMap: buildTagMapOf(item),
  };
}

/**
 * GET /serenity/prompts?geoTargetId=&languageCode=&page=&limit=&search=&tagIds= —
 * list prompts for one slice. geoTargetId and languageCode are required.
 * Pagination is real upstream pagination — one slice = one project = one
 * upstream call set per page.
 *
 * tagIds (repeatable): Semrush tag UUIDs from SerenityPrompt.tagMap. Passed
 * as tag_ids to the by_tags endpoint. Semrush applies OR semantics — prompts
 * carrying any of the supplied tag IDs are returned. AND semantics must be
 * enforced by the caller if needed.
 */
export async function handleListPrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }

  // `parsedQuery` in the controller has already converted page/limit to
  // integers (or null on parse failure). Trust that and skip the reparse.
  const page = Number.isInteger(query?.page) && query.page > 0 ? query.page : 1;
  const requestedLimit = Number.isInteger(query?.limit) && query.limit > 0
    ? query.limit : DEFAULT_PAGE_LIMIT;
  const limit = Math.min(requestedLimit, MAX_PAGE_LIMIT);
  const search = hasText(query?.search) ? String(query.search).trim() : undefined;
  const tagIds = Array.isArray(query?.tagIds)
    ? query.tagIds.slice(0, MAX_TAG_IDS).map(String).filter(Boolean)
    : [];

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    // Aligns with handleUpdatePrompt's missing-slice contract: a renamed
    // /deleted market between page load and the call should not silently
    // render an empty list — that hides "this slice no longer exists" behind
    // the same response shape as "this slice exists but has no prompts".
    // Single-slice handlers (list, PATCH) emit 404 marketNotFound; bulk
    // handlers (create, bulk-delete) keep their per-item skipped/failed
    // shape because each item carries its own slice and the body can mix
    // slices that exist with slices that don't. (Review Important #4.)
    const err = new ErrorWithStatusCode(
      'No market for this brand and (geoTargetId, languageCode) slice',
      404,
    );
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }

  const resp = await transport.listPromptsByTags(
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    {
      tag_ids: tagIds,
      page,
      limit,
      search,
    },
  );
  const items = Array.isArray(resp?.items) ? resp.items : [];
  // When fewer items than the limit are returned we are on the last page and
  // know the exact filtered count. Avoids trusting the upstream total which
  // may be the project-wide count rather than the tag/search-filtered count.
  let total;
  if (items.length < limit) {
    total = (page - 1) * limit + items.length;
  } else {
    total = Number.isFinite(resp?.total) ? resp.total : items.length;
  }
  return {
    items: items
      .map((item) => buildPromptDto(geoTargetId, languageCode, item))
      .filter(Boolean),
    total,
    page,
    limit,
  };
}

export async function publishAffected(transport, semrushWorkspaceId, projectIds, log) {
  const unique = Array.from(new Set(projectIds.filter(Boolean)));
  const errors = [];
  await Promise.all(unique.map(async (pid) => {
    try {
      await transport.publishProject(semrushWorkspaceId, pid);
    } catch (e) {
      log?.warn?.('publishProject failed', { projectId: pid, error: e.message });
      errors.push({ projectId: pid, message: redactUpstreamMessage(e) });
    }
  }));
  return errors;
}

/**
 * Trims a raw `tagIds` array to strings, drops anything empty or malformed
 * (see {@link isValidTagIdFormat} -- the same length/control-char bound
 * `parentId` is held to), and caps the result at {@link MAX_TAG_IDS} -- the
 * same cap the tagIds *query* filter already enforces above, so a bulk write
 * can't fan out further than a bulk read is allowed to. Shared by
 * {@link normalizePromptInput} (create) and {@link parseUpdatePromptBody}
 * (update) so the two write paths can't silently diverge on what counts as
 * a valid tag id.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeTagIds(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((t) => String(t || '').trim())
    .filter((t) => isValidTagIdFormat(t))
    .slice(0, MAX_TAG_IDS);
}

/**
 * Normalizes one bulk-create/update prompt input. `tags` (names, the legacy
 * write path via `aio/prompts/tagged`) and `tagIds` (upstream tag ids, the
 * id-based write path via `aio/prompts`) are MUTUALLY EXCLUSIVE — at most one
 * of the two BODY KEYS may be present (presence-based, matching
 * {@link parseUpdatePromptBody}'s PATCH contract so the same input shape is
 * accepted/rejected identically on create and update), and `tagIds` when
 * present must resolve to a non-empty array. `tagIds` stays `undefined` when
 * absent so the handler can branch on `input.tagIds !== undefined` to pick
 * the write path; `tags` always defaults to `[]` (unused, not `undefined`)
 * to keep the name-based path's existing contract unchanged.
 */
export function normalizePromptInput(input) {
  const text = String(input?.text || '').trim();
  const languageCode = normalizeLanguageCode(input?.languageCode);
  const geoTargetId = normalizeGeoTargetId(Number(input?.geoTargetId));
  if (!text || languageCode === null || geoTargetId === null) {
    return null;
  }
  const hasTagsField = input?.tags !== undefined;
  const hasTagIdsField = input?.tagIds !== undefined;
  if (hasTagsField && hasTagIdsField) {
    return null;
  }
  if (hasTagIdsField) {
    const tagIds = sanitizeTagIds(input.tagIds);
    if (tagIds.length === 0) {
      return null;
    }
    return {
      text, languageCode, geoTargetId, tags: [], tagIds,
    };
  }
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  return {
    text, languageCode, geoTargetId, tags, tagIds: undefined,
  };
}

/**
 * Creates ONE prompt via whichever upstream write path `input` requests --
 * id-based (`POST aio/prompts`, when `input.tagIds` is set -- serenity-docs#24)
 * or the legacy name-based path (`POST aio/prompts/tagged`, when `input.tags`
 * is used). Both {@link handleCreatePrompts}'s per-item fan-out and
 * {@link handleUpdatePrompt}'s post-delete recreate call this, so the two
 * upstream shapes are never duplicated across create and update.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {{ text: string, tags: string[], tagIds: string[] | undefined }} input
 * @returns {Promise<string>} the new upstream prompt id, or '' if the
 *   response carried none.
 */
export async function createOnePrompt(transport, semrushWorkspaceId, projectId, input) {
  if (input.tagIds !== undefined) {
    const resp = await transport.createPromptsByIds(
      semrushWorkspaceId,
      projectId,
      [input.text],
      input.tagIds,
    );
    return Array.isArray(resp?.items) && resp.items.length > 0
      ? String(resp.items[0].id ?? '')
      : '';
  }
  const resp = await transport.createTaggedPrompts(
    semrushWorkspaceId,
    projectId,
    { [input.text]: input.tags },
  );
  return Array.isArray(resp?.ids) && resp.ids.length > 0 ? String(resp.ids[0]) : '';
}

/**
 * Builds the per-request `type:*` injector — the UNIFIED classification layer
 * (serenity-docs#31). Given a pure `classifyPromptType(text, geoTargetId)`
 * closure (built by the controller from the brand name + region-clamped
 * aliases), it returns `injectComputedType(projectId, input)` which:
 *   - STRIPS any caller-supplied `type:*` tag (the client may never set it), and
 *   - APPENDS the server-computed one — as a tag NAME on the name-based path, or
 *     as a pre-resolved upstream tag ID on the id-based path (the atomic
 *     `createPromptsByIds` 500s on an unresolved id, so it must be resolved
 *     BEFORE the write).
 * The returned input carries the rewritten `tags`/`tagIds`, so the caller's
 * response echo reflects the computed type without a refetch (decision 5).
 *
 * Id-based resolution ({@link resolveTypeTagInjection}, one tag-tree read per
 * distinct `type:` value per project) is memoized for the request, so a bulk
 * create fans out at most two tag-tree reads per project regardless of item
 * count. A non-function `classifyPromptType` (defensive) is a pass-through.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {((text: string, geoTargetId: number) => string) | undefined} classifyPromptType
 * @param {object} [log]
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tags: string[], tagIds: string[] | undefined }) =>
 *   Promise<{ text: string, geoTargetId: number, tags: string[], tagIds: string[] | undefined }>}
 */
export function makeTypeInjector(transport, semrushWorkspaceId, classifyPromptType, log) {
  /** @type {Map<string, Promise<{ computedId: string | undefined, typeTagIds: string[] }>>} */
  const cache = new Map();
  return async function injectComputedType(projectId, input) {
    if (typeof classifyPromptType !== 'function') {
      return input;
    }
    const typeTag = classifyPromptType(input.text, input.geoTargetId);
    if (input.tagIds === undefined) {
      const stripped = (Array.isArray(input.tags) ? input.tags : [])
        .filter((t) => !String(t).startsWith(`${TAG_DIMENSION.TYPE}:`));
      return { ...input, tags: [...stripped, typeTag] };
    }
    const key = `${projectId} ${typeTag}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveTypeTagInjection(transport, semrushWorkspaceId, projectId, typeTag, log);
      cache.set(key, pending);
    }
    const { computedId, typeTagIds } = await pending;
    const stripped = input.tagIds.filter((id) => !typeTagIds.includes(id));
    return { ...input, tagIds: computedId ? [...stripped, computedId] : stripped };
  };
}

/**
 * Applies a pre-computed, per-request `intent:*` classification map to a
 * prompt write (serenity-docs#32). Unlike {@link makeTypeInjector}, the
 * "compute the tag" step is a `Map` lookup, not a per-item classify call —
 * intent is batch-classified ONCE per request (see `classifyPromptIntents` in
 * `../intent-classification.js`) since it's an LLM call, not a cheap pure
 * function. A text missing from `intentByText` (e.g. beyond the AI-gen classify
 * cap) falls back to `INTENT_TAG.INFORMATIONAL`, the seeded standard value.
 *
 * Id-based resolution ({@link resolveIntentTagInjection}, one tag-tree read per
 * distinct `intent:` value per project) is memoized for the request, mirroring
 * {@link makeTypeInjector}'s memoization.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {Map<string, string>} intentByText - text -> `intent:<Value>` wire tag.
 * @param {object} [log]
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tags: string[], tagIds: string[] | undefined }) =>
 *   Promise<{ text: string, geoTargetId: number, tags: string[],
 *   tagIds: string[] | undefined }>}
 */
export function makeIntentInjector(transport, semrushWorkspaceId, intentByText, log) {
  /** @type {Map<string, Promise<{ computedId: string | undefined, intentTagIds: string[] }>>} */
  const cache = new Map();
  return async function injectComputedIntent(projectId, input) {
    const intentTag = intentByText.get(input.text) ?? INTENT_TAG.INFORMATIONAL;
    if (input.tagIds === undefined) {
      const stripped = (Array.isArray(input.tags) ? input.tags : [])
        .filter((t) => !String(t).startsWith(`${TAG_DIMENSION.INTENT}:`));
      return { ...input, tags: [...stripped, intentTag] };
    }
    const key = `${projectId} ${intentTag}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveIntentTagInjection(transport, semrushWorkspaceId, projectId, intentTag, log);
      cache.set(key, pending);
    }
    const { computedId, intentTagIds } = await pending;
    const stripped = input.tagIds.filter((id) => !intentTagIds.includes(id));
    return { ...input, tagIds: computedId ? [...stripped, computedId] : stripped };
  };
}

/**
 * Validates + normalizes a PATCH prompt body's `text`/`tags`/`tagIds`, shared
 * by {@link handleUpdatePrompt} and its subworkspace twin. `tags` (names) and
 * `tagIds` (upstream ids) are mutually exclusive, mirroring
 * {@link normalizePromptInput}; exactly one must be present. Returns either
 * `{ ok: true, text, tags, tagIds }` or `{ ok: false, status, body }` (the
 * caller returns the latter directly as the handler's 400 response).
 *
 * @param {object} body - the PATCH request body.
 * @returns {{ ok: true, text: string, tags: string[], tagIds: string[] | undefined }
 *   | { ok: false, status: number, body: object }}
 */
export function parseUpdatePromptBody(body) {
  const hasTagsField = body?.tags !== undefined;
  const hasTagIdsField = body?.tagIds !== undefined;
  if (!body || body.text === undefined || (!hasTagsField && !hasTagIdsField)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'missingFields',
        message: 'PATCH body must include text and either tags or tagIds',
      },
    };
  }
  if (hasTagsField && hasTagIdsField) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalidRequest', message: 'tags and tagIds are mutually exclusive' },
    };
  }
  const text = String(body.text);
  if (hasTagIdsField) {
    const tagIds = sanitizeTagIds(body.tagIds);
    if (tagIds.length === 0) {
      return {
        ok: false,
        status: 400,
        body: { error: 'invalidRequest', message: 'tagIds must be a non-empty array' },
      };
    }
    return {
      ok: true, text, tags: [], tagIds,
    };
  }
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  return {
    ok: true, text, tags, tagIds: undefined,
  };
}

export async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const idx = i;
        i += 1;
        if (idx >= items.length) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await mapper(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * POST /serenity/prompts — bulk create.
 * Each input must carry `(geoTargetId, languageCode, text, tags?)`. Inputs
 * are grouped by slice; the matching BrandSemrushProject row resolves the
 * upstream project; publish runs once per affected project at the end —
 * unless `body.deferPublish` is true (serenity-docs#32 CSV-chunking), in
 * which case the create is a draft-only write and the caller is responsible
 * for triggering a publish itself (e.g. a normal, non-deferred call on the
 * last chunk of an import, which publishes every project touched across the
 * whole import since a single CSV import always targets one project).
 */
export async function handleCreatePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  classifyPromptType,
  env,
  writeDeadline,
) {
  const inputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (inputs.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }
  if (inputs.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
  }
  const deferPublish = validateDeferPublish(body);

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectsBySlice = new Map();
  for (const p of projects || []) {
    projectsBySlice.set(`${p.getGeoTargetId()}:${p.getLanguageCode()}`, p);
  }

  const injectComputedType = makeTypeInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
  );
  // Unified layer (serenity-docs#32): batch-classify every distinct text ONCE
  // under the shared request deadline, then thread the resolved map into each
  // per-item injection below (a per-item LLM call would be far too slow).
  const intentByText = await classifyPromptIntents(
    inputs.map((raw) => String(raw?.text || '')),
    { env, log, deadline: writeDeadline },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);

  const results = await mapLimit(inputs, BULK_CREATE_CONCURRENCY, async (raw) => {
    const input = normalizePromptInput(raw);
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: 'text, languageCode, and geoTargetId are required',
        },
      };
    }
    const project = projectsBySlice.get(`${input.geoTargetId}:${input.languageCode}`);
    if (!project) {
      return {
        skipped: {
          text: input.text,
          reason: `No market for slice (${input.geoTargetId}, ${input.languageCode})`,
        },
      };
    }
    const projectId = project.getSemrushProjectId();
    try {
      // Unified layer: strip any caller-supplied type/intent + inject the computed ones.
      let typed = await injectComputedType(projectId, input);
      typed = await injectComputedIntent(projectId, typed);
      const semrushPromptId = await createOnePrompt(
        transport,
        semrushWorkspaceId,
        projectId,
        typed,
      );
      return {
        created: {
          semrushPromptId,
          geoTargetId: typed.geoTargetId,
          languageCode: input.languageCode,
          text: typed.text,
          tags: typed.tags,
          ...(typed.tagIds !== undefined ? { tagIds: typed.tagIds } : {}),
        },
        affectedProjectId: projectId,
      };
    } catch (e) {
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: e.status || 500,
          message: redactUpstreamMessage(e),
        },
      };
    }
  });

  const created = [];
  const skipped = [];
  const failed = [];
  const affectedProjectIds = [];
  for (const r of results) {
    if (r.created) {
      created.push(r.created);
      affectedProjectIds.push(r.affectedProjectId);
    } else if (r.skipped) {
      skipped.push(r.skipped);
    } else if (r.failed) {
      failed.push(r.failed);
    }
  }

  // Tag cache invalidation: a new prompt may introduce a new tag (or
  // resurrect a tag whose last prompt was previously deleted), so any
  // project that received a successful create must drop its cached
  // tag set on this container.
  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  if (deferPublish) {
    log?.info?.('serenity create-prompts: deferPublish set — prompts written as draft, publish skipped', {
      brandId, created: created.length, skipped: skipped.length, failed: failed.length,
    });
    return {
      created, skipped, failed, published: false,
    };
  }

  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    affectedProjectIds,
    log,
  );
  // publishAffected returns already-redacted { projectId, message } records;
  // pubErr is a record, not a raw error, so pubErr.message is safe to surface.
  for (const pubErr of publishErrors) {
    failed.push({
      text: '',
      status: 502,
      message: `publish: ${pubErr.message}`,
    });
  }

  return {
    created, skipped, failed, published: true,
  };
}

/**
 * PATCH /serenity/prompts/:semrushPromptId — replace.
 *
 * Body carries `{geoTargetId, languageCode, text, tags}` (name-based) or
 * `{geoTargetId, languageCode, text, tagIds}` (id-based, mutually exclusive
 * with `tags` -- see {@link parseUpdatePromptBody}). All are required: the
 * upstream provider has no in-place update (no GET-by-id either), so the
 * implementation is DELETE-then-CREATE and we treat the payload as the full
 * next state. Clients always have the existing text/tags(-ids) available
 * locally (they were returned by the preceding list call that rendered the
 * edit form), so requiring both keeps the server side a single straight line
 * and removes the per-request pagination that "preserve-on-omit" semantics
 * would force.
 *
 * Contract:
 *   - body missing text, or missing both tags and tagIds, or both present
 *     → 400 (missingFields / invalidRequest).
 *   - slice missing on the brand → 404 (marketNotFound).
 *   - upstream DELETE returns 404 → 404 (promptNotFound).
 *   - upstream DELETE returns any other error → throw (handler-level
 *     500 / 502 mapping by the controller). We never CREATE after a
 *     failed DELETE: a previous warn-and-create behaviour produced
 *     duplicate prompts whenever DELETE flaked (5xx / timeout).
 *
 * After a successful CREATE the per-project tag cache is invalidated on
 * this container (a PATCH can introduce a new tag or drop the last
 * carrier of an old tag), then `publishProject` is fired to push the
 * new upstream prompt id live.
 */
export async function handleUpdatePrompt(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  semrushPromptId,
  body,
  log,
  classifyPromptType,
  env,
  writeDeadline,
) {
  // `semrushPromptId` is validated as non-empty at the controller boundary
  // (serenity.js:259) before this handler is invoked over HTTP, so no
  // re-check here.
  const parsedBody = parseUpdatePromptBody(body);
  if (!parsedBody.ok) {
    return { status: parsedBody.status, body: parsedBody.body };
  }
  const { text: nextText, tags: nextTags, tagIds: nextTagIds } = parsedBody;
  const geoTargetId = normalizeGeoTargetId(Number(body.geoTargetId));
  const languageCode = normalizeLanguageCode(body.languageCode);
  if (geoTargetId === null || languageCode === null) {
    return {
      status: 400,
      body: {
        error: 'invalidRequest',
        message: 'PATCH body must include geoTargetId (integer) and languageCode (BCP-47 primary subtag)',
      },
    };
  }

  const project = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!project) {
    return {
      status: 404,
      body: {
        error: 'marketNotFound',
        message: 'No market for this brand and (geoTargetId, languageCode) slice',
      },
    };
  }
  const projectId = project.getSemrushProjectId();

  // Recompute the type AND intent tags from the NEW text BEFORE the delete: the
  // unified layer (tree read / on-demand tag create / LLM classify) must not run
  // between delete and create, so a classification failure aborts cleanly with
  // the old prompt still present (serenity-docs#31, #32).
  const injectComputedType = makeTypeInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
  );
  const intentByText = await classifyPromptIntents(
    [nextText],
    { env, log, deadline: writeDeadline },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);
  let typed = await injectComputedType(projectId, {
    text: nextText, geoTargetId, tags: nextTags, tagIds: nextTagIds,
  });
  typed = await injectComputedIntent(projectId, typed);

  try {
    await transport.deletePromptsByIds(semrushWorkspaceId, projectId, [semrushPromptId]);
  } catch (e) {
    if (isUpstreamGone(e)) {
      return {
        status: 404,
        body: {
          error: 'promptNotFound',
          message: 'No upstream prompt matches the supplied semrushPromptId in this slice',
        },
      };
    }
    log?.error?.('handleUpdatePrompt: deletePromptsByIds failed; aborting before create to avoid duplicate', {
      projectId,
      semrushPromptId,
      error: e.message,
    });
    throw e;
  }

  let newSemrushPromptId;
  try {
    newSemrushPromptId = await createOnePrompt(transport, semrushWorkspaceId, projectId, typed);
  } catch (e) {
    // The DELETE above already succeeded, so the old prompt is gone upstream —
    // a failure here (e.g. an unresolvable tagId 500ing the atomic id-based
    // create) is a genuine data-loss event, not a retryable no-op. Log it
    // distinctly from the pre-delete failure above so on-call can tell "nothing
    // happened" apart from "the prompt is gone and must be recreated manually".
    log?.error?.('handleUpdatePrompt: createOnePrompt failed AFTER a successful delete; the prompt is now lost upstream and must be recreated manually', {
      projectId,
      semrushPromptId,
      error: e.message,
    });
    throw e;
  }

  invalidateTagCacheForProject(semrushWorkspaceId, projectId);

  await publishAffected(transport, semrushWorkspaceId, [projectId], log);

  return {
    status: 200,
    body: {
      semrushPromptId: newSemrushPromptId,
      geoTargetId,
      languageCode,
      text: nextText,
      tags: typed.tags,
      ...(typed.tagIds !== undefined ? { tagIds: typed.tagIds } : {}),
    },
  };
}

/**
 * POST /serenity/prompts/bulk-delete — body is
 * `{ prompts: [{semrushPromptId, geoTargetId, languageCode}, ...] }`.
 * Resolves each row's owning slice, batches deletes per upstream project,
 * publishes affected projects. Upstream 404 == idempotent success.
 */
export async function handleBulkDeletePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
  const targets = Array.isArray(body?.prompts) ? body.prompts : [];
  if (targets.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }
  if (targets.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
  }

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectBySlice = new Map();
  for (const p of projects || []) {
    projectBySlice.set(
      `${p.getGeoTargetId()}:${p.getLanguageCode()}`,
      p.getSemrushProjectId(),
    );
  }

  const byProject = new Map();
  const failed = [];
  targets.forEach((t) => {
    const sid = String(t?.semrushPromptId || '');
    const geoTargetId = normalizeGeoTargetId(Number(t?.geoTargetId));
    const languageCode = normalizeLanguageCode(t?.languageCode);
    if (!sid || geoTargetId === null || languageCode === null) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId,
        languageCode,
        message: 'Missing semrushPromptId, geoTargetId, or languageCode',
      });
      return;
    }
    const pid = projectBySlice.get(`${geoTargetId}:${languageCode}`);
    if (!pid) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId,
        languageCode,
        message: `No market for slice (${geoTargetId}, ${languageCode})`,
      });
      return;
    }
    if (!byProject.has(pid)) {
      byProject.set(pid, { ids: [], targets: [] });
    }
    const bucket = byProject.get(pid);
    bucket.ids.push(sid);
    bucket.targets.push({ semrushPromptId: sid, geoTargetId, languageCode });
  });

  let deleted = 0;
  const projectsToPublish = new Set();
  await Promise.all(Array.from(byProject.entries()).map(async ([pid, bucket]) => {
    try {
      await transport.deletePromptsByIds(semrushWorkspaceId, pid, bucket.ids);
      deleted += bucket.ids.length;
      projectsToPublish.add(pid);
    } catch (e) {
      if (isUpstreamGone(e)) {
        deleted += bucket.ids.length;
        projectsToPublish.add(pid);
        log?.info?.('bulk-delete: upstream already-deleted (404 treated as success)', { ids: bucket.ids });
        return;
      }
      bucket.targets.forEach((t) => {
        failed.push({
          semrushPromptId: t.semrushPromptId,
          geoTargetId: t.geoTargetId,
          languageCode: t.languageCode,
          status: e.status || 500,
          message: redactUpstreamMessage(e),
        });
      });
    }
  }));

  // Deleting prompts can remove the last carrier of a tag in the project,
  // so any project that lost prompts must drop its cached tag set on this
  // container.
  for (const pid of projectsToPublish) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    Array.from(projectsToPublish),
    log,
  );
  // pubErr is an already-redacted { projectId, message } record (see above).
  publishErrors.forEach((pubErr) => {
    failed.push({
      semrushPromptId: '',
      status: 502,
      message: `publish: ${pubErr.message}`,
    });
  });

  return { deleted, failed };
}
