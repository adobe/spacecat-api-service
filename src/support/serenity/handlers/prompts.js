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

import { ErrorWithStatusCode, resolveCallerImsUserId } from '../../utils.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { ERROR_CODES, isMeteredQuota, isUpstreamGone } from '../errors.js';
import { alertQuotaRejection, alertRollbackFailure } from '../quota-alerts.js';
import {
  normalizeGeoTargetId, normalizeLanguageCode, isValidTagIdFormat, hasDisallowedControlChars,
} from '../validation.js';
import {
  invalidateTagCacheForProject,
  MAX_PROMPT_TAG_IDS,
  MAX_TAG_FILTER_VALUES,
} from './markets.js';
import {
  resolveTypeValueInjection,
  resolveIntentValueInjection,
  resolveServerOwnedValueInjection,
  readTagTreeSnapshot,
} from '../tag-tree.js';
import {
  DIMENSION, ORIGIN_VALUE, INTENT_VALUE, PROXY_CREATE_SOURCE_VALUE,
  canonicalizeSource, SOURCE_VALUES, dimensionOfRootName,
} from '../prompt-tags.js';
import { classifyPromptIntents } from '../intent-classification.js';
import { classifyTagCompatibility } from '../tag-compatibility.js';
import { logPromptDeleteEvent } from '../prompt-delete-log.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */
/** @typedef {Awaited<ReturnType<typeof readTagTreeSnapshot>>['items'][number]} TagTreeItem */
/**
 * @typedef {NonNullable<Awaited<
 *   ReturnType<SerenityTransport['listPromptsByTags']>
 * >['items']>[number]} SerenityPrompt
 */

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
export const MAX_TAG_IDS = MAX_PROMPT_TAG_IDS;
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

// PLACEHOLDER (LLMO-7533 / serenity-docs#472 §6): the real Semrush prompt-text
// length contract is NOT YET CONFIRMED — do not reuse the unrelated
// 2,000-character limit from another endpoint, and do not tighten this without
// a verified answer from the Project Engine owner or a live probe (both
// attempted for this ticket; the live probe couldn't reach Semrush's dev
// gateway from outside its VPC — see the LLMO-7533 follow-up ticket). Deliberately
// generous so this never falsely rejects real customer content before the real
// limit is known — it only guards against pathological/runaway input.
export const MAX_PROMPT_TEXT_LENGTH = 10_000;

/**
 * @typedef {{
 *   tagIds?: string[],
 *   search?: string,
 *   sort?: string,
 *   order?: string,
 * }} PromptListOptions
 */

/** @typedef {typeof ERROR_CODES[keyof typeof ERROR_CODES]} TagValidationErrorCode */

// Server-owned prompt-authorship metadata (LLMO-6289, serenity-docs prompt-
// authorship-metadata spec). The four keys stamped on Semrush's Adobe-owned
// `metadata` JSONB column. Values are opaque caller ids (resolved by
// resolveCallerId, capped at 100 chars — the upstream CHECK bound) and RFC 3339
// UTC timestamps.
//
// SORT allow-list: the only two fields the with-metadata list read may sort on.
// A `sort` outside this set is a 400 — the value is forwarded verbatim upstream,
// so the allow-list is the injection guard, not merely input hygiene.
export const SORTABLE_METADATA_FIELDS = ['metadata.created_at', 'metadata.updated_at'];
export const SORT_ORDERS = ['asc', 'desc'];
// created_by / updated_by carry a CHECK(length <= 100) upstream; a longer value
// is a 400 (and rolls a batch back). resolveCallerId is the SINGLE resolution
// point and caps here so no write path can exceed it.
export const CALLER_ID_MAX_LENGTH = 100;

/**
 * Resolves the opaque caller id to stamp on a write, from the request's auth
 * profile. CORRECTNESS-CRITICAL: authorship is the CALLER's identity, resolved
 * from `authInfo.getProfile()` — NEVER from the bearer forwarded upstream, whose
 * principal can differ from the caller after the promise-token exchange.
 *
 * The id itself comes from {@link resolveCallerImsUserId} — shared with the
 * `/organizations/{id}/userDetails` read path, so the id stamped here is the id
 * that path can resolve back to a name. A missing/blank identity becomes the
 * literal `unknown` (the spec's NULL-author sentinel, resolved to a display name
 * downstream). Capped at
 * {@link CALLER_ID_MAX_LENGTH} so a pathological claim can never trip the
 * upstream length CHECK (which would 400 the write / roll a batch back).
 *
 * POLICY (LLMO-6289 — intentional, not an oversight): an `unknown`-attributed
 * write is ACCEPTED, never rejected. Authorship metadata is best-effort
 * provenance, not an authorization gate — the caller is already authenticated
 * upstream, so a resolvable identity is preferred but its absence must not block
 * an otherwise-legitimate write. If a future requirement needs `unknown`-authored
 * writes rejected, that is a deliberate contract change to make HERE (reject at
 * this boundary), not a silent behavior to assume.
 *
 * @param {object} ctx - the controller request context.
 * @returns {string} the caller id, `unknown` when unresolved, ≤100 chars.
 */
export function resolveCallerId(ctx) {
  const id = resolveCallerImsUserId(ctx) ?? 'unknown';
  return id.slice(0, CALLER_ID_MAX_LENGTH);
}

/**
 * Builds the `metadata` merge-patch payload for a CREATE: all four keys, with
 * `created_*` and `updated_*` set to the SAME instant/caller (a create is its
 * own first edit). Timestamps are RFC 3339 UTC (`new Date().toISOString()`).
 *
 * ONE stamping helper, shared by BOTH prompt twins (flat + subworkspace) and the
 * AI-generation create — the metadata logic is never written twice.
 *
 * @param {string} callerId - already resolved + capped by {@link resolveCallerId}.
 */
export function buildCreateMetadata(callerId) {
  const now = new Date().toISOString();
  // Defensive floor mirroring resolveCallerId's `unknown` sentinel: every
  // production path already passes a resolved+capped id, but a future direct
  // caller that skips resolveCallerId must never stamp `created_by: undefined`
  // (which the upstream metadata column would reject / store as a null author).
  const id = callerId || 'unknown';
  return {
    created_at: now,
    created_by: id,
    updated_at: now,
    updated_by: id,
  };
}

/**
 * Builds the `metadata` merge-patch payload for an EDIT: ONLY the `updated_*`
 * pair (RFC 7396 merge semantics — absent keys are kept, so `created_*` survive
 * untouched with no read-before-write). Timestamp is RFC 3339 UTC.
 *
 * @param {string} callerId - already resolved + capped by {@link resolveCallerId}.
 */
export function buildUpdateMetadata(callerId) {
  // Same defensive floor as buildCreateMetadata: never stamp `updated_by:
  // undefined` if a future caller reaches here without resolveCallerId.
  return {
    updated_at: new Date().toISOString(),
    updated_by: callerId || 'unknown',
  };
}

/**
 * Validates + normalizes the `sort` / `order` list query params against the
 * {@link SORTABLE_METADATA_FIELDS} allow-list. Returns `{}` when neither is
 * supplied (the legacy unsorted read); `{ sort, order }` when a valid sort is
 * requested (order defaults to `desc` — newest first for "Last modified");
 * throws 400 for an unknown sort field or order.
 *
 * @param {object} query
 * @returns {{ sort?: string, order?: string }}
 */
