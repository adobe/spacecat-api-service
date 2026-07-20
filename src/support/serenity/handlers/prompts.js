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
import { resolveTypeValueInjection, resolveOriginValueInjection } from '../tag-tree.js';
import { ORIGIN_VALUE } from '../prompt-tags.js';

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
 * Builds the prompt's tag list from the upstream item: one entry per tag,
 * carrying its id, bare name, parent id and root-first ancestry breadcrumb.
 *
 * This is the authoritative shape. Tag names are NOT unique — upstream scopes
 * uniqueness to `(project, parent)` — so a prompt can legitimately carry two
 * different tags with the same bare name (a sub-category `human` and the
 * `source` value `human`). A list keyed by id preserves both; anything keyed by
 * name silently drops one.
 *
 * Parentage comes straight off the prompt payload. Upstream serializes a tag
 * identically wherever it appears — embedded on a prompt or listed by
 * `GET /aio/tags` — and the two objects compare equal for the same id (verified
 * live 2026-07-10). What varies is DEPTH, not endpoint: a ROOT tag omits
 * `parent_id` and `path` entirely, while a descendant carries both. So a tag
 * with no `path` is a root, and its own name is its dimension.
 *
 * String-form tags (a defensive upstream fallback) carry a name but no id, and
 * are surfaced with an empty id rather than dropped.
 *
 * @param {any} item - the upstream prompt item.
 * @returns {Array<{ id: string, name: string, parentId: string | null,
 *   path: Array<{ id: string, name: string }> | null }>}
 */
function buildTagsOf(item) {
  if (!Array.isArray(item?.tags)) {
    return [];
  }
  return item.tags.reduce((acc, t) => {
    if (typeof t === 'string' && t) {
      acc.push({
        id: '', name: t, parentId: null, path: null,
      });
    } else if (typeof t === 'object' && t?.name) {
      acc.push({
        id: t.id ? String(t.id) : '',
        name: String(t.name),
        parentId: typeof t.parent_id === 'string' && t.parent_id ? t.parent_id : null,
        path: Array.isArray(t.path)
          ? t.path.map((p) => ({
            id: typeof p?.id === 'string' ? p.id : '',
            name: typeof p?.name === 'string' ? p.name : '',
          }))
          : null,
      });
    }
    return acc;
  }, []);
}

/**
 * DEPRECATED — `{ tagName → semrushTagId }`, kept only so existing consumers
 * keep working while they migrate to {@link buildTagsOf}'s `tags` list. Being
 * name-keyed, it CANNOT represent a prompt carrying two same-named tags from
 * different dimensions: the later one overwrites the earlier, and which survives
 * depends on upstream ordering. Remove once every consumer reads `tags`.
 *
 * @param {any} item - the upstream prompt item.
 * @returns {Record<string, string>}
 */
function buildTagMapOf(item) {
  return buildTagsOf(item).reduce((acc, t) => {
    acc[t.name] = t.id;
    return acc;
  }, /** @type {Record<string, string>} */({}));
}

/**
 * @param {number} geoTargetId
 * @param {string} languageCode
 * @param {any} item - the upstream prompt item.
 */
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
    tags: buildTagsOf(item),
    tagMap: buildTagMapOf(item),
  };
}

