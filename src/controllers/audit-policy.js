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
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { UnauthorizedProductError } from '../support/errors.js';
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../dto/audit-policy.js';

const POLICY_TABLE = 'audit_policy';
const REVISION_TABLE = 'audit_policy_revision';
// Unused until the granular array-mutation endpoints (add/remove exclusions/inclusions) land in
// a later task of this same plan; kept here rather than deleted so that task can reuse them.
// eslint-disable-next-line no-unused-vars
const UPSERT_RPC = 'wrpc_upsert_audit_policy';

// eslint-disable-next-line no-unused-vars
const MAX_EXCLUSION_GLOBS = 1000;
// eslint-disable-next-line no-unused-vars
const MAX_MANUAL_URLS = 50000;
// eslint-disable-next-line no-unused-vars
const MAX_ELEMENT_LEN = 2048;
// eslint-disable-next-line no-unused-vars
const MAX_NOTE_LEN = 2000;
// eslint-disable-next-line no-unused-vars
const MAX_REASON_LEN = 2000;
// 40000 (transaction_rollback) is the code this RPC actually raises today (PostgREST v14.4,
// pinned by mysticat-data-service, hangs on 40001/serialization_failure due to hasql-transaction's
// auto-retry on that specific code - PostgREST/postgrest#3673). 40001 is accepted too so this
// mapping keeps working if a future PostgREST upgrade lets the RPC use the more conventional code.
// eslint-disable-next-line no-unused-vars
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
// Unused until a later task's write endpoints call it again.
// eslint-disable-next-line no-unused-vars
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

// Unused until a later task's write endpoints call it again.
// eslint-disable-next-line no-unused-vars
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
    getPolicy, listRevisions, getScopePages, getScopeSummary, getScopeSections,
  };
}
