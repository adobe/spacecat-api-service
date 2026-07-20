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
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../dto/audit-policy.js';

const POLICY_TABLE = 'audit_policy';
const REVISION_TABLE = 'audit_policy_revision';
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

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

  // returns a string error message, or null when valid
  function validateMutateBody(b) {
    if (!isObject(b)) {
      return 'request body must be a JSON object';
    }
    if (!Array.isArray(b.values) || b.values.length === 0) {
      return 'values must be a non-empty array';
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
    const llmo = aso ? true : await hasProductAccess(ac, site, 'LLMO');
    if (!aso && !llmo) {
      return forbidden('Editing the audit policy requires ASO or LLMO entitlement for this site');
    }

    const body = context.data || {};
    const invalid = validateMutateBody(body);
    if (invalid) {
      return badRequest(invalid);
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
    const items = (data || []).map(AuditPolicyRevisionDto.toJSON);
    // A full page implies more rows may exist; if the last page happens to contain exactly
    // `limit` rows, the client makes one harmless extra request that returns an empty page.
    const nextCursor = items.length === limit
      ? encodeCursor(items[items.length - 1].version) : undefined;
    return ok({ items, ...(nextCursor ? { cursor: nextCursor } : {}) });
  }

  async function notImplemented(context) {
    const auth = await authorizeRead(context);
    if (auth.error) {
      return auth.error;
    }
    return createResponse({ message: 'Not implemented yet.' }, 501);
  }
  const getScopePages = notImplemented;
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