/**
 * GET /serenity/prompts?geoTargetId=&languageCode=&page=&limit=&search=&tagIds= —
 * list prompts for one slice. geoTargetId and languageCode are required.
 * Pagination is real upstream pagination — one slice = one project = one
 * upstream call set per page.
 *
 * tagIds (repeatable): Semrush tag UUIDs from `SerenityPrompt.tags[].id`. Passed
 * as tag_ids to the by_tags endpoint. Semrush applies OR semantics — prompts
 * carrying any of the supplied tag IDs are returned, and each id is expanded
 * downward through the tag hierarchy. AND semantics must be enforced by the
 * caller if needed.
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

  const projectId = row.getSemrushProjectId();
  // Each prompt's tags already carry their own parentage (see buildTagsOf), so
  // one upstream call answers the whole page — no tag-tree walk to join against.
  const resp = await transport.listPromptsByTags(
    semrushWorkspaceId,
    projectId,
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

/**
 * Publishes every affected project, collecting (not throwing) per-project failures. Shared by flat
 * and subworkspace callers.
 * @param {object} transport
 * @param {string} semrushWorkspaceId
 * @param {string[]} projectIds
 * @param {object} log
 * @param {(fn: () => Promise<any>) => Promise<any>} [wrapPublish] - wraps each project's
 *   `publishProject` call (default identity — a plain call, byte-for-byte the pre-existing
 *   behavior). The subworkspace create-prompts caller passes `headroom.retryOnQuota` (LLMO-6190
 *   item 4) so a disguised metered-405 gets ONE bounded top-up+retry per project BEFORE it is
 *   recorded as a failure; flat-mode callers omit this param, so flat mode is untouched.
 * @returns {Promise<Array<{ projectId: string, message: string }>>}
 */
