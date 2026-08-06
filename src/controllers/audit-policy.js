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

import {
  badRequest, createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { UnauthorizedProductError } from '../support/errors.js';
import { AuditPolicyDto, AuditPolicyRevisionDto, AuditScopePageDto } from '../dto/audit-policy.js';

const POLICY_TABLE = 'audit_policy';
const REVISION_TABLE = 'audit_policy_revision';
const SCOPE_PAGES_VIEW = 'v_audit_scope_pages';
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

// getAuthor() stamps updated_by with an IMS user GUID for most auth paths (profile.email is
// overloaded to carry the GUID, not an RFC-5322 address - see access-control-util.js) rather
// than a human-readable identity. This gate mirrors fixes.js's IMS_ID_RE: only strings shaped
// like a GUID@realm value are sent to getImsAdminProfile, so a legacy plain email/name/'system'
// value already stored in the column is left untouched and returned as-is.
const IMS_ID_RE = /^[A-Za-z0-9]+@(AdobeID|AdobeOrg|Email|AdobeServices|[0-9a-fA-F]{16,40}(?:\.[a-z])?)$/;
const IMS_ENRICH_BATCH_SIZE = 5;

const MAX_EXCLUSION_GLOBS = 200;
const MAX_MANUAL_URLS = 2000;
const MAX_ELEMENT_LEN = 2048;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_NOTE_LEN = 2000;
const MAX_REASON_LEN = 2000;
// 40000 (transaction_rollback) is the code this RPC actually raises today (PostgREST v14.4,
// pinned by mysticat-data-service, hangs on 40001/serialization_failure due to hasql-transaction's
// auto-retry on that specific code - PostgREST/postgrest#3673). 40001 is accepted too so this
// mapping keeps working if a future PostgREST upgrade lets the RPC use the more conventional code.
const SQLSTATE_VERSION_CONFLICT = ['40000', '40001'];
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
// Cursor versions above this are rejected as malformed — guards against a tampered/garbage
// cursor (e.g. Number.MAX_SAFE_INTEGER) being fed straight into `.lt('version', cursor)` and
// producing a misleading empty page far past the data. `version` increments by 1 per write, so
// even a very actively-written policy is nowhere near this bound.
const MAX_CURSOR_VERSION = 1_000_000;

// Resolves false (not throw) when the caller's x-product header doesn't match productCode,
// so the ASO/LLMO OR-check below can still try the other product.
async function hasProductAccess(ac, site, productCode) {
  try {
    return await ac.hasAccess(site, '', productCode);
  } catch (e) {
    if (e instanceof UnauthorizedProductError) {
      return false;
    }
    throw e;
  }
}

// Returns the decoded version, or null when `c` is malformed/out-of-range. Callers must
// distinguish "no cursor supplied" from "invalid cursor supplied" themselves via hasText(c).
function decodeCursor(c) {
  const v = Number.parseInt(Buffer.from(c, 'base64url').toString('utf8'), 10);
  return Number.isInteger(v) && v >= 0 && v <= MAX_CURSOR_VERSION ? v : null;
}

function encodeCursor(version) {
  return Buffer.from(String(version), 'utf8').toString('base64url');
}

// Cursor for the scope page list encodes the last row's `url` string (opaque base64url) -
// distinct from the version-int cursor above. `Buffer.from(c, 'base64url')` does not throw
// on malformed input - it decodes leniently to garbage bytes - so validity is checked by
// re-encoding the decoded value and comparing it back to the original string. Callers must
// distinguish "no cursor supplied" from "invalid cursor supplied" themselves via hasText(c).
function decodePageCursor(c) {
  const decoded = Buffer.from(c, 'base64url').toString('utf8');
  if (!hasText(decoded) || Buffer.from(decoded, 'utf8').toString('base64url') !== c) {
    return null;
  }
  return decoded;
}

function encodePageCursor(url) {
  return Buffer.from(String(url), 'utf8').toString('base64url');
}

// Guards against a fulfilled-but-nullish IMS profile (a not-found/deactivated user that resolves
// empty rather than throwing). Without the guard, destructuring null throws inside the batch
// forEach, escapes to the outer catch, and abandons every remaining batch on the page.
function displayName(profile) {
  if (!profile) {
    return null;
  }
  const { first_name: firstName, last_name: lastName, email } = profile;
  const name = [firstName, lastName].filter(hasText).join(' ');
  return name || email || null;
}

// Resolves IMS-GUID updated_by values to a human-readable display name/email, batched to cap
// IMS concurrency. Non-GUID values (legacy plain email/name/'system') pass through unresolved.
// Fails silently per-lookup (and as a whole if imsClient is unavailable) so the caller always
// gets a response even when IMS is unreachable.
async function resolveUpdatedByIdentities(context, rows) {
  const { imsClient, log } = context;
  const map = new Map();
  if (!imsClient) {
    return map;
  }
  const userIds = [...new Set(
    rows.map((row) => row.updated_by).filter((id) => id && IMS_ID_RE.test(id)),
  )];
  if (!userIds.length) {
    return map;
  }
  try {
    for (let i = 0; i < userIds.length; i += IMS_ENRICH_BATCH_SIZE) {
      const batch = userIds.slice(i, i + IMS_ENRICH_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(batch.map((id) => imsClient.getImsAdminProfile(id)));
      results.forEach((result, j) => {
        if (result.status === 'fulfilled') {
          map.set(batch[j], displayName(result.value));
        } else {
          log?.warn?.(`audit-policy revision: failed to resolve IMS profile for author: ${result.reason?.message}`);
        }
      });
    }
  } catch (e) {
    log?.warn?.(`audit-policy revision: could not resolve author identities: ${e.message}`);
  }
  return map;
}

function getAuthor(context) {
  const profile = context.attributes?.authInfo?.getProfile?.();
  const identity = profile?.email || profile?.name;
  if (!identity) {
    context.log?.warn?.('audit-policy write has no authenticated identity; attributing to "system"');
    return 'system';
  }
  return identity;
}

export default function AuditPolicyController() {
  // Resolve site + client + read access.
  // Returns { error } on failure, else { site, siteId, client }.
  async function authorizeRead(context) {
    const { siteId } = context.params || {};
    if (!isValidUUID(siteId)) {
      return { error: badRequest('siteId is required and must be a UUID') };
    }
    const site = await context.dataAccess.Site.findById(siteId);
    if (!site) {
      return { error: notFound(`Site not found: ${siteId}`) };
    }
    const client = context.dataAccess.services?.postgrestClient;
    if (!client?.from) {
      return { error: internalServerError('PostgREST client is not available') };
    }
    const ac = AccessControlUtil.fromContext(context);
    if (!await ac.hasAccess(site)) {
      return { error: forbidden('Only users belonging to the organization can access the audit policy') };
    }
    return {
      site, siteId, client, ac,
    };
  }

  async function getPolicy(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const { data, error } = await client
      .from(POLICY_TABLE).select('*').eq('site_id', siteId).maybeSingle();
    if (error) {
      context.log?.error?.(`audit-policy getPolicy failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to read audit policy');
    }
    if (!data) {
      return ok(AuditPolicyDto.defaultDocument(siteId));
    }
    return ok(AuditPolicyDto.toJSON(data));
  }

  const RESOURCE_CONFIG = {
    exclusions: { field: 'exclusionGlobs', max: MAX_EXCLUSION_GLOBS },
    inclusions: { field: 'manualUrls', max: MAX_MANUAL_URLS },
  };

  // returns a string error message, or null when valid. `maxValues` rejects an
  // oversized `values` array up front, before the per-element scan below and
  // before any read/compute work - the post-computeNewArray cap check alone
  // still lets an attacker force a large parse/validate/Set-allocate cycle.
  function validateMutateBody(b, maxValues) {
    if (!isObject(b)) {
      return 'request body must be a JSON object';
    }
    if (!Array.isArray(b.values) || b.values.length === 0) {
      return 'values must be a non-empty array';
    }
    if (b.values.length > maxValues) {
      return `values array exceeds the maximum of ${maxValues} entries`;
    }
    if (b.values.some((s) => typeof s !== 'string' || s.length > MAX_ELEMENT_LEN)) {
      return `values entries must be strings <= ${MAX_ELEMENT_LEN} chars`;
    }
    if (!hasText(b.reason) || b.reason.length > MAX_REASON_LEN) {
      return `reason is required and must be <= ${MAX_REASON_LEN} chars`;
    }
    if (b.note !== undefined && b.note !== null
      && (typeof b.note !== 'string' || b.note.length > MAX_NOTE_LEN)) {
      return `note must be a string <= ${MAX_NOTE_LEN} chars`;
    }
    return null;
  }

  // Catches literal '../' and '..\', plus percent-encoded forms (e.g. '..%2f') by also
  // checking the decoded value. Malformed % escapes fall back to the raw-value check only -
  // decodeURIComponent failing isn't itself evidence of traversal.
  function containsPathTraversal(v) {
    let decoded = v;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      // leave decoded === v
    }
    return [v, decoded].some((s) => s.includes('../') || s.includes('..\\'));
  }

  // add = set-union (preserves existing order, appends new values in call order);
  // remove = set-difference. Both are no-ops for elements already in the target state,
  // which is what makes retrying this operation safe (§3.2 of the design doc).
  function computeNewArray(currentArray, values, mode) {
    if (mode === 'add') {
      return [...new Set([...currentArray, ...values])];
    }
    const removeSet = new Set(values);
    return currentArray.filter((v) => !removeSet.has(v));
  }

  async function mutateArray(context, resourceKey, mode) {
    const config = RESOURCE_CONFIG[resourceKey];
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    const {
      site, siteId, client, ac,
    } = auth;

    const aso = await hasProductAccess(ac, site, 'ASO');
    const hasWriteEntitlement = aso || await hasProductAccess(ac, site, 'LLMO');
    if (!hasWriteEntitlement) {
      return forbidden('Editing the audit policy requires ASO or LLMO entitlement for this site');
    }

    const body = context.data || {};
    const invalid = validateMutateBody(body, config.max);
    if (invalid) {
      return badRequest(invalid);
    }
    // Only the add path introduces new content the downstream audit engine will evaluate;
    // remove is a pure set-difference filter, so a stored '../' value is harmless there and
    // must stay removable (a caller cleaning up a value written before this check existed
    // shouldn't be blocked from doing so).
    if (resourceKey === 'exclusions' && mode === 'add' && body.values.some(containsPathTraversal)) {
      return badRequest("exclusionGlobs entries must not contain path-traversal sequences ('../')");
    }

    const attempt = async (remainingAttempts) => {
      const { data: row, error: selectError } = await client
        .from(POLICY_TABLE).select('*').eq('site_id', siteId).maybeSingle();
      if (selectError) {
        context.log?.error?.(`audit-policy ${resourceKey} select failed: ${selectError.code} ${selectError.message}`);
        return internalServerError('Failed to read audit policy');
      }
      const current = row ? AuditPolicyDto.toJSON(row) : AuditPolicyDto.defaultDocument(siteId);
      const newArray = computeNewArray(current[config.field], body.values, mode);
      if (newArray.length > config.max) {
        return badRequest(`${config.field} would exceed the maximum of ${config.max}`);
      }

      const { data, error } = await client.rpc(UPSERT_RPC, {
        p_site_id: siteId,
        p_budget: current.budget,
        p_strategy_name: current.strategyName,
        p_exclusion_globs: config.field === 'exclusionGlobs' ? newArray : current.exclusionGlobs,
        p_manual_urls: config.field === 'manualUrls' ? newArray : current.manualUrls,
        p_scope_config: current.scopeConfig,
        p_lifecycle_overrides: current.lifecycleOverrides,
        p_author: getAuthor(context),
        p_reason: body.reason,
        p_note: body.note ?? null,
        p_expected_version: current.version,
      });

      if (!error) {
        return ok(AuditPolicyDto.toJSON(data));
      }
      if (SQLSTATE_VERSION_CONFLICT.includes(error.code)) {
        if (remainingAttempts > 1) {
          return attempt(remainingAttempts - 1);
        }
        const currentVersion = Number.parseInt(error.details, 10);
        return createResponse(
          {
            message: 'policy was modified; retried and failed, reload and retry',
            ...(Number.isInteger(currentVersion) ? { currentVersion } : {}),
          },
          409,
        );
      }
      if (error.code === 'P0001') {
        context.log?.warn?.(`audit-policy ${resourceKey} rejected by RPC validation (P0001): ${error.message}`);
        return badRequest('audit policy rejected by validation');
      }
      context.log?.error?.(`audit-policy ${resourceKey} failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to write audit policy');
    };

    return attempt(MAX_RETRY_ATTEMPTS);
  }

  const addExclusions = (context) => mutateArray(context, 'exclusions', 'add');
  const removeExclusions = (context) => mutateArray(context, 'exclusions', 'remove');
  const addInclusions = (context) => mutateArray(context, 'inclusions', 'add');
  const removeInclusions = (context) => mutateArray(context, 'inclusions', 'remove');

  async function listRevisions(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const limit = Math.min(
      Math.max(Number.parseInt(context.params?.limit, 10) || DEFAULT_PAGE, 1),
      MAX_PAGE,
    );
    const rawCursor = context.params?.cursor;
    let cursor = null;
    if (hasText(rawCursor)) {
      cursor = decodeCursor(rawCursor);
      if (cursor === null) {
        return badRequest('cursor is invalid or out of range');
      }
    }

    let q = client.from(REVISION_TABLE).select('*').eq('site_id', siteId);
    if (cursor !== null) {
      q = q.lt('version', cursor);
    }
    const { data, error } = await q.order('version', { ascending: false }).limit(limit);
    if (error) {
      context.log?.error?.(`audit-policy listRevisions failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to read audit policy revisions');
    }
    const rows = data || [];
    const identityMap = await resolveUpdatedByIdentities(context, rows);
    const items = rows.map(
      (row) => AuditPolicyRevisionDto.toJSON(row, identityMap.get(row.updated_by)),
    );
    // A full page implies more rows may exist; if the last page happens to contain exactly
    // `limit` rows, the client makes one harmless extra request that returns an empty page.
    const nextCursor = items.length === limit
      ? encodeCursor(items[items.length - 1].version) : undefined;
    return ok({ items, ...(nextCursor ? { cursor: nextCursor } : {}) });
  }

  async function getScopePages(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const limit = Math.min(
      Math.max(Number.parseInt(context.params?.limit, 10) || DEFAULT_PAGE, 1),
      MAX_PAGE,
    );
    const rawCursor = context.params?.cursor;
    let cursor = null;
    if (hasText(rawCursor)) {
      cursor = decodePageCursor(rawCursor);
      if (cursor === null) {
        return badRequest('cursor is invalid or out of range');
      }
    }

    let q = client.from(SCOPE_PAGES_VIEW).select('*').eq('site_id', siteId);
    if (cursor !== null) {
      q = q.gt('url', cursor);
    }
    const { data, error } = await q.order('url', { ascending: true }).limit(limit);
    if (error) {
      context.log?.error?.(`audit-policy getScopePages failed: ${error.code} ${error.message}`);
      return internalServerError('Failed to read audit scope pages');
    }
    const items = (data || []).map(AuditScopePageDto.toJSON);
    const nextCursor = items.length === limit
      ? encodePageCursor(items[items.length - 1].url) : undefined;
    return ok({ items, ...(nextCursor ? { cursor: nextCursor } : {}) });
  }

  async function notImplemented(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    return createResponse({ message: 'Not implemented yet.' }, 501);
  }
  const getScopeSummary = notImplemented;
  const getScopeSections = notImplemented;

  return {
    getPolicy,
    listRevisions,
    addExclusions,
    removeExclusions,
    addInclusions,
    removeInclusions,
    getScopePages,
    getScopeSummary,
    getScopeSections,
  };
}
