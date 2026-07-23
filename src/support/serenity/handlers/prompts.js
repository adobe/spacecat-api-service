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
import { resolveTypeValueInjection, resolveIntentValueInjection, resolveClosedValueInjection } from '../tag-tree.js';
import { DIMENSION, ORIGIN_VALUE, INTENT_VALUE } from '../prompt-tags.js';
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
 * This cap bounds the CALLER-supplied tags only. The server-derived dimension
 * tags (`type`, `origin`) are injected downstream by {@link makePromptTagInjector}
 * AFTER this sanitize, and are intentionally EXEMPT from the user-facing cap — a
 * write may therefore carry up to `MAX_TAG_IDS` + 2 ids. They must never be
 * dropped to fit the cap: a prompt missing its `type`/`origin` tag is invisible
 * to that dimension's filter.
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
 * Builds the per-request prompt-tag injector — the UNIFIED server-owned-dimension
 * layer (serenity-docs#31 for `type`; origin-dimension.md §3 for `origin`). It
 * stamps the two dimensions a client may never set on a prompt: `type` (branded /
 * non-branded, classified from the text) and `origin` (who authored the prompt).
 *
 * `injectComputedTags(projectId, input)` STRIPS every caller-supplied tag id that
 * lives under a server-owned dimension's root and APPENDS the pre-resolved
 * upstream id of the server value. The strip is BY RESOLVED ROOT ID, never by
 * name: a tag's dimension is its root ancestor, so a customer category
 * legitimately named `branded` or `ai` is not under a server root and is left
 * alone (origin-dimension.md §3, gate 8). The rewritten `tagIds` are returned so
 * the caller's response echo needs no refetch (decision 5).
 *
 * **`type`** — resolved from `classifyPromptType(text, geoTargetId)` on every
 * write (create AND update): it is a classification of the prompt text, so it is
 * always safe to recompute. A non-function `classifyPromptType` (defensive) skips
 * the `type` step.
 *
 * **`origin`** — carries the CREATE/UPDATE ASYMMETRY (origin-dimension.md §3
 * item 3). It is a fact about the row's CREATION, never a classification, so:
 *   - on CREATE (`originValue` set, e.g. `human` for a user-authenticated write),
 *     any caller-supplied origin id is stripped and the derived value injected;
 *   - on UPDATE (`originValue` unset) the injector leaves origin ALONE. The stored
 *     value the caller echoes back rides through the full-replace tag write
 *     unchanged. Re-deriving would relabel every edited `ai` prompt `human`;
 *     stripping without injecting would leave the prompt invisible to the
 *     dimension's filter — both are illegal, so the update path does neither.
 *
 * Resolution ({@link resolveTypeValueInjection} / {@link resolveClosedValueInjection},
 * two tag-tree reads per distinct value per project — the root level plus the
 * root's children) is memoized for the request, so a bulk create fans out over
 * the distinct computed values rather than over the items. The origin value is
 * constant per request, so its resolution is memoized per project.
 *
 * Resolution resolves or throws, so a server tag is always attached; it is never
 * dropped, and a resolution failure aborts the write (which is free — the upstream
 * bulk create is atomic and has not run yet) rather than writing an unclassified
 * or unattributed prompt behind a 2xx.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {((text: string, geoTargetId: number) => string) | undefined} classifyPromptType
 * @param {object} [log]
 * @param {{ originValue?: string }} [options] - `originValue` is the derived
 *   `origin` to inject on CREATE; omit it on UPDATE so origin is left untouched.
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tagIds: string[] }) =>
 *   Promise<{ text: string, geoTargetId: number, tagIds: string[] }>}
 */