export async function publishAffected(
  transport,
  semrushWorkspaceId,
  projectIds,
  log,
  wrapPublish = (fn) => fn(),
) {
  const unique = Array.from(new Set(projectIds.filter(Boolean)));
  const errors = [];
  await Promise.all(unique.map(async (pid) => {
    try {
      // wrapPublish is nested INSIDE this per-project try so each project's publish (and its
      // bounded retry, when wired) fails independently — a surviving 405 after the retry still
      // lands in `errors` for this pid rather than aborting the whole Promise.all fan-out.
      await wrapPublish(() => transport.publishProject(semrushWorkspaceId, pid));
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
 * Normalizes one bulk-create/update prompt input. Tags are addressed by
 * UPSTREAM ID (`tagIds`), never by name: the name-keyed upstream write
 * (`aio/prompts/tagged`) can only ever reach ROOT tags — its request shape has
 * no field for a parent, so a name absent from the root level mints a NEW ROOT.
 * Under the dimension-root model every tag value is a descendant of a dimension
 * root, so a name cannot identify one. `tagIds` is therefore required and must
 * resolve to a non-empty array; a `tags` key is rejected outright rather than
 * silently ignored, so a stale caller fails loudly instead of writing
 * phantom root tags.
 *
 * Returns the rejection REASON alongside the value. The three ways an input can
 * be refused are not interchangeable, and a caller told its `geoTargetId` was
 * missing when it actually sent a retired `tags` key has been misinformed, not
 * informed.
 *
 * @param {object} input - one raw row of the bulk-create request.
 * @returns {{ value: { text: string, languageCode: string, geoTargetId: number,
 *   tagIds: string[] } | null, reason: string | null }}
 */
export function normalizePromptInput(input) {
  const text = String(input?.text || '').trim();
  const languageCode = normalizeLanguageCode(input?.languageCode);
  const geoTargetId = normalizeGeoTargetId(Number(input?.geoTargetId));
  if (!text || languageCode === null || geoTargetId === null) {
    return { value: null, reason: 'text, languageCode, and geoTargetId are required' };
  }
  if (input?.tags !== undefined) {
    return {
      value: null,
      reason: 'tags is retired: address tags by upstream id via tagIds',
    };
  }
  const tagIds = sanitizeTagIds(input?.tagIds);
  if (tagIds.length === 0) {
    return {
      value: null,
      reason: 'tagIds must be a non-empty array of upstream tag ids',
    };
  }
  return {
    value: {
      text, languageCode, geoTargetId, tagIds,
    },
    reason: null,
  };
}

/**
 * Creates ONE prompt through the id-based upstream write (`POST aio/prompts`).
 * Called per item by {@link handleCreatePrompts}'s bulk fan-out (and its
 * subworkspace twin), so the upstream shape lives in one place.
 *
 * The write is ATOMIC on an unresolvable tag id — live 500s and creates nothing
 * — so every id must already be a known-good upstream tag id, resolved by the
 * caller and never guessed.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {{ text: string, tagIds: string[] }} input
 * @returns {Promise<string>} the new upstream prompt id, or '' if the
 *   response carried none.
 */
export async function createOnePrompt(transport, semrushWorkspaceId, projectId, input) {
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

/**
 * Builds the per-request `type` + `origin` injector — the UNIFIED
 * classification layer (serenity-docs#31, extended by the-origin-dimension
 * spec for `origin`). Given a pure `classifyPromptType(text, geoTargetId)`
 * closure (built by the controller from the brand name + region-clamped
 * aliases) that yields a BARE `type` value (`branded` / `non-branded`), it
 * returns `injectComputedType(projectId, input, options)` which, for BOTH
 * dimensions:
 *   - STRIPS every caller-supplied tag id that lives under the dimension's root
 *     (the client may never set either value directly), and
 *   - APPENDS a resolved upstream tag id in its place. The atomic
 *     `createPromptsByIds` 500s on an unresolved id, so ids are resolved
 *     BEFORE the write.
 * The returned input carries the rewritten `tagIds`, so the caller's response
 * echo reflects the computed values without a refetch (decision 5).
 *
 * The strip set for each dimension is every id under that dimension's root,
 * not a name prefix: a tag's dimension is its root, and a sub-category could
 * legitimately be named `branded` or `ai` without being a `type`/`origin` value.
 *
 * `type` is always freshly classified from the write's own text. `origin` is
 * asymmetric between create and update (`options.mode`, default `'create'`):
 *   - `'create'`: derives to {@link ORIGIN_VALUE.AI} — every prompt this layer
 *     creates is AI-generated.
 *   - `'update'`: re-injects whichever `origin` tag id is ALREADY in
 *     `input.tagIds` (the client round-trips the tags it read off the prior
 *     list call), rather than deriving a new one from anything in the update
 *     request. This is deliberate: `origin` records who authored the prompt
 *     ORIGINALLY, which an edit does not change. If none is found (a prompt
 *     tagged before this dimension existed), it falls back to `AI` rather than
 *     leave the prompt untagged — a strip-without-inject would make it invisible
 *     to origin-based filtering.
 *
 * Resolution (two tag-tree reads per distinct value per project — the root
 * level plus that dimension root's children) is memoized for the request per
 * dimension, so a bulk create fans out over the distinct computed values
 * rather than over the items. A non-function `classifyPromptType` (defensive)
 * skips the `type` step; `origin` is always injected.
 *
 * Both resolvers resolve or throw, so the computed tags are always attached.
 * They must never be dropped: neither dimension is client-settable, so a
 * prompt written without one stays unclassified forever, and the caller sees a
 * 2xx. Failing the write instead is free — the upstream bulk create is atomic
 * and has not run yet.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {((text: string, geoTargetId: number) => string) | undefined} classifyPromptType
 * @param {object} [log]
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tagIds: string[] }, options?: { mode?: 'create' | 'update' }) =>
 *   Promise<{ text: string, geoTargetId: number, tagIds: string[] }>}
 */
export function makeTypeInjector(transport, semrushWorkspaceId, classifyPromptType, log) {
  /** @type {Map<string, Promise<{ computedId: string, typeTagIds: string[] }>>} */
  const typeCache = new Map();
  /** @type {Map<string, Promise<{ computedId: string, originTagIds: string[] }>>} */
  const originCache = new Map();

  return async function injectComputedType(projectId, input, { mode = 'create' } = {}) {
    let out = input;

    if (typeof classifyPromptType === 'function') {
      const typeValue = classifyPromptType(input.text, input.geoTargetId);
      const typeKey = `${projectId} ${typeValue}`;
      let typePending = typeCache.get(typeKey);
      if (!typePending) {
        typePending = resolveTypeValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          typeValue,
          log,
        );
        typeCache.set(typeKey, typePending);
      }
      const { computedId, typeTagIds } = await typePending;
      const stripped = out.tagIds.filter((id) => !typeTagIds.includes(id));
      out = { ...out, tagIds: [...stripped, computedId] };
    }

    // `origin` resolution is the same tree lookup on both create and update —
    // every id under the root, plus the resolved `AI` id — only what CREATE
    // does with it differs from what UPDATE does.
    const originKey = `${projectId} ${ORIGIN_VALUE.AI}`;
    let originPending = originCache.get(originKey);
    if (!originPending) {
      originPending = resolveOriginValueInjection(
        transport,
        semrushWorkspaceId,
        projectId,
        ORIGIN_VALUE.AI,
        log,
      );
      originCache.set(originKey, originPending);
    }
    const { computedId: aiId, originTagIds } = await originPending;
    const stripped = out.tagIds.filter((id) => !originTagIds.includes(id));

    // UPDATE re-injects whichever origin tag the caller already carried — it
    // never derives a new one. CREATE always derives to AI. Falling back to AI
    // when update finds none avoids a strip-without-inject (which would make
    // the prompt invisible to origin-based filtering) for a prompt tagged
    // before this dimension existed.
    const nextOriginId = mode === 'update'
      ? (out.tagIds.find((id) => originTagIds.includes(id)) ?? aiId)
      : aiId;
    out = { ...out, tagIds: [...stripped, nextOriginId] };

    return out;
  };
}

/**
 * Validates + normalizes a PATCH prompt body's `text` + `tagIds`, shared by
 * {@link handleUpdatePrompt} and its subworkspace twin. Tags are addressed by
 * upstream id only, mirroring {@link normalizePromptInput} — a name cannot
 * identify a nested tag. Returns either `{ ok: true, text, tagIds }` or
 * `{ ok: false, status, body }` (the caller returns the latter directly as the
 * handler's 400 response).
 *
 * @param {object} body - the PATCH request body.
 * @returns {{ ok: true, text: string, tagIds: string[] }
 *   | { ok: false, status: number, body: object }}
 */
export function parseUpdatePromptBody(body) {
  // Before the missing-field check: a caller still sending the retired `tags` key
  // has no `tagIds`, so testing for the absent field first would answer
  // `missingFields` and never name the key that is actually wrong. Same ordering,
  // and same reason, as {@link normalizePromptInput}.
  if (body?.tags !== undefined) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalidRequest',
        message: 'tags is not supported; address tags by upstream id via tagIds',
      },
    };
  }
  if (!body || body.text === undefined || body.tagIds === undefined) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'missingFields',
        message: 'PATCH body must include text and tagIds',
      },
    };
  }
  const text = String(body.text);
  const tagIds = sanitizeTagIds(body.tagIds);
  if (tagIds.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalidRequest', message: 'tagIds must be a non-empty array' },
    };
  }
  return { ok: true, text, tagIds };
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
 * upstream project; publish runs once per affected project at the end.
 */