export function resolveSort(query) {
  const sort = query?.sort;
  const order = query?.order;
  if (sort === undefined || sort === null || sort === '') {
    return {};
  }
  if (!SORTABLE_METADATA_FIELDS.includes(sort)) {
    throw new ErrorWithStatusCode(
      `sort must be one of: ${SORTABLE_METADATA_FIELDS.join(', ')}`,
      400,
    );
  }
  const normalizedOrder = order === undefined || order === null || order === ''
    ? 'desc'
    : String(order).toLowerCase();
  if (!SORT_ORDERS.includes(normalizedOrder)) {
    throw new ErrorWithStatusCode('order must be one of: asc, desc', 400);
  }
  return { sort, order: normalizedOrder };
}

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
 * Whether a bulk-create request opts into the ASYNC job runner (serenity-docs#33).
 *
 * This is a DEDICATED trigger, deliberately separate from `deferPublish`. The
 * two are unrelated concerns and must not be conflated: `deferPublish` is a
 * publish-batching hint on the synchronous path (defer the upstream publish
 * until the last chunk), whereas `async` routes the whole write off the request
 * path onto the SQS worker and returns 202 + a job id to poll. Overloading
 * `deferPublish` for both meant the sync CSV-chunking client (which sets
 * `deferPublish: true` on every non-final chunk) silently got 202s it did not
 * expect. Keying async off its own explicit flag lets that client keep working
 * synchronously untouched, and makes async strictly opt-in.
 *
 * Present-but-non-boolean is a hard 400 (mirrors validateDeferPublish); absent,
 * `false`, or `true` are all accepted.
 *
 * @param {object} body - request body.
 * @returns {boolean} true when `async === true`.
 */
export function validateAsync(body) {
  const asyncFlag = body?.async;
  if (asyncFlag !== undefined && typeof asyncFlag !== 'boolean') {
    throw new ErrorWithStatusCode('async must be a boolean', 400);
  }
  return asyncFlag === true;
}

/**
 * Builds the prompt's tag list from the upstream item: one entry per tag,
 * carrying its id, bare name, parent id and root-first ancestry breadcrumb.
 *
 * This is the canonical DTO shape. Tag names are NOT unique — upstream scopes
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
 * with no `path` is a root, and its own name names its dimension.
 *
 * Names are passed through as upstream holds them, root breadcrumb included, so
 * a root's name is not always the bare dimension key: the intent root is named
 * `$abv_tags$intent`. Folding it to the dimension key here would put a name in
 * `path[]` beside an id that upstream does not hold under it, so this stays a
 * faithful mirror. A consumer keying on the intent dimension matches
 * `$abv_tags$intent`; use `dimensionOfRootName` rather than comparing by hand.
 *
 * String-form tags (a defensive upstream fallback) carry a name but no id, and
 * are surfaced with an empty id rather than dropped. Compatibility is
 * authoritative only when `compatibilityById` came from a complete taxonomy;
 * otherwise locally valid tags are marked `unverified`.
 *
 * @param {any} item - the upstream prompt item.
 * @param {Map<string, {
 *   state: 'canonical' | 'readOnly',
 *   reason: string | null,
 * }>} [compatibilityById]
 * @returns {Array<{ id: string, name: string, parentId: string | null,
 *   path: Array<{ id: string, name: string }> | null,
 *   compatibility: { state: string, reason: string | null } }>}
 */
function buildTagsOf(item, compatibilityById) {
  if (!Array.isArray(item?.tags)) {
    return [];
  }
  const tags = item.tags.reduce((acc, t) => {
    if (typeof t === 'string' && t) {
      acc.push({
        id: '',
        name: t,
        parentId: null,
        path: null,
        compatibility: { state: 'canonical', reason: null },
      });
    } else if (typeof t === 'object' && t?.name) {
      const path = Array.isArray(t.path)
        ? t.path.map((p) => ({
          id: typeof p?.id === 'string' ? p.id : '',
          name: typeof p?.name === 'string' ? p.name : '',
        }))
        : null;
      const names = [...(path ?? []).map((part) => part.name), String(t.name)];
      const rootName = path?.[0]?.name ?? String(t.name);
      let reason = null;
      if (rootName.toLowerCase() === DIMENSION.TAG && rootName !== DIMENSION.TAG) {
        reason = 'caseVariantRoot';
      } else if (names.some((name) => name.includes(':') || name.includes('__'))) {
        reason = 'separatorInName';
      } else if (rootName === DIMENSION.TAG && names.length > 3) {
        reason = 'unsupportedDepth';
      }
      acc.push({
        id: t.id ? String(t.id) : '',
        name: String(t.name),
        parentId: typeof t.parent_id === 'string' && t.parent_id ? t.parent_id : null,
        path,
        compatibility: compatibilityById?.get(String(t.id ?? ''))
          ?? { state: reason ? 'readOnly' : 'canonical', reason },
      });
    }
    return acc;
  }, []);
  return classifyTagCompatibility(tags).map((tag) => {
    const authoritative = compatibilityById?.get(tag.id);
    return {
      ...tag,
      compatibility: authoritative
        ?? (tag.compatibility.state === 'readOnly'
          ? tag.compatibility
          : { state: 'unverified', reason: 'taxonomyNotLoaded' }),
    };
  });
}

/**
 * @param {number} geoTargetId
 * @param {string} languageCode
 * @param {any} item - the upstream prompt item.
 * @param {Map<string, {
 *   state: 'canonical' | 'readOnly',
 *   reason: string | null,
 * }>} [compatibilityById] - authoritative compatibility from a complete
 *   project taxonomy. Without it, otherwise-canonical embedded tags are
 *   returned as `unverified`.
 * @returns {object | null}
 */
export function buildPromptDto(geoTargetId, languageCode, item, compatibilityById) {
  const text = item?.name || '';
  if (!text) {
    return null;
  }
  // Server-owned authorship metadata (LLMO-6289): the with-metadata list read
  // carries Semrush's Adobe-owned `metadata` column inline on each item. Map its
  // snake_case keys to the camelCase DTO fields; null when the item predates a
  // stamp (an un-backfilled prompt) so the shape is stable for the UI's em-dash.
  const metadata = item?.metadata;
  return {
    semrushPromptId: String(item?.id ?? ''),
    geoTargetId,
    languageCode,
    text,
    tags: buildTagsOf(item, compatibilityById),
    createdAt: metadata?.created_at ?? null,
    createdBy: metadata?.created_by ?? null,
    updatedAt: metadata?.updated_at ?? null,
    updatedBy: metadata?.updated_by ?? null,
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
 * @param {SerenityTransport} transport
 * @param {object} dataAccess
 * @param {string} brandId
 * @param {string} semrushWorkspaceId
 * @param {object} query
 * @param {object} [log]
 */
export async function handleListPrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
  log,
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
  // eslint-disable-next-line no-use-before-define
  const tagIds = validateTagIds(query?.tagIds, {
    maximum: query?.tagFilterMode === 'faceted-v1' ? MAX_TAG_FILTER_VALUES : MAX_TAG_IDS,
    tooLargeCode: query?.tagFilterMode === 'faceted-v1'
      ? ERROR_CODES.TAG_FILTER_TOO_LARGE
      : ERROR_CODES.INVALID_TAG_FILTER,
  });
  // sort/order (LLMO-6289): validated against the metadata allow-list and
  // forwarded upstream on the (now metadata-carrying) by_tags read. `{}` when
  // unspecified — byte-for-byte the legacy unsorted call.
  const { sort, order } = resolveSort(query);

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
  if (query?.tagFilterMode === 'faceted-v1') {
    // eslint-disable-next-line no-use-before-define
    return listFacetedPrompts(
      transport,
      semrushWorkspaceId,
      projectId,
      {
        geoTargetId,
        languageCode,
        page,
        limit,
        search,
        sort,
        order,
        tagIds,
      },
      log,
    );
  }
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
      // Omit sort/order keys when unsorted (lockstep with twin file prompts-subworkspace.js).
      ...(sort ? { sort, order } : {}),
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
      .map((item) => buildPromptDto(geoTargetId, languageCode, item, undefined))
      .filter(Boolean),
    total,
    page,
    limit,
  };
}

/**
 * @param {unknown} raw
 * @param {{
 *   maximum?: number,
 *   tooLargeCode?: TagValidationErrorCode,
 *   required?: boolean,
 * }} [options]
 * @returns {string[]}
 */
export function validateTagIds(raw, {
  maximum = MAX_PROMPT_TAG_IDS,
  tooLargeCode = ERROR_CODES.TAG_LIMIT_EXCEEDED,
  required = false,
} = {}) {
  if (!Array.isArray(raw)) {
    if (required) {
      throw new ErrorWithStatusCode('tagIds must be a non-empty array', 400);
    }
    return [];
  }
  if (raw.length > maximum) {
    const error = new ErrorWithStatusCode(
      `Tag selection exceeds the maximum of ${maximum}`,
      tooLargeCode === ERROR_CODES.TAG_LIMIT_EXCEEDED ? 409 : 400,
    );
    error.code = tooLargeCode;
    /** @type {any} */ (error).details = {
      attemptedCount: raw.length,
      ...(tooLargeCode === ERROR_CODES.TAG_LIMIT_EXCEEDED
        ? { maxPromptTagIds: maximum }
        : { maxTagFilterValues: maximum }),
    };
    throw error;
  }
  const values = raw.map((value) => String(value ?? '').trim());
  if (values.some((value) => !isValidTagIdFormat(value))) {
    const error = new ErrorWithStatusCode('tagIds contains an invalid tag id', 400);
    error.code = ERROR_CODES.INVALID_TAG_FILTER;
    throw error;
  }
  const deduped = [...new Set(values)];
  if (required && deduped.length === 0) {
    throw new ErrorWithStatusCode('tagIds must be a non-empty array', 400);
  }
  return deduped;
}

export function assertPromptTagLimit(tagIds) {
  if (tagIds.length > MAX_PROMPT_TAG_IDS) {
    const error = new ErrorWithStatusCode(
      'Prompt tag limit would be exceeded; no changes were applied',
      409,
    );
    error.code = ERROR_CODES.TAG_LIMIT_EXCEEDED;
    /** @type {any} */ (error).details = {
      attemptedCount: tagIds.length,
      maxPromptTagIds: MAX_PROMPT_TAG_IDS,
    };
    throw error;
  }
}

/**
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {PromptListOptions} [options]
 * @param {object} [log]
 * @returns {Promise<SerenityPrompt[]>}
 */
export async function listAllProjectPrompts(
  transport,
  semrushWorkspaceId,
  projectId,
  options,
  log,
) {
  const {
    tagIds = [], search, sort, order,
  } = options ?? {};
  const items = [];
  const limit = 200;
  let page = 1;
  const maxPages = 100;
  while (page <= maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
      tag_ids: tagIds,
      page,
      limit,
      search,
      ...(sort ? { sort, order } : {}),
    });
    const batch = Array.isArray(response?.items) ? response.items : [];
    items.push(...batch);
    log?.debug?.('listAllProjectPrompts: faceted prompt page read', {
      semrushWorkspaceId,
      projectId,
      page,
      pageSize: limit,
      pagePromptsRead: batch.length,
      upstreamPromptsScanned: items.length,
    });
    if (batch.length < limit) {
      log?.info?.('listAllProjectPrompts: faceted prompt corpus read', {
        semrushWorkspaceId,
        projectId,
        pagesWalked: page,
        pageSize: limit,
        upstreamPromptsScanned: items.length,
      });
      return items;
    }
    page += 1;
  }
  log?.warn?.('listAllProjectPrompts: faceted prompt ceiling reached', {
    semrushWorkspaceId,
    projectId,
    pagesWalked: maxPages,
    pageSize: limit,
    upstreamPromptsScanned: items.length,
  });
  const error = new ErrorWithStatusCode('Unable to read the complete prompt cohort', 503);
  error.code = ERROR_CODES.PROMPT_CORPUS_INCOMPLETE;
  throw error;
}