export function makePromptTagInjector(
  transport,
  semrushWorkspaceId,
  classifyPromptType,
  log,
  options = {},
) {
  const { originValue } = options;
  /** @type {Map<string, Promise<{ computedId: string, typeTagIds: string[] }>>} */
  const typeCache = new Map();
  /** @type {Map<string, Promise<{ computedId: string, valueTagIds: string[] }>>} */
  const originCache = new Map();
  return async function injectComputedTags(projectId, input) {
    let { tagIds } = input;

    // type — every write (safe to recompute from the text).
    if (typeof classifyPromptType === 'function') {
      const typeValue = classifyPromptType(input.text, input.geoTargetId);
      const key = `${projectId} ${typeValue}`;
      let pending = typeCache.get(key);
      if (!pending) {
        pending = resolveTypeValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          typeValue,
          log,
        );
        typeCache.set(key, pending);
      }
      const { computedId, typeTagIds } = await pending;
      tagIds = [...tagIds.filter((id) => !typeTagIds.includes(id)), computedId];
    }

    // origin — CREATE only. `originValue` unset means UPDATE: leave origin alone
    // (the stored value the caller echoes rides through the replace-mode write).
    if (originValue) {
      let pending = originCache.get(projectId);
      if (!pending) {
        pending = resolveClosedValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          DIMENSION.ORIGIN,
          originValue,
          log,
        );
        originCache.set(projectId, pending);
      }
      const { computedId, valueTagIds } = await pending;
      tagIds = [...tagIds.filter((id) => !valueTagIds.includes(id)), computedId];
    }

    return { ...input, tagIds };
  };
}

/**
 * Applies a pre-computed, per-request `intent` classification map to a prompt
 * write (serenity-docs#32) — the structural analog of {@link makePromptTagInjector}
 * for the `intent` closed dimension. Unlike `type`, the "compute the value" step
 * is a `Map` lookup, not a per-item classify call: intent is batch-classified
 * ONCE per request (see `classifyPromptIntents` in `../intent-classification.js`)
 * because it is an LLM call, not a cheap pure function. A text missing from
 * `intentByText` (e.g. beyond the AI-gen classify cap) falls back to
 * `INTENT_VALUE.INFORMATIONAL`, the seeded standard value.
 *
 * Given the map, it returns `injectComputedIntent(projectId, input)` which:
 *   - STRIPS every caller-supplied tag id under the `intent` root (the client may
 *     never set the value), and
 *   - APPENDS the pre-resolved upstream id of the server-computed value. The
 *     atomic `createPromptsByIds` 500s on an unresolved id, so it is resolved
 *     BEFORE the write.
 *
 * Id-based resolution ({@link resolveIntentValueInjection}, two tag-tree reads
 * per distinct `intent` value per project) is memoized for the request, mirroring
 * {@link makePromptTagInjector}'s memoization. `resolveIntentValueInjection` resolves
 * or throws, so the computed tag is always attached and never silently dropped.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {Map<string, string>} intentByText - text -> bare `intent` value.
 * @param {object} [log]
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tagIds: string[] }) =>
 *   Promise<{ text: string, geoTargetId: number, tagIds: string[] }>}
 */