export async function handleCreatePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  classifyPromptType,
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

  const results = await mapLimit(inputs, BULK_CREATE_CONCURRENCY, async (raw) => {
    const { value: input, reason } = normalizePromptInput(raw);
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: /** @type {string} */ (reason),
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
      // Unified layer: strip any caller-supplied type + inject the computed one.
      const typed = await injectComputedType(projectId, input);
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
          tagIds: typed.tagIds,
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

  return { created, skipped, failed };
}

/**
 * PATCH /serenity/prompts/:semrushPromptId — in-place edit.
 *
 * Body carries `{geoTargetId, languageCode, text, tagIds}` (id-based; a
 * `tags` key is rejected -- see {@link parseUpdatePromptBody}). All are
 * required — the payload is the full next state. Clients always have the
 * existing text/tagIds available locally (they were returned by the preceding
 * list call that rendered the edit form), so requiring both keeps the server
 * side a single straight line and removes the per-request pagination that
 * "preserve-on-omit" semantics would force.
 *
 * The edit is IN PLACE (serenity-docs#63): `rename` writes the text and the
 * batch tag-reference write replaces the tag set, both preserving the prompt
 * id — the response echoes the UNCHANGED semrushPromptId, and everything keyed
 * to that id survives the edit. Nothing is deleted on this path, so there is
 * no data-loss window. Both writes run unconditionally: upstream has no
 * GET-by-id, so the handler cannot know what changed — and does not need to
 * (an unchanged-text rename is a documented `is_updated: false` no-op, and the
 * replace-mode tag write is idempotent). Rename runs FIRST because it is the
 * one operation that can refuse (409): a collision aborts the edit before any
 * mutation. A tag-write failure after a successful rename leaves a
 * half-applied edit (text updated, tags not) — retryable, nothing lost.
 *
 * Contract:
 *   - body missing text or tagIds, or carrying the retired `tags` key
 *     → 400 (missingFields / invalidRequest).
 *   - slice missing on the brand → 404 (marketNotFound).
 *   - upstream rename returns 404 → 404 (promptNotFound).
 *   - upstream rename returns 409 — the new text collides with a SIBLING
 *     prompt's — → throw; the controller's mapError answers 409 `conflict`
 *     with a redacted message. Nothing has mutated upstream.
 *   - any other upstream error → throw (controller 502 mapping).
 *
 * After the writes the per-project tag cache is invalidated on this container
 * (a PATCH can introduce a new tag or drop the last carrier of an old tag),
 * then `publishProject` is fired — edits land in the draft layer, publish
 * moves them live (same publish contract as the create path).
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
) {
  // `semrushPromptId` is validated as non-empty at the controller boundary
  // (serenity.js:259) before this handler is invoked over HTTP, so no
  // re-check here.
  const parsedBody = parseUpdatePromptBody(body);
  if (!parsedBody.ok) {
    return { status: parsedBody.status, body: parsedBody.body };
  }
  const { text: nextText, tagIds: nextTagIds } = parsedBody;
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

  // Recompute the type tag from the NEW text BEFORE any upstream write: the
  // unified layer (tree read / on-demand tag create) resolves the computed
  // value's id first, so a classification failure aborts cleanly with the
  // prompt completely untouched.
  const injectComputedType = makeTypeInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
  );
  const typed = await injectComputedType(projectId, {
    text: nextText, geoTargetId, tagIds: nextTagIds,
  }, { mode: 'update' });

  try {
    await transport.renamePrompt(semrushWorkspaceId, projectId, semrushPromptId, nextText);
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
    // A 409 (the new text collides with a sibling prompt's) and every other
    // upstream error propagate to the controller's mapError; nothing has
    // mutated upstream — the tag write below has not run.
    throw e;
  }

  // Full replace with the injector's output: the caller's tagIds minus any
  // caller-supplied type value, plus the server-computed one. An unknown
  // prompt id would be skipped silently (204) — the rename above has already
  // established existence.
  try {
    await transport.updatePromptTagsByIds(semrushWorkspaceId, projectId, [
      { id: semrushPromptId, references: typed.tagIds, replace: true },
    ]);
  } catch (e) {
    // The rename above already landed: the prompt's text has moved while its
    // tags are stale. Record the partial mutation before propagating, so the
    // generic upstream error the caller sees is attributable on-call.
    log?.warn?.('updatePromptTagsByIds failed after a successful rename — text updated, tags stale', {
      semrushPromptId, projectId, error: e.message,
    });
    throw e;
  }

  invalidateTagCacheForProject(semrushWorkspaceId, projectId);

  await publishAffected(transport, semrushWorkspaceId, [projectId], log);

  return {
    status: 200,
    body: {
      semrushPromptId,
      geoTargetId,
      languageCode,
      text: nextText,
      tagIds: typed.tagIds,
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