/**
 * Resolves a public faceted-v1 selection into OR-within-family groups and the
 * expanded upstream candidate ids used for the bounded prompt scan.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string[]} tagIds
 * @param {object} [log]
 * @param {Awaited<ReturnType<typeof readTagTreeSnapshot>>} [snapshot]
 * @returns {Promise<{
 *   groups: Set<string>[],
 *   candidateIds: string[],
 *   compatibilityById: Map<string, TagTreeItem['compatibility']>,
 * }>}
 */
export async function resolveFacetedTagFilter(
  transport,
  semrushWorkspaceId,
  projectId,
  tagIds,
  log,
  snapshot,
) {
  if (tagIds.length === 0) {
    return { groups: [], candidateIds: [], compatibilityById: new Map() };
  }
  const tree = snapshot
    ?? await readTagTreeSnapshot(transport, semrushWorkspaceId, projectId, log);
  const selected = tagIds.map((id) => tree.byId.get(id));
  if (selected.some((item) => !item
    || item.depth === 1
    || item.compatibility?.state !== 'canonical'
    || (item.rootName === DIMENSION.TAG && item.depth > 3))) {
    const error = new ErrorWithStatusCode(
      'One or more selected tag ids are unknown or incompatible with faceted-v1',
      400,
    );
    error.code = ERROR_CODES.INVALID_TAG_FILTER;
    throw error;
  }
  const validSelected = /** @type {TagTreeItem[]} */ (selected);
  const groups = new Map();
  for (const item of validSelected) {
    const familyId = item.fullPath[1]?.id ?? item.id;
    if (!groups.has(familyId)) {
      groups.set(familyId, new Set());
    }
    const accepted = groups.get(familyId);
    accepted.add(item.id);
    if (item.depth === 2) {
      for (const descendant of tree.items) {
        if (descendant.fullPath.some((part) => part.id === item.id)) {
          accepted.add(descendant.id);
        }
      }
    }
  }
  return {
    groups: [...groups.values()],
    candidateIds: [...new Set([...groups.values()].flatMap((group) => [...group]))],
    compatibilityById: new Map(
      tree.items.map((item) => [item.id, item.compatibility]),
    ),
  };
}

/**
 * Normalizes a complete prompt tag replacement by retaining unknown/read-only
 * ids verbatim and adding the required depth-2 parent for every canonical
 * depth-3 plain tag.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string[]} tagIds
 * @param {object} [log]
 * @param {Awaited<ReturnType<typeof readTagTreeSnapshot>>} [snapshot]
 * @returns {Promise<string[]>}
 */
export async function normalizePromptTagSelection(
  transport,
  semrushWorkspaceId,
  projectId,
  tagIds,
  log,
  snapshot,
) {
  const tree = snapshot
    ?? await readTagTreeSnapshot(transport, semrushWorkspaceId, projectId, log);
  const normalized = new Set();
  for (const id of tagIds) {
    const item = tree.byId.get(id);
    if (!item) {
      normalized.add(id);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (item.depth === 1) {
      const error = new ErrorWithStatusCode(
        'A dimension root cannot be assigned to a prompt',
        400,
      );
      error.code = ERROR_CODES.INVALID_TAG_FILTER;
      throw error;
    }
    if (item.compatibility?.state === 'readOnly') {
      normalized.add(id);
      // Read-only ids are retained verbatim. Bulk mutation rejects them as
      // mutation targets, while replacement writers must not erase them.
      // eslint-disable-next-line no-continue
      continue;
    }
    normalized.add(id);
    if (item.rootName === DIMENSION.TAG && item.depth === 3) {
      normalized.add(item.fullPath[1].id);
    }
  }
  const result = [...normalized];
  assertPromptTagLimit(result);
  return result;
}

/**
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {{
 *   geoTargetId: number,
 *   languageCode: string,
 *   page: number,
 *   limit: number,
 *   search?: string,
 *   sort?: string,
 *   order?: string,
 *   tagIds: string[],
 * }} options
 * @param {object} [log]
 */
export async function listFacetedPrompts(
  transport,
  semrushWorkspaceId,
  projectId,
  {
    geoTargetId,
    languageCode,
    page,
    limit,
    search,
    sort,
    order,
    tagIds,
  },
  log,
) {
  const resolved = await resolveFacetedTagFilter(
    transport,
    semrushWorkspaceId,
    projectId,
    tagIds,
    log,
  );
  const all = await listAllProjectPrompts(transport, semrushWorkspaceId, projectId, {
    tagIds: resolved.candidateIds,
    search,
    sort,
    order,
  }, log);
  const filtered = resolved.groups.length === 0 ? all : all.filter((prompt) => {
    const promptTagIds = new Set((Array.isArray(prompt?.tags) ? prompt.tags : [])
      .map((tag) => (typeof tag === 'string' ? tag : String(tag?.id ?? '')))
      .filter(Boolean));
    return resolved.groups.every((group) => [...group].some((id) => promptTagIds.has(id)));
  });
  const start = (page - 1) * limit;
  return {
    items: filtered
      .slice(start, start + limit)
      .map((item) => buildPromptDto(
        geoTargetId,
        languageCode,
        item,
        resolved.compatibilityById,
      ))
      .filter(Boolean),
    total: filtered.length,
    page,
    limit,
  };
}

/**
 * Publishes every affected project, collecting (not throwing) per-project failures. Shared by flat
 * and subworkspace callers.
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string[]} projectIds
 * @param {object} log
 * @param {(fn: () => Promise<any>) => Promise<any>} [wrapPublish] - wraps each project's
 *   `publishProject` call (default identity — a plain call, byte-for-byte the pre-existing
 *   behavior). Retained as a per-project injection seam for a future publish-retry wrapper
 *   (§10.3); no caller passes a non-identity wrapper today, so every publish is a plain call.
 * @param {{ env?: object | null, orgId?: string | null, brandId?: string | null } | null}
 *   [alertContext] - serenity-docs#72 §5: when supplied, fires the (deduplicated, fire-and-forget)
 *   Slack quota-rejection alert for a classified disguised-405 — every prior caller omitted this,
 *   so alerting existed nowhere on the prompt create/delete publish leg. Omit to skip alerting
 *   (byte-for-byte prior behavior).
 * @returns {Promise<Array<{ projectId: string, message: string, code?: string }>>} `code` is set
 *   to `ERROR_CODES.QUOTA_EXCEEDED` when the residual publish failure (after any retry
 *   `wrapPublish` already attempted) is a classified disguised-quota 405 (`isMeteredQuota`,
 *   serenity-docs#72 §4.1) — callers use this to surface the stable 409 token instead of a
 *   generic embedded `publish: <message>` failure record.
 */
export async function publishAffected(
  transport,
  semrushWorkspaceId,
  projectIds,
  log,
  wrapPublish = (fn) => fn(),
  alertContext = null,
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
      const quota = isMeteredQuota(e);
      if (quota && alertContext) {
        // MysticatBot review, PR #2889: NOT awaited — alertQuotaRejection is documented
        // fire-and-forget (never throws), so awaiting it here would add Slack-post latency to
        // this project's branch of the publish fan-out for no benefit (dedup already guarantees
        // at most one post per key regardless of timing).
        alertQuotaRejection({
          orgId: alertContext.orgId,
          brandId: alertContext.brandId,
          workspaceId: semrushWorkspaceId,
          caseType: 'brandCarveExhausted',
          dimension: 'prompts',
        }, alertContext.env, log);
      }
      errors.push({
        projectId: pid,
        message: redactUpstreamMessage(e),
        ...(quota ? { code: ERROR_CODES.QUOTA_EXCEEDED } : {}),
      });
    }
  }));
  return errors;
}

/**
 * Deletes each project's prompt batch via `transport.deletePromptsByIds`, treating an
 * upstream 404 as idempotent success, and emits one structured, requester-attributed
 * `logPromptDeleteEvent` line per prompt (SITES-50099) — success or failure alike.
 * Shared by flat and subworkspace callers: the loop is identical in both once `byProject`
 * is built, so it lives here rather than being hand-duplicated across the two twins (same
 * reasoning as {@link publishAffected} and {@link invalidateTagCacheForProject}).
 * @param {SerenityTransport} transport
 * @param {string} workspaceId
 * @param {Map<string, { ids: string[], targets: Array<{ semrushPromptId: string,
 *   geoTargetId: number, languageCode: string }> }>} byProject
 * @param {any} log
 * @param {object} auditCtx
 * @param {string | null} auditCtx.orgId
 * @param {string | null | undefined} auditCtx.brandId
 * @param {string} auditCtx.callerId
 * @returns {Promise<{ deleted: number, failed: Array<{ semrushPromptId: string,
 *   geoTargetId: number, languageCode: string, status: number, message: string }>,
 *   projectsToPublish: Set<string> }>}
 */