export function makeIntentInjector(transport, semrushWorkspaceId, intentByText, log) {
  /** @type {Map<string, Promise<{ computedId: string, intentTagIds: string[] }>>} */
  const cache = new Map();
  return async function injectComputedIntent(projectId, input) {
    const intentValue = intentByText.get(input.text) ?? INTENT_VALUE.INFORMATIONAL;
    const key = `${projectId} ${intentValue}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveIntentValueInjection(
        transport,
        semrushWorkspaceId,
        projectId,
        intentValue,
        log,
      );
      cache.set(key, pending);
    }
    const { computedId, intentTagIds } = await pending;
    const stripped = input.tagIds.filter((id) => !intentTagIds.includes(id));
    return { ...input, tagIds: [...stripped, computedId] };
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
  // Mirror the create contract (`normalizePromptInput`): empty or whitespace-only
  // text is rejected here rather than passed on to `renamePrompt`, where it would
  // be classified and written as a blank prompt. `|| ''` also coerces a falsy
  // non-string (`null`, `0`, `false`) to empty, matching create exactly.
  const text = String(body.text || '').trim();
  if (!text) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalidRequest', message: 'text must be a non-empty string' },
    };
  }
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
 * Each input must carry `(geoTargetId, languageCode, text, tagIds)`. Inputs
 * are grouped by slice; the matching BrandSemrushProject row resolves the
 * upstream project; publish runs once per affected project at the end.
 *
 * Two independent switches suppress that end-of-call publish:
 *   - `body.deferPublish` (serenity-docs#32 CSV-chunking): a draft-only write;
 *     the caller triggers publish itself (e.g. a normal, non-deferred call on the
 *     last chunk of an import, which publishes every project touched across the
 *     whole import since a single CSV import always targets one project).
 *   - the `publish` option (default true — the standalone-endpoint contract):
 *     set it false when the caller batches its own publish afterwards
 *     (LLMO-5492 publish-after-populate: finalize pushes prompts + models and
 *     publishes each project once) — an intermediate publish would either go
 *     live half-populated or, on a model-less draft, throw.
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
  { publish = true } = {},
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

  // CREATE: user-authenticated write → derived `origin` is `human`
  // (origin-dimension.md §3). Any caller-supplied origin tag id is stripped and
  // this value injected; on the twin AI-generation path a service producer stamps
  // `ai` via STANDARD_PROMPT_TAG_VALUES instead (that path does not run here).
  const injectComputedTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
    { originValue: ORIGIN_VALUE.HUMAN },
  );
  // Unified layer (serenity-docs#32): batch-classify every distinct text ONCE
  // under the shared request deadline, then thread the resolved map into each
  // per-item injection below (a per-item LLM call would be far too slow).
  // Classify the TRIMMED text: `makeIntentInjector` looks up the map by
  // `input.text`, which `normalizePromptInput` has already trimmed, so the
  // classify key must be trimmed to match — otherwise a whitespace-padded prompt
  // (common in CSV import) misses the map and silently defaults to Informational
  // despite a real classification.
  const intentByText = await classifyPromptIntents(
    inputs.map((raw) => String(raw?.text || '').trim()),
    {
      env,
      log,
      deadline: writeDeadline,
      writePath: deferPublish ? 'csv' : 'create',
      workspaceId: semrushWorkspaceId,
    },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);

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
      // Unified layer: strip caller-supplied type/origin/intent, then inject the
      // computed type + derived origin (origin-dimension.md §3) and the
      // classified intent (serenity-docs#32). The two injectors act on disjoint
      // dimensions, so chaining composes cleanly.
      let typed = await injectComputedTags(projectId, input);
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

  // body.deferPublish (CSV-chunking) — draft-only write, publish deferred to a
  // later non-deferred call; return early flagged not-published.
  if (deferPublish) {
    log?.info?.('serenity create-prompts: deferPublish set — prompts written as draft, publish skipped', {
      brandId, created: created.length, skipped: skipped.length, failed: failed.length,
    });
    return {
      created, skipped, failed, published: false,
    };
  }

  // publish:false — the caller (finalize) batches a single publish after models
  // are also set, so skip the per-create publish here.
  if (publish) {
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
  }

  return {
    created, skipped, failed, published: true,
  };
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

  // Recompute the type AND intent tags from the NEW text BEFORE the rename: the
  // unified layer (tree read / on-demand tag create / LLM classify) must run
  // before any upstream write, so a classification failure aborts cleanly with
  // the old prompt still present (serenity-docs#31, #32). NO `originValue` is
  // passed: `origin` is a fact about the row's creation, never re-derived on
  // edit (origin-dimension.md §3 item 3) — the prompt's stored origin id, echoed
  // back by the caller, rides through the replace-mode tag write untouched.
  //
  // This runs UNCONDITIONALLY, even when the PATCH does not change the text. The
  // upstream provider has no GET-by-id and the handler is not sent the old text
  // (the body is the full next state — see the docblock above), so it cannot
  // know whether the text actually changed. `renamePrompt`'s `is_updated: false`
  // reports a no-op only AFTER the rename, too late to gate a classify that has
  // to run first for failure-safety. Skipping the reclassification would require
  // the client to send the old text — a contract change deliberately out of
  // scope here (keep the edit path a single straight line).
  const injectComputedTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
  );
  const intentByText = await classifyPromptIntents(
    [nextText],
    {
      env, log, deadline: writeDeadline, writePath: 'edit', workspaceId: semrushWorkspaceId,
    },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);
  let typed = await injectComputedTags(projectId, {
    text: nextText, geoTargetId, tagIds: nextTagIds,
  });
  typed = await injectComputedIntent(projectId, typed);

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