export async function deleteProjectBatches(
  transport,
  workspaceId,
  byProject,
  log,
  { orgId, brandId, callerId },
) {
  let deleted = 0;
  const failed = [];
  const projectsToPublish = new Set();

  const logEvent = (t, outcome, extra = {}) => logPromptDeleteEvent(log, {
    organizationId: orgId,
    brandId,
    semrushWorkspaceId: workspaceId,
    semrushPromptId: t.semrushPromptId,
    geoTargetId: t.geoTargetId,
    languageCode: t.languageCode,
    callerId,
    outcome,
    ...extra,
  });

  await Promise.all(Array.from(byProject.entries()).map(async ([pid, bucket]) => {
    try {
      await transport.deletePromptsByIds(workspaceId, pid, bucket.ids);
      deleted += bucket.ids.length;
      projectsToPublish.add(pid);
      bucket.targets.forEach((t) => logEvent(t, 'deleted'));
    } catch (e) {
      if (isUpstreamGone(e)) {
        deleted += bucket.ids.length;
        projectsToPublish.add(pid);
        bucket.targets.forEach((t) => logEvent(t, 'deleted', { alreadyGone: true }));
        return;
      }
      // Computed once per bucket, not per target — both values depend only on the
      // one caught error `e`, shared by every target in this project's batch.
      const message = redactUpstreamMessage(e);
      const status = e.status || 500;
      bucket.targets.forEach((t) => {
        failed.push({
          semrushPromptId: t.semrushPromptId,
          geoTargetId: t.geoTargetId,
          languageCode: t.languageCode,
          status,
          message,
        });
        logEvent(t, 'error', { status, message });
      });
    }
  }));

  return { deleted, failed, projectsToPublish };
}

/**
 * Reconciles `publishAffected`'s per-project failures against this request's newly created
 * prompts (serenity-docs#72 §4.1 atomicity: "no write may leave prompts staged-but-unpublished" —
 * "the handler MUST delete the prompts this request staged... and then return the quota token").
 *
 * For each project whose publish failed with a classified quota rejection (`pubErr.code ===
 * ERROR_CODES.QUOTA_EXCEEDED`), deletes the prompts THIS request staged there and moves them from
 * `created` into `failed` as a 409 `quotaExceeded` record — the write fails whole for that
 * project rather than leaving unpublished drafts live upstream. A non-quota publish failure is
 * untouched: it stays the existing generic `publish: <message>` 502 record (unchanged behavior;
 * this is not a "residual quota" case, so nothing was staged-and-abandoned by a rule this
 * function enforces).
 *
 * Mutates `created` (removing rolled-back items) and `failed` (appending their replacement
 * records) IN PLACE. Every entry in `created` must carry `rollbackProjectId` — an internal
 * bookkeeping field the caller strips before the response is returned (see
 * `handleCreatePrompts` / `handleCreatePromptsSubworkspace`).
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {Array<{ projectId: string, message: string, code?: string }>} publishErrors
 * @param {Array<{ rollbackProjectId: string, semrushPromptId: string, text: string,
 *   geoTargetId: number, languageCode: string }>} created
 * @param {Array<object>} failed
 * @param {object} [log]
 * @param {{ env?: object | null, orgId?: string | null, brandId?: string | null } | null}
 *   [alertContext] - serenity-docs#72 §5: when supplied and the rollback delete itself fails,
 *   fires the distinct engineering-defect alert ({@link alertRollbackFailure}) — "never silently
 *   logged." Omit to skip alerting (byte-for-byte prior behavior: log only).
 * @returns {Promise<void>}
 */
export async function reconcilePublishErrors(
  transport,
  semrushWorkspaceId,
  publishErrors,
  created,
  failed,
  log,
  alertContext = null,
) {
  for (const pubErr of publishErrors) {
    if (pubErr.code !== ERROR_CODES.QUOTA_EXCEEDED) {
      failed.push({ text: '', status: 502, message: `publish: ${pubErr.message}` });
    } else {
      // Pull every prompt THIS request staged in the rejected project out of `created` — walking
      // backwards so splicing doesn't skip an element.
      const staged = [];
      for (let i = created.length - 1; i >= 0; i -= 1) {
        if (created[i].rollbackProjectId === pubErr.projectId) {
          staged.unshift(created.splice(i, 1)[0]);
        }
      }
      if (staged.length > 0) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await transport.deletePromptsByIds(
            semrushWorkspaceId,
            pubErr.projectId,
            staged.map((c) => c.semrushPromptId),
          );
        } catch (rollbackErr) {
          // Best-effort: the primary quota-rejection signal to the caller must not be lost behind
          // a rollback failure. A DISTINCT, greppable token so a stranded staged-but-unpublished
          // prompt (the exact state this rollback exists to prevent) is alertable rather than
          // silently absorbed. serenity-docs#72 §4.1/§5: "never silently logged" — a log line
          // alone is not compliant, so this ALSO fires the distinct engineering-defect Slack
          // alert when alertContext is available.
          log?.error?.('SERENITY_QUOTA_ROLLBACK_FAILED — could not delete staged prompts after a residual publish-leg quota rejection; they may remain live as unpublished drafts', {
            semrushWorkspaceId,
            projectId: pubErr.projectId,
            semrushPromptIds: staged.map((c) => c.semrushPromptId),
            error: rollbackErr?.message,
          });
          if (alertContext) {
            // eslint-disable-next-line no-await-in-loop
            await alertRollbackFailure({
              orgId: alertContext.orgId,
              brandId: alertContext.brandId,
              workspaceId: semrushWorkspaceId,
              projectId: pubErr.projectId,
              semrushPromptIds: staged.map((c) => c.semrushPromptId),
              // MysticatBot review, PR #2889: alertRollbackFailure's JSDoc promises an
              // already-redacted message (this is Slack-bound, not an internal log) — the raw
              // upstream error can carry internal service URLs/stack traces.
              rollbackError: redactUpstreamMessage(rollbackErr),
            }, alertContext.env, log);
          }
        }
      }
      if (staged.length > 0) {
        for (const item of staged) {
          failed.push({
            text: item.text,
            geoTargetId: item.geoTargetId,
            languageCode: item.languageCode,
            status: 409,
            error: ERROR_CODES.QUOTA_EXCEEDED,
            message: pubErr.message,
          });
        }
      } else {
        // aenascut review, PR #2889: a quota-rejected project with NO prompts staged by this
        // request (e.g. a bulk-delete's publish, or a create where every input for this project
        // was itself skipped/failed before staging) has nothing to loop over above — without this
        // fallback the 409 quotaExceeded signal for that project silently vanishes instead of
        // reaching the caller.
        failed.push({
          text: '',
          status: 409,
          error: ERROR_CODES.QUOTA_EXCEEDED,
          message: pubErr.message,
        });
      }
    }
  }
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
function validTagIds(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((t) => String(t || '').trim())
    .filter((t) => isValidTagIdFormat(t));
}

/**
 * {@link validTagIds} plus a fail-loud cap at {@link MAX_TAG_IDS}. Used by
 * {@link normalizePromptInput} (CREATE) only; UPDATE applies the same raw-input
 * limit in {@link parseUpdatePromptBody}. Caller ids are never sliced.
 *
 * This cap bounds the CALLER-supplied tags only. The server-derived dimension
 * tags (`type`, `origin`, `source`, `intent`) are injected downstream by
 * {@link makePromptTagInjector} and the intent injector AFTER this sanitize,
 * and are intentionally EXEMPT from the user-facing cap — a write may
 * therefore carry up to `MAX_TAG_IDS` + 4 ids. They must never be dropped to
 * fit the cap: a prompt missing its `type`/`origin`/`source`/`intent` tag is
 * invisible to that dimension's filter.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeTagIds(raw) {
  if (Array.isArray(raw)) {
    assertPromptTagLimit(raw);
  }
  return validTagIds(raw);
}

/**
 * Rejects any caller-supplied CREATE tag set over the public prompt limit
 * before project resolution, classification, or server-managed tag injection.
 *
 * @param {Array<{ tagIds?: unknown }>} inputs
 */
export function assertCreatePromptTagLimits(inputs) {
  for (const input of inputs) {
    if (Array.isArray(input?.tagIds)) {
      assertPromptTagLimit(input.tagIds);
    }
  }
}

/**
 * Preserves an UPDATE's complete, format-validated tag set when it is within
 * the public limit and fails loudly otherwise. No ids are reordered, exempted,
 * or truncated: flat and subworkspace PATCH share the same 409 contract, and
 * server-owned ids echoed by an editor remain present verbatim.
 *
 * @param {string[]} tagIds - already {@link validTagIds}-validated.
 * @returns {Promise<string[]>}
 */
export async function capUpdateTagIds(tagIds) {
  assertPromptTagLimit(tagIds);
  return [...tagIds];
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
  // PLACEHOLDER (LLMO-7533 §6): MAX_PROMPT_TEXT_LENGTH is a provisional bound,
  // not the confirmed Semrush contract — see its definition. Rejected here
  // (skipped[], no upstream call) rather than left for Semrush to reject, per
  // the ticket's "before any Semrush call" requirement.
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    return {
      value: null,
      reason: `text exceeds the maximum length of ${MAX_PROMPT_TEXT_LENGTH} characters`,
    };
  }
  if (hasDisallowedControlChars(text)) {
    return { value: null, reason: 'text contains disallowed control characters' };
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
  // source — per-item override for the Track flow (LLMO-6556). Absent ⇒ the batch
  // default (`config` for the human dialog) applies downstream. Present ⇒ must be
  // a known producer from SOURCE_VALUES; unknown slugs are rejected 400 so a caller
  // can only SELECT from the server's vocabulary, never invent one.
  // FIX (review Should-Fix #1): gate on nullish, not `!== undefined`. An explicit
  // JSON `source: null` means "no override" (a client serializing an optional
  // field), so it must fall through to the batch default — not 400 with a
  // misleading "must be one of …". Only a non-nullish value is validated.
  let source;
  if (input?.source != null) {
    const canon = canonicalizeSource(input.source);
    if (!canon || !SOURCE_VALUES.includes(canon)) {
      return { value: null, reason: `source must be one of ${SOURCE_VALUES.join(', ')}` };
    }
    source = canon;
  }
  return {
    value: {
      text, languageCode, geoTargetId, tagIds, ...(source !== undefined && { source }),
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
 * STAMPS create authorship (LLMO-6289): every create goes through the v3
 * `createPromptsWithMetadata` write carrying `created_* = updated_* = now /
 * callerId`. The metadata rides the same write as the create — nothing to
 * sequence, no read-before-write.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {{ text: string, tagIds: string[] }} input
 * @param {string} callerId - resolved caller id (see {@link resolveCallerId}).
 * @returns {Promise<string>} the new upstream prompt id, or '' if the
 *   response carried none.
 */
export async function createOnePrompt(transport, semrushWorkspaceId, projectId, input, callerId) {
  const resp = await transport.createPromptsWithMetadata(
    semrushWorkspaceId,
    projectId,
    [{ name: input.text, metadata: buildCreateMetadata(callerId) }],
    input.tagIds,
  );
  return Array.isArray(resp?.items) && resp.items.length > 0
    ? String(resp.items[0].id ?? '')
    : '';
}

/**
 * Builds the per-request prompt-tag injector — the UNIFIED server-owned-dimension
 * layer (serenity-docs#31 for `type`; source-dimension.md for `source`). It
 * stamps the dimensions a client may never set on a prompt: `type` (branded /
 * non-branded, classified from the text) and `source` (the producing system).
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
 * `origin` and `source` are independent live dimensions. `originValue` is the
 * CREATE-time authorship fact (`human` or `ai`), while `sourceValue` is the
 * producing system. Neither is folded into or substituted for the other.
 *
 * **`source`** — the PRODUCING SYSTEM (source-dimension.md), a fact about
 * CREATION, not a classification:
 *   - on CREATE (`sourceValue` set — the constant `config` for this proxy dialog,
 *     the value the same prompt gets in Postgres on the v2 path, or a validated
 *     per-item override), the canonical source slug is injected independently. Any
 *     caller-supplied tag id beneath the `source` root is stripped (by RESOLVED
 *     ID, never by name — a customer category may legitimately be called
 *     `gsc`) and the derived value injected. The dimension has no client write
 *     surface;
 *   - on UPDATE (`sourceValue` and `originValue` both unset) the injector leaves
 *     source ALONE — a prompt's producer is fixed at creation.
 *
 * Resolution ({@link resolveTypeValueInjection} / {@link resolveServerOwnedValueInjection},
 * two tag-tree reads per distinct value per project — the root level plus the
 * root's children) is memoized for the request, so a bulk create fans out over
 * the distinct computed values rather than over the items. The source value is
 * effectively constant per request (modulo the rare per-item override), so each
 * resolution is memoized per (project, derived value).
 *
 * Resolution resolves or throws, so a server tag is always attached; it is never
 * dropped, and a resolution failure aborts the write (which is free — the upstream
 * bulk create is atomic and has not run yet) rather than writing an unclassified
 * or unattributed prompt behind a 2xx.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {((text: string, geoTargetId: number) => string) | undefined} classifyPromptType
 * @param {object} [log]
 * @param {{ originValue?: string, sourceValue?: string,
 *   normalizeCustomerTags?: boolean }} [options] - `originValue`
 *   is the CREATE-time `origin` fact (`ai`/`human`). `sourceValue` is the
 *   independent batch-default producing-system slug. Omit both on UPDATE so
 *   existing origin/source selections remain untouched.
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tagIds: string[], source?: string }) =>
 *   Promise<{ text: string, geoTargetId: number, tagIds: string[] }>}
 */
export function makePromptTagInjector(
  transport,
  semrushWorkspaceId,
  classifyPromptType,
  log,
  options = {},
) {
  const { originValue, sourceValue, normalizeCustomerTags = false } = options;
  /** @type {Map<string, Promise<{ computedId: string, typeTagIds: string[] }>>} */
  const typeCache = new Map();
  /** @type {Map<string, Promise<{ computedId: string, valueTagIds: string[] }>>} */
  const originCache = new Map();
  /** @type {Map<string, Promise<{ computedId: string, valueTagIds: string[] }>>} */
  const sourceCache = new Map();
  const taxonomyCache = new Map();
  return async function injectComputedTags(projectId, input) {
    let { tagIds } = input;
    if (normalizeCustomerTags) {
      let snapshotPromise = taxonomyCache.get(projectId);
      if (!snapshotPromise) {
        snapshotPromise = readTagTreeSnapshot(
          transport,
          semrushWorkspaceId,
          projectId,
          log,
        );
        taxonomyCache.set(projectId, snapshotPromise);
      }
      tagIds = await normalizePromptTagSelection(
        transport,
        semrushWorkspaceId,
        projectId,
        input.tagIds,
        log,
        await snapshotPromise,
      );
    }

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

    if (originValue) {
      const key = `${projectId} ${originValue}`;
      let pending = originCache.get(key);
      if (!pending) {
        pending = resolveServerOwnedValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          DIMENSION.ORIGIN,
          originValue,
          log,
        );
        originCache.set(key, pending);
      }
      const { computedId, valueTagIds } = await pending;
      tagIds = [...tagIds.filter((id) => !valueTagIds.includes(id)), computedId];
    }

    // source — CREATE only, same create/update asymmetry `origin` used to
    // carry. Per-item `input.source` (Track flow, LLMO-6556) overrides the
    // batch default (`sourceValue`); absent on both means UPDATE — leave the
    // producer alone (fixed at creation). `??` not `||` (MysticatBot nit):
    // `normalizePromptInput` yields a valid slug or `undefined`, so "absent
    // means use the batch default" is exactly the nullish-coalesce contract.
    //
    // Source remains independent from authorship. Cache is keyed on the
    // canonical producing-system value and stripped by resolved id.
    const rawSource = input.source ?? sourceValue;
    const itemSource = rawSource ? canonicalizeSource(rawSource) : null;
    if (itemSource) {
      const key = `${projectId} ${itemSource}`;
      let pending = sourceCache.get(key);
      if (!pending) {
        pending = resolveServerOwnedValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          DIMENSION.SOURCE,
          itemSource,
          log,
        );
        sourceCache.set(key, pending);
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
 * because it is an LLM call, not a cheap pure function. A text ABSENT from
 * `intentByText` (e.g. beyond the AI-gen classify cap) falls back to
 * `INTENT_VALUE.INFORMATIONAL`, the seeded standard value — this sync-path
 * fallback is unchanged by serenity-docs#33.
 *
 * serenity-docs#33 "no terminal Informational default": a text PRESENT in
 * `intentByText` with an explicit `null` value (as the async worker's
 * unbounded classifier returns for a prompt whose retries are exhausted) is
 * NOT defaulted — `injectComputedIntent` strips any existing `intent` tag and
 * appends nothing, so the prompt is written with no value under the `intent`
 * root at all. This is the distinction between "missing from the map"
 * (sync-path default) and "in the map as null" (classification genuinely
 * failed) — callers that need the no-default behavior must populate the map
 * with an explicit `null` per pending text, not simply omit the key.
 *
 * Given the map, it returns `injectComputedIntent(projectId, input)` which:
 *   - STRIPS every caller-supplied tag id under the `intent` root (the client may
 *     never set the value), and
 *   - APPENDS the pre-resolved upstream id of the server-computed value, UNLESS
 *     the resolved value is `null` (see above), in which case nothing is
 *     appended. The atomic `createPromptsByIds` 500s on an unresolved id, so a
 *     non-null value is always resolved BEFORE the write.
 *
 * Id-based resolution ({@link resolveIntentValueInjection}, two tag-tree reads
 * per distinct `intent` value per project) is memoized for the request, mirroring
 * {@link makePromptTagInjector}'s memoization. `resolveIntentValueInjection` resolves
 * or throws, so the computed tag is always attached and never silently dropped.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {Map<string, string|null>} intentByText - text -> bare `intent` value,
 *   or `null` for a text that is known-pending (no terminal default).
 * @param {object} [log]
 * @returns {(projectId: string, input: { text: string, geoTargetId: number,
 *   tagIds: string[] }) =>
 *   Promise<{ text: string, geoTargetId: number, tagIds: string[] }>}
 */
export function makeIntentInjector(transport, semrushWorkspaceId, intentByText, log) {
  /** @type {Map<string, Promise<{ computedId: string|null, intentTagIds: string[] }>>} */
  const cache = new Map();
  return async function injectComputedIntent(projectId, input) {
    const intentValue = intentByText.has(input.text)
      ? (intentByText.get(input.text) ?? null)
      : INTENT_VALUE.INFORMATIONAL;
    const key = `${projectId} ${intentValue ?? '__none__'}`;
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
    const tagIds = computedId === null ? stripped : [...stripped, computedId];
    return { ...input, tagIds };
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
  // Mirror the create contract's placeholder length/control-char guard
  // (LLMO-7533 §6 — see normalizePromptInput / MAX_PROMPT_TEXT_LENGTH).
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalidRequest',
        message: `text exceeds the maximum length of ${MAX_PROMPT_TEXT_LENGTH} characters`,
      },
    };
  }
  if (hasDisallowedControlChars(text)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalidRequest', message: 'text contains disallowed control characters' },
    };
  }
  if (Array.isArray(body.tagIds) && body.tagIds.length > MAX_TAG_IDS) {
    return {
      ok: false,
      status: 409,
      body: {
        error: ERROR_CODES.TAG_LIMIT_EXCEEDED,
        message: 'Prompt tag limit would be exceeded; no changes were applied',
        details: {
          attemptedCount: body.tagIds.length,
          maxPromptTagIds: MAX_TAG_IDS,
        },
      },
    };
  }
  const tagIds = validTagIds(body.tagIds);
  if (tagIds.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalidRequest', message: 'tagIds must be a non-empty array' },
    };
  }
  return { ok: true, text, tagIds };
}

/**
 * The dimension a built tag belongs to: its root breadcrumb (`path[0]`), or its
 * own name when it IS a root. Folded through {@link dimensionOfRootName} because
 * a root's name is not always the bare dimension key (`$abv_tags$intent`).
 *
 * @param {{ name: string, path: Array<{ id: string, name: string }> | null }} tag
 * @returns {string}
 */
function tagDimensionOf(tag) {
  const rootName = Array.isArray(tag.path) && tag.path.length > 0
    ? tag.path[0].name
    : tag.name;
  return dimensionOfRootName(rootName);
}

/**
 * The tag ids an UPSERT must carry over from the prompt it rewrites.
 *
 * The tag write is a FULL replace and a CSV row supplies only `category` ids.
 * `type` and `intent` are recomputed from the text, but `origin` and `source` are
 * CREATE-only facts an edit never re-derives — the PATCH endpoint gets them
 * echoed back by the client, and an upsert has no such echo. Without this a CSV
 * import would strip every prompt's authorship, or relabel an AI-onboarded prompt
 * as this dialog's `human`/`config`.
 *
 * One tag per dimension: a second can only have come from the additive create
 * this replaces, so collapsing to the first — the one the UI already shows —
 * heals the duplicate without changing what anyone sees.
 *
 * CONTRACT THIS RESTS ON: the dimension is read from the tag's root breadcrumb
 * (`path[0]`), so the unfiltered `listPromptsByTags` response must carry the same
 * `path` shape `buildPromptDto` consumes. It does today. If that ever drifts,
 * `tagDimensionOf` falls back to the tag's own leaf name, no dimension matches,
 * and the replace silently strips authorship — the exact relabel this exists to
 * prevent. That failure is open and quiet, so it is logged rather than left to be
 * discovered in the data.
 *
 * @param {any} item - the upstream prompt item.
 * @param {any} [log]
 * @param {string} [projectId] - log context only.
 * @returns {string[]}
 */
function carryOverTagIdsOf(item, log, projectId) {
  const tags = buildTagsOf(item);
  const carried = [DIMENSION.ORIGIN, DIMENSION.SOURCE]
    .map((dimension) => tags.find((t) => t.id && tagDimensionOf(t) === dimension))
    .filter(Boolean)
    .map((t) => /** @type {{ id: string }} */ (t).id);
  // Narrow on purpose: a prompt that genuinely carries no tags is unremarkable, but
  // one WITH tags that resolves neither dimension is the breadcrumb-drift signature.
  if (carried.length === 0 && tags.length > 0) {
    log?.warn?.('serenity upsert: stored prompt resolved no origin/source tag — authorship will be dropped by the replace', {
      projectId, semrushPromptId: item?.id, tagCount: tags.length,
    });
  }
  return carried;
}

/** Paging cap, so a mis-paging upstream cannot spin a Lambda. 20k prompts. */
export const MAX_PROMPT_INDEX_PAGES = 20;

/**
 * Builds the `text -> stored prompt` index an upsert resolves against.
 *
 * Lists and matches locally rather than using the upstream `search` filter,
 * whose matching semantics are not pinned by the vendor contract — an upsert that
 * mis-identifies a prompt would rewrite the WRONG row's tags.
 *
 * LIVE-LAYER READ, like every other `listPromptsByTags` caller: a prompt staged
 * in an unpublished draft is invisible here and falls through to the create path
 * (the pre-existing behavior), never a wrong-row rewrite.
 *
 * `byText` is exact and wins; `byLower` is the fallback, because being
 * case-sensitive where upstream's own dedupe is not would send a case variant
 * back down the create path and straight into the additive attach.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {any} [log]
 * @returns {Promise<{ byText: Map<string, { semrushPromptId: string,
 *   carryOverTagIds: string[] }>, byLower: Map<string, { semrushPromptId: string,
 *   carryOverTagIds: string[] }> }>}
 */
export async function buildExistingPromptIndex(transport, semrushWorkspaceId, projectId, log) {
  /** @type {Map<string, { semrushPromptId: string, carryOverTagIds: string[] }>} */
  const byText = new Map();
  /** @type {Map<string, { semrushPromptId: string, carryOverTagIds: string[] }>} */
  const byLower = new Map();
  for (let page = 1; page <= MAX_PROMPT_INDEX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- paging is inherently sequential
    const resp = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
      tag_ids: [], page, limit: MAX_PAGE_LIMIT,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    for (const item of items) {
      // Trimmed to match `normalizePromptInput`, which trims before comparing.
      const text = String(item?.name ?? '').trim();
      const id = item?.id ? String(item.id) : '';
      if (text && id) {
        const entry = {
          semrushPromptId: id,
          carryOverTagIds: carryOverTagIdsOf(item, log, projectId),
        };
        if (!byText.has(text)) {
          byText.set(text, entry);
        }
        if (!byLower.has(text.toLowerCase())) {
          byLower.set(text.toLowerCase(), entry);
        }
      }
    }
    if (items.length < MAX_PAGE_LIMIT) {
      return { byText, byLower };
    }
  }
  // Past the cap the index is incomplete: later rows resolve as "new" and take the
  // create path — the pre-existing behavior. Degraded, not broken, but worth a signal.
  log?.warn?.('serenity upsert: prompt index hit the page cap — later prompts may be treated as new', {
    projectId, pages: MAX_PROMPT_INDEX_PAGES,
  });
  return { byText, byLower };
}

/**
 * Looks an input's text up in a {@link buildExistingPromptIndex} result.
 *
 * @param {{ byText: Map<string, any>, byLower: Map<string, any> } | undefined} index
 * @param {string} text
 * @returns {{ semrushPromptId: string, carryOverTagIds: string[] } | undefined}
 */
export function findStoredPrompt(index, text) {
  if (!index) {
    return undefined;
  }
  return index.byText.get(text) ?? index.byLower.get(text.toLowerCase());
}

/**
 * @typedef {{ byText: Map<string, any>, byLower: Map<string, any> }} PromptIndex
 * @typedef {{ indexError: string, indexErrorStatus: number }} PromptIndexError
 */

/**
 * Type guard for a {@link buildPromptIndexByProject} entry that failed to read.
 * @param {PromptIndex | PromptIndexError | undefined} entry
 * @returns {entry is PromptIndexError}
 */
export function isIndexError(entry) {
  return !!entry && 'indexError' in entry;
}

/**
 * Builds one {@link buildExistingPromptIndex} per affected project, CONTAINING a
 * per-project read failure instead of letting it abort the whole fan-out
 * (serenity-docs#472 §2 / LLMO-7533). An unguarded `Promise.all` over this read
 * used to propagate a transient upstream failure (e.g. a transport-level `502`)
 * out of the whole create/upsert handler — the controller then answered a bare
 * outer HTTP failure with no mixed-result body, so the caller could not tell
 * which rows (if any) actually failed and could not continue with later
 * batches. Every OTHER project's index still builds normally; only the failed
 * project's entry is replaced with a {@link PromptIndexError} marker, which the
 * caller's per-item loop must check for BEFORE calling {@link findStoredPrompt}
 * (an error marker has no `byText`/`byLower` and is not itself index-shaped).
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {Array<string | null | undefined>} projectIds
 * @param {any} [log]
 * @returns {Promise<Map<string, PromptIndex | PromptIndexError>>}
 */
export async function buildPromptIndexByProject(transport, semrushWorkspaceId, projectIds, log) {
  /** @type {Map<string, PromptIndex | PromptIndexError>} */
  const promptIndexByProject = new Map();
  await Promise.all(
    [...new Set(projectIds.filter(Boolean))].map(async (projectId) => {
      const pid = /** @type {string} */ (projectId);
      try {
        promptIndexByProject.set(pid, await buildExistingPromptIndex(
          transport,
          semrushWorkspaceId,
          pid,
          log,
        ));
      } catch (e) {
        log?.error?.(
          'serenity upsert: existing-prompt index read failed for project — failing only that '
          + "project's inputs, unaffected projects continue",
          { projectId: pid, error: e.message },
        );
        promptIndexByProject.set(pid, {
          indexError: redactUpstreamMessage(e),
          indexErrorStatus: e.status || 502,
        });
      }
    }),
  );
  return promptIndexByProject;
}

/**
 * One project's batched UPSERT tag writes: a single replace-mode tag write, then
 * a best-effort authorship stamp.
 *
 * Order matters — the tag write is the point of the operation, so a failed stamp
 * is logged rather than fatal. The reverse would let a cosmetic failure discard
 * the write the caller asked for.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {Array<{ semrushPromptId: string, tagIds: string[] }>} updates
 * @param {string} callerId
 * @param {any} [log]
 * @returns {Promise<void>} rejects when the tag write itself fails.
 */
export async function applyUpsertTagWrites(
  transport,
  semrushWorkspaceId,
  projectId,
  updates,
  callerId,
  log,
) {
  await transport.updatePromptTagsByIds(
    semrushWorkspaceId,
    projectId,
    updates.map((u) => ({ id: u.semrushPromptId, references: u.tagIds, replace: true })),
  );
  try {
    await transport.patchPromptsMetadataBatch(
      semrushWorkspaceId,
      projectId,
      updates.map((u) => ({
        promptId: u.semrushPromptId,
        metadata: buildUpdateMetadata(callerId),
      })),
    );
  } catch (e) {
    log?.warn?.('serenity upsert: tags replaced but the authorship stamp failed — Last modified is stale', {
      projectId, count: updates.length, error: e?.message,
    });
  }
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
 * UPSERT, not create-only: an input whose text already exists in the resolved
 * project has its tags REPLACED (reported in `updated`) instead of being posted
 * again. The upstream create folds a repeated text into `existing_count` but
 * still ATTACHES the tag_ids it is given, so posting again silently stacked a
 * second category onto the prompt and the change could never be undone. Costs one
 * listing per affected project; the tag writes are batched per project.
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
 * @param {SerenityTransport} transport
 * @param {any} dataAccess
 * @param {string | undefined} brandId
 * @param {string} semrushWorkspaceId
 * @param {any} body
 * @param {any} log
 * @param {any} classifyPromptType
 * @param {object | null} env - environment (Azure OpenAI creds), threaded into intent
 *   classification; ALSO used directly to fire the quota-rejection Slack alert (serenity-docs#72
 *   §5). Optional — omitted, alerting is a no-op.
 * @param {number | undefined} writeDeadline - shared request-write deadline for intent
 *   classification. A caller with no deadline of its own (e.g. finalize's deferred prompt push)
 *   passes undefined; classifyPromptIntents defaults to Informational whenever env is also unset,
 *   before the deadline math is ever evaluated. (Typed as a required union, not an optional
 *   param, because it precedes the required callerId below — tsc rejects an optional parameter
 *   ahead of a required one.)
 * @param {string} callerId - resolved caller id (LLMO-6289) stamped as the created/updated author.
 * @param {object} [options]
 * @param {boolean} [options.publish] - see above.
 * @param {string | null} [options.orgId] - serenity-docs#72 §5 alert payload only.
 * @param {string} [options.originValue=human] - trusted caller-principal origin.
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
  callerId,
  { publish = true, orgId = null, originValue = ORIGIN_VALUE.HUMAN } = {},
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
  assertCreatePromptTagLimits(inputs);
  const deferPublish = validateDeferPublish(body);

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectsBySlice = new Map();
  for (const p of projects || []) {
    projectsBySlice.set(`${p.getGeoTargetId()}:${p.getLanguageCode()}`, p);
  }

  // CREATE: user-authenticated write stamps independent `origin=human` and
  // `source=config` values. The producing `source` matches what
  // human create dialog is what the same prompt gets in Postgres on the v2
  // path (source-dimension.md §1).
  const injectComputedTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
    {
      originValue,
      sourceValue: PROXY_CREATE_SOURCE_VALUE,
      normalizeCustomerTags: true,
    },
  );
  // UPSERT: the same injector built for an EDIT — no `originValue`/`sourceValue`,
  // so `source` is left untouched (see makePromptTagInjector's contract and
  // handleUpdatePrompt, which builds it the same way). The stored producer is
  // carried over explicitly by `carryOverTagIdsOf` instead.
  const injectStoredTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
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

  // UPSERT: normalize once up front so every input's owning project is known
  // before the fan-out, then index each affected project's prompts a single time.
  const normalizedInputs = inputs.map((raw) => {
    const { value, reason } = normalizePromptInput(raw);
    const project = value
      ? projectsBySlice.get(`${value.geoTargetId}:${value.languageCode}`)
      : undefined;
    return {
      raw,
      input: value,
      reason,
      projectId: project ? project.getSemrushProjectId() : null,
    };
  });
  const promptIndexByProject = await buildPromptIndexByProject(
    transport,
    semrushWorkspaceId,
    normalizedInputs.map((n) => n.projectId),
    log,
  );

  const results = await mapLimit(normalizedInputs, BULK_CREATE_CONCURRENCY, async (entry) => {
    const { raw, input, reason } = entry;
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: /** @type {string} */ (reason),
        },
      };
    }
    if (!entry.projectId) {
      return {
        skipped: {
          text: input.text,
          reason: `No market for slice (${input.geoTargetId}, ${input.languageCode})`,
        },
      };
    }
    const { projectId } = entry;
    const projectIndex = promptIndexByProject.get(projectId);
    if (isIndexError(projectIndex)) {
      // serenity-docs#472 §2: the existing-prompt index read failed for this project —
      // fail only its inputs (itemized, HTTP 200) instead of aborting the whole batch.
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: projectIndex.indexErrorStatus,
          message: projectIndex.indexError,
        },
      };
    }
    const stored = findStoredPrompt(projectIndex, input.text);
    try {
      if (stored) {
        // REPLACE the existing prompt's tags. The stored authorship rides along so
        // the full replace cannot strip it; deduped because a caller that supplied
        // one of those ids itself would otherwise write it twice.
        //
        // `source` is dropped from the input: it is a per-item CREATE override
        // (LLMO-6556), and leaving it on would make the injector resolve-and-append
        // ITS source id next to the carried-over stored one — two values in a
        // dimension that must hold exactly one. PATCH never carries it either.
        const { source: _, ...editable } = input;
        let typed = await injectStoredTags(projectId, {
          ...editable,
          tagIds: [...new Set([...input.tagIds, ...stored.carryOverTagIds])],
        });
        typed = await injectComputedIntent(projectId, typed);
        return {
          updated: {
            semrushPromptId: stored.semrushPromptId,
            geoTargetId: typed.geoTargetId,
            languageCode: input.languageCode,
            text: typed.text,
            tagIds: typed.tagIds,
          },
          affectedProjectId: projectId,
        };
      }
      // Unified layer: strip caller-supplied type/origin/source/intent, then inject
      // the computed type, derived origin, producing source, and classified intent.
      // The two injectors act on disjoint dimensions, so chaining composes cleanly.
      let typed = await injectComputedTags(projectId, input);
      typed = await injectComputedIntent(projectId, typed);
      const semrushPromptId = await createOnePrompt(
        transport,
        semrushWorkspaceId,
        projectId,
        typed,
        callerId,
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
      // serenity-docs#72 §4.1: a disguised-405 quota rejection on the metered write itself
      // (flat-mode twin — keep in lockstep with the sub-workspace handler) must surface as the
      // stable 409 quotaExceeded token, not the raw upstream status or a generic 500.
      const quota = isMeteredQuota(e);
      if (quota) {
        // serenity-docs#72 §5: this write-path rejection had NO alerting anywhere before —
        // publishAffected's own alerting only covers the later publish leg, not this earlier
        // metered-write choke point.
        await alertQuotaRejection({
          orgId, brandId, workspaceId: semrushWorkspaceId, caseType: 'brandCarveExhausted', dimension: 'prompts',
        }, env, log);
      }
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: quota ? 409 : (e.status || 500),
          ...(quota ? { error: ERROR_CODES.QUOTA_EXCEEDED } : {}),
          message: redactUpstreamMessage(e),
        },
      };
    }
  });

  const created = [];
  const updated = [];
  const skipped = [];
  const failed = [];
  const affectedProjectIds = [];
  /** @type {Map<string, Array<{ semrushPromptId: string, tagIds: string[] }>>} */
  const updatesByProject = new Map();
  // Collapsed by upstream prompt id, LAST ROW WINS. Two rows carrying the same text
  // resolve to the SAME stored prompt, so without this the replace batch would carry
  // two items for one id — and upstream tie-breaking within a single atomic batch is
  // not pinned by the vendor contract, so the surviving tag set would be arbitrary.
  // Collapsing here rather than just before the write also keeps `updated` honest:
  // one prompt changed is one entry, not two. Mirrors the create path, where upstream
  // folds a repeated text into `existing_count`.
  /** @type {Map<string, { projectId: string, entry: any }>} */
  const updatedById = new Map();
  for (const r of results) {
    if (r.created) {
      // `rollbackProjectId` is internal bookkeeping for reconcilePublishErrors' rollback below;
      // stripped before the response is returned.
      created.push({ ...r.created, rollbackProjectId: r.affectedProjectId });
      affectedProjectIds.push(r.affectedProjectId);
    } else if (r.updated) {
      // NO `rollbackProjectId`: reconcilePublishErrors rolls a quota-rejected
      // project back by DELETING what this request staged, and an updated prompt
      // pre-existed the request.
      updatedById.set(r.updated.semrushPromptId, {
        projectId: r.affectedProjectId,
        entry: r.updated,
      });
    } else if (r.skipped) {
      skipped.push(r.skipped);
    } else if (r.failed) {
      failed.push(r.failed);
    }
  }
  for (const { projectId, entry } of updatedById.values()) {
    updated.push(entry);
    affectedProjectIds.push(projectId);
    const pending = updatesByProject.get(projectId) ?? [];
    pending.push({ semrushPromptId: entry.semrushPromptId, tagIds: entry.tagIds });
    updatesByProject.set(projectId, pending);
  }

  // One batched replace-mode tag write per project — the upstream write takes an
  // array, so a chunk touching N existing prompts costs one call, not N.
  await Promise.all([...updatesByProject].map(async ([projectId, pending]) => {
    try {
      await applyUpsertTagWrites(
        transport,
        semrushWorkspaceId,
        projectId,
        pending,
        callerId,
        log,
      );
    } catch (e) {
      // The project's batch failed whole, so none of its tags moved — never report
      // an update that did not land.
      const quota = isMeteredQuota(e);
      if (quota) {
        await alertQuotaRejection({
          orgId, brandId, workspaceId: semrushWorkspaceId, caseType: 'brandCarveExhausted', dimension: 'prompts',
        }, env, log);
      }
      for (let i = updated.length - 1; i >= 0; i -= 1) {
        if (pending.some((p) => p.semrushPromptId === updated[i].semrushPromptId)) {
          const [item] = updated.splice(i, 1);
          failed.push({
            text: item.text,
            geoTargetId: item.geoTargetId,
            languageCode: item.languageCode,
            status: quota ? 409 : (e.status || 500),
            ...(quota ? { error: ERROR_CODES.QUOTA_EXCEEDED } : {}),
            message: redactUpstreamMessage(e),
          });
        }
      }
    }
  }));

  // Tag cache invalidation: a new prompt may introduce a new tag (or
  // resurrect a tag whose last prompt was previously deleted), so any
  // project that received a successful create must drop its cached
  // tag set on this container. An upsert resolves-or-creates a category too.
  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  // body.deferPublish (CSV-chunking) — draft-only write, publish deferred to a
  // later non-deferred call; return early flagged not-published.
  if (deferPublish) {
    log?.info?.('serenity create-prompts: deferPublish set — prompts written as draft, publish skipped', {
      brandId,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      failed: failed.length,
    });
    return {
      // eslint-disable-next-line no-unused-vars -- omit the bookkeeping field
      created: created.map(({ rollbackProjectId, ...rest }) => rest),
      updated,
      skipped,
      failed,
      published: false,
    };
  }

  // publish:false — the caller (finalize) batches a single publish after models
  // are also set, so skip the per-create publish (and its quota-rollback
  // reconciliation) here; finalize's own publish step is the one that runs it.
  // `published` is false in this branch — no publish was even attempted, so
  // true would misreport it, matching the truthfulness fix below. The current
  // caller (finalize) ignores this field regardless (it drives its own
  // confirmed-live bookkeeping from finalizeSerenityProjects' own publish step).
  let published = false;
  if (publish) {
    const alertContext = { orgId, brandId, env };
    const publishErrors = await publishAffected(
      transport,
      semrushWorkspaceId,
      affectedProjectIds,
      log,
      undefined,
      alertContext,
    );
    // serenity-docs#72 §4.1 atomicity: a quota-rejected publish rolls back (deletes) the prompts
    // this request staged in that project and moves them into `failed` — never left as unpublished
    // drafts. A non-quota publish failure is untouched (existing generic `publish:` 502 record).
    await reconcilePublishErrors(
      transport,
      semrushWorkspaceId,
      publishErrors,
      created,
      failed,
      log,
      alertContext,
    );
    // serenity-docs#472 §6 / LLMO-7533: `published` must be false whenever ANY
    // affected project failed to publish — never returned true unconditionally
    // just because publish was attempted (Elmo used to infer success purely
    // from batch position; the API must tell the truth here for that fix to work).
    published = publishErrors.length === 0;
  }

  return {
    // eslint-disable-next-line no-unused-vars -- destructuring-omit to strip the bookkeeping field
    created: created.map(({ rollbackProjectId, ...rest }) => rest),
    updated,
    skipped,
    failed,
    published,
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
 * The edit is IN PLACE (serenity-docs#63): the combined v3 `PATCH .../{id}`
 * writes the text (as `name`) AND stamps the `updated_*` metadata pair in ONE
 * request, then the batch tag-reference write (v2 `PUT .../tags`, metadata-free)
 * replaces the tag set — both preserving the prompt id, so the response echoes
 * the UNCHANGED semrushPromptId and everything keyed to that id survives the
 * edit. Nothing is deleted on this path, so there is no data-loss window. Both
 * writes run unconditionally: upstream has no GET-by-id, so the handler cannot
 * know what changed — and does not need to (an unchanged-text combined PATCH
 * still merge-patches the metadata, and the replace-mode tag write is
 * idempotent). The combined PATCH runs FIRST because it is the one operation
 * that can refuse (409): a collision aborts the edit before any mutation.
 *
 * STAMP (LLMO-6289): the `updated_*` bump rides the combined text PATCH — the
 * SAME request as the text mutation, with NO read-before-write — so authorship
 * is stamped on every edit. The tag PUT carries NO metadata (there is no
 * metadata-carrying tag write upstream): its stamp is already covered by the
 * combined PATCH that always runs in this handler. `created_*` are never sent,
 * so merge-patch keeps them untouched. A tag-write failure after a successful
 * PATCH leaves a half-applied edit (text + stamp landed, tags not) — retryable,
 * nothing lost.
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
 * @param {SerenityTransport} transport
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
  callerId,
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
  const cappedTagIds = await capUpdateTagIds(nextTagIds);
  const injectComputedTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
    { normalizeCustomerTags: true },
  );
  const intentByText = await classifyPromptIntents(
    [nextText],
    {
      env, log, deadline: writeDeadline, writePath: 'edit', workspaceId: semrushWorkspaceId,
    },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);
  let typed = await injectComputedTags(projectId, {
    text: nextText, geoTargetId, tagIds: cappedTagIds,
  });
  typed = await injectComputedIntent(projectId, typed);

  try {
    // Combined v3 write: sets the text (`name`) and stamps the `updated_*`
    // metadata pair in one request (replaces the v2 `rename`). Same refusal
    // contract as rename — 404 (unknown id) → promptNotFound, 409 (text
    // collides with a sibling) → thrown for the controller's `conflict` mapping.
    await transport.patchPrompt(semrushWorkspaceId, projectId, semrushPromptId, {
      name: nextText,
      metadata: buildUpdateMetadata(callerId),
    });
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
    // The combined PATCH above already landed: the prompt's text + stamp have
    // moved while its tags are stale. Record the partial mutation before
    // propagating, so the generic upstream error the caller sees is
    // attributable on-call.
    log?.warn?.('updatePromptTagsByIds failed after a successful text/metadata PATCH — text updated, tags stale', {
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
 * @param {SerenityTransport} transport
 * @param {any} dataAccess
 * @param {string | undefined} brandId
 * @param {string} semrushWorkspaceId
 * @param {any} body
 * @param {any} log
 * @param {object} [options]
 * @param {string | null} [options.orgId] - also the audit log's organizationId.
 * @param {object | null} [options.env] - serenity-docs#72 §5 alert kill-switch/config only.
 * @param {string} [options.callerId] - resolved requester id (see resolveCallerId),
 *   stamped on every audit log line this call emits (SITES-50099).
 */
export async function handleBulkDeletePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  {
    orgId = null, env = null, callerId = 'unknown',
  } = {},
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

  const {
    deleted, failed: deleteFailures, projectsToPublish,
  } = await deleteProjectBatches(transport, semrushWorkspaceId, byProject, log, {
    orgId, brandId, callerId,
  });
  failed.push(...deleteFailures);

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
    undefined,
    { orgId, brandId, env },
  );
  // pubErr is an already-redacted { projectId, message, code? } record (see above).
  publishErrors.forEach((pubErr) => {
    if (pubErr.code === ERROR_CODES.QUOTA_EXCEEDED) {
      failed.push({
        semrushPromptId: '',
        status: 409,
        error: ERROR_CODES.QUOTA_EXCEEDED,
        message: pubErr.message,
      });
    } else {
      failed.push({
        semrushPromptId: '',
        status: 502,
        message: `publish: ${pubErr.message}`,
      });
    }
  });

  return { deleted, failed };
}
