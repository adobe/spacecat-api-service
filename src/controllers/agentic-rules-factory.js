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
  badRequest, created, createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText, isArray, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { AgenticRuleDto } from '../dto/agentic-rule.js';
import { regexFromUrls, validateUserRegex, toComparablePath } from '../support/regex-from-urls.js';

/**
 * Factory for site-scoped customer-edit endpoints over an auto-derived URL
 * classification table. Both `agentic_url_category_rules` and
 * `agentic_url_page_type_rules` share the same shape; controllers diverge
 * only by table name and human-readable label.
 *
 * Source semantics (DB CHECK allows only `ai` | `human`).
 * `derivation_method`: NULL or one of `llm`, `common-prefix`, `universal-token`,
 * `disjoint-cover`, `literal-fallback`, `customer`.
 */

const SOURCE_HUMAN = 'human';
const DERIVATION_CUSTOMER = 'customer';
const STATUS_ACTIVE = 'active';
const STATUS_DELETED = 'deleted';

// Input ceilings mirror the OpenAPI contract; enforced server-side.
const MAX_SAMPLE_URLS = 50;
const MAX_URL_LEN = 2048;
const MAX_NAME_LEN = 200;
// Hard ceiling on total active rules per site+dimension (auto + customer).
// Enforced on the create endpoint only; the DB itself is uncapped.
const MAX_ACTIVE_RULES_PER_SITE = 20;
// Defensive cap on the active-rule scans (list + cross-rule dedup).
const MAX_ACTIVE_RULES_SCAN = 1000;

// Valid entry: an absolute path ("/en/home") or a self-contained http(s) URL
// ("https://example.com/en/home"). Whitespace/control chars and backslashes are
// screened first (URL parsing would silently percent-encode or rewrite them);
// protocol-relative "//host" and non-http schemes are rejected.
function isValidSampleUrl(u) {
  if (!hasText(u) || u.length > MAX_URL_LEN) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(u)) {
    return false;
  }
  // A backslash (char 92) has no place in these values; the URL parser would
  // rewrite it to a slash, letting "/\host" masquerade as a path.
  if (u.includes(String.fromCharCode(92))) {
    return false;
  }
  if (u.startsWith('/')) {
    // Absolute path, but not a protocol-relative "//host" reference.
    return !u.startsWith('//');
  }
  // Not a path — require a self-contained http(s) URL. No base here on purpose:
  // bare tokens ("a;b;c", "products/x") throw and are rejected rather than being
  // silently reinterpreted as a path.
  try {
    const { protocol } = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidUrlListBody(urls) {
  return isArray(urls)
    && urls.length > 0
    && urls.length <= MAX_SAMPLE_URLS
    && urls.every(isValidSampleUrl);
}

const URL_LIST_ERROR = `urls must be a non-empty array of at most ${MAX_SAMPLE_URLS} entries, each an absolute path (e.g. "/en/home") or a full http(s) URL, at most ${MAX_URL_LEN} characters`;

// The router stores path segments raw (route-utils.js leaves them URL-encoded),
// so a rule name with spaces/special chars arrives as e.g. 'Blog%20Posts'.
// Decode it before querying by name, or PATCH/DELETE can never match the row.
function decodeRuleName(context) {
  const raw = context.params?.name;
  if (!hasText(raw)) {
    return { error: badRequest('rule name is required') };
  }
  try {
    return { name: decodeURIComponent(raw) };
  } catch {
    return { error: badRequest('rule name is not valid') };
  }
}

// Identity from the IMS Bearer token. authorize() gates on hasAccess(), so the
// 'system' fallback should be unreachable — warn if it fires.
function getUserIdentifier(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.();
  const identity = profile?.email || profile?.name;
  if (!identity) {
    context.log?.warn?.('agentic-rule mutation has no authenticated user identity; attributing to "system"');
    return 'system';
  }
  return identity;
}

// Normalize for cross-rule dedup through the SAME extract→strip-locale pipeline
// derivation uses, so two URLs that derive the same regex are detected as a
// conflict regardless of scheme/host/locale/extension (e.g. "/products/a",
// "https://x/products/a", "/en-us/products/a" all collapse to one key).
// Comparison only — the stored sample_urls keep their original form.
const normalizeUrl = toComparablePath;

/**
 * Scan the site+dimension's active rules: returns the cross-rule sample-URL
 * conflict (if any) and the active rule count (for the per-site cap).
 * Note: this is a read-then-write check — two concurrent writers can still
 * race past it. Acceptable for v1 (low write rate); revisit with a DB
 * constraint if it becomes a real problem.
 */
async function findSampleUrlConflict(client, tableName, siteId, urls, excludeName) {
  const { data, error } = await client
    .from(tableName)
    .select('name,sample_urls')
    .eq('site_id', siteId)
    .eq('status', STATUS_ACTIVE)
    .limit(MAX_ACTIVE_RULES_SCAN);
  if (error) {
    return { error };
  }
  // rules serves both purposes: dedup (the owners map) and the per-site cap
  // (rules.length below).
  const rules = data || [];
  const owners = new Map();
  rules.forEach((rule) => {
    if (rule.name === excludeName) {
      return;
    }
    (rule.sample_urls || []).forEach((u) => owners.set(normalizeUrl(u), rule.name));
  });
  const conflict = urls
    .map((u) => ({ url: u, owner: owners.get(normalizeUrl(u)) }))
    .find((c) => c.owner);
  return { conflict, ruleCount: rules.length };
}

/**
 * Create a rules controller bound to a specific table.
 * @param {object} params
 * @param {string} params.tableName - PostgREST table name.
 * @param {string} params.dimensionLabel - Human-readable label, e.g. 'category'.
 * @returns {object} Object with method handlers.
 */
export function createRulesController({ tableName, dimensionLabel }) {
  if (!hasText(tableName) || !hasText(dimensionLabel)) {
    throw new Error('tableName and dimensionLabel are required');
  }

  // `requireAdmin` gates mutations (create/update/delete) behind the LLMO-admin
  // claim, matching every sibling LLMO customer-edit endpoint; reads only need
  // org membership. hasAccess() must precede isLLMOAdministrator() so the
  // delegation-aware check works (see llmo.js convention).
  async function authorize(context, { requireAdmin = false } = {}) {
    const { siteId } = context.params || {};
    if (!isValidUUID(siteId)) {
      return { error: badRequest('Site ID required') };
    }
    if (!isNonEmptyObject(context.dataAccess)) {
      return { error: internalServerError('Data access not available') };
    }
    const client = context.dataAccess.services?.postgrestClient;
    if (!client?.from) {
      return { error: internalServerError('PostgREST client is not available') };
    }
    const { Site } = context.dataAccess;
    const site = await Site.findById(siteId);
    if (!site) {
      return { error: notFound('Site not found') };
    }
    const ac = AccessControlUtil.fromContext(context);
    if (!await ac.hasAccess(site)) {
      return { error: forbidden(`Only users belonging to the organization can manage ${dimensionLabel} rules`) };
    }
    if (requireAdmin && !ac.isLLMOAdministrator()) {
      return { error: forbidden(`Only LLMO administrators can modify ${dimensionLabel} rules`) };
    }
    return { siteId, client };
  }

  function logAndFail(context, err, action) {
    /* c8 ignore next -- err.message is always populated by callers */
    const msg = err?.message || 'unknown error';
    context.log?.error?.(`Failed to ${action} ${dimensionLabel} rule (code=${err?.code ?? 'n/a'}): ${msg}`);
    // PostgREST surfaces the Postgres unique-violation SQLSTATE (23505) when a
    // rule name collides with the UNIQUE (site_id, name) constraint. Map it to a
    // 409 with an actionable message instead of an opaque 500.
    if (err?.code === '23505') {
      return createResponse(
        { message: `A ${dimensionLabel} rule with that name already exists` },
        409,
      );
    }
    return internalServerError(`Failed to ${action} ${dimensionLabel} rule`);
  }

  /** GET /sites/:siteId/agentic-{dimension} */
  async function list(context) {
    const auth = await authorize(context);
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    // v1 has no cursor; bound the scan so it can't return unbounded rows.
    const { data, error } = await client
      .from(tableName)
      .select('*')
      .eq('site_id', siteId)
      .eq('status', STATUS_ACTIVE)
      .limit(MAX_ACTIVE_RULES_SCAN)
      .order('sort_order', { ascending: true });
    if (error) {
      return logAndFail(context, error, 'list');
    }
    const items = (data || []).map(AgenticRuleDto.toJSON);
    // No cursor in v1: warn if we hit the cap so silent truncation is visible.
    if (items.length === MAX_ACTIVE_RULES_SCAN) {
      context.log?.warn?.(`${dimensionLabel} rule list truncated at ${MAX_ACTIVE_RULES_SCAN} for site ${siteId}`);
    }
    return ok({ items });
  }

  /** POST /sites/:siteId/agentic-{dimension} */
  async function create(context) {
    const auth = await authorize(context, { requireAdmin: true });
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const body = context.data || {};
    // Trim so whitespace can't create "invisible" name conflicts.
    const name = hasText(body.name) ? body.name.trim() : '';
    if (!name) {
      return badRequest('name is required');
    }
    if (name.length > MAX_NAME_LEN) {
      return badRequest(`name must be at most ${MAX_NAME_LEN} characters`);
    }
    if (!isValidUrlListBody(body.urls)) {
      return badRequest(URL_LIST_ERROR);
    }
    let derived;
    try {
      derived = regexFromUrls(body.urls);
    } catch (err) {
      return badRequest(err.message);
    }
    context.log?.info?.(`regexFromUrls result: method=${derived.method} regex=${derived.regex} evidence=${derived.evidence}`);

    const dedup = await findSampleUrlConflict(client, tableName, siteId, body.urls);
    if (dedup.error) {
      return logAndFail(context, dedup.error, 'create');
    }
    if (dedup.ruleCount >= MAX_ACTIVE_RULES_PER_SITE) {
      return createResponse(
        { message: `Site has reached the maximum of ${MAX_ACTIVE_RULES_PER_SITE} active ${dimensionLabel} rules` },
        409,
      );
    }
    if (dedup.conflict) {
      return createResponse(
        { message: `URL "${dedup.conflict.url}" already belongs to ${dimensionLabel} rule "${dedup.conflict.owner}"` },
        409,
      );
    }

    const identity = getUserIdentifier(context);
    const row = {
      site_id: siteId,
      name,
      regex: derived.regex,
      source: SOURCE_HUMAN,
      sample_urls: body.urls,
      derivation_method: DERIVATION_CUSTOMER,
      // created_by is set once here; update()/remove() only touch updated_by so
      // the original author survives later edits by a different user.
      created_by: identity,
      updated_by: identity,
    };
    const { data, error } = await client
      .from(tableName)
      .insert(row)
      .select()
      .maybeSingle();
    if (error) {
      return logAndFail(context, error, 'create');
    }
    // maybeSingle() resolves to null (no error) when the INSERT returns zero rows
    // — e.g. an RLS filter excludes the row. Do not report success in that case.
    if (!data) {
      return internalServerError(`Failed to create ${dimensionLabel} rule`);
    }
    return created(AgenticRuleDto.toJSON(data));
  }

  /**
   * PATCH /sites/:siteId/agentic-{dimension}/:name
   * Body may include `newName`, `urls`, `newRegex`.
   */
  async function update(context) {
    const auth = await authorize(context, { requireAdmin: true });
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const decoded = decodeRuleName(context);
    if (decoded.error) {
      return decoded.error;
    }
    const { name } = decoded;
    const body = context.data || {};
    const hasNewName = body.newName !== undefined;
    const hasUrls = body.urls !== undefined;
    const hasNewRegex = body.newRegex !== undefined;
    if (hasUrls && hasNewRegex) {
      return badRequest('provide either urls or newRegex, not both');
    }
    // Reject an empty patch. Without this, a PATCH {} would silently set only
    // source='human' — laundering an ai rule's provenance with no content change.
    if (!hasNewName && !hasUrls && !hasNewRegex) {
      return badRequest('at least one of newName, urls, or newRegex is required');
    }
    const newName = hasNewName && hasText(body.newName) ? body.newName.trim() : '';
    if (hasNewName && !newName) {
      return badRequest('newName must be a non-empty string');
    }
    if (hasNewName && newName.length > MAX_NAME_LEN) {
      return badRequest(`newName must be at most ${MAX_NAME_LEN} characters`);
    }

    const fetched = await client
      .from(tableName)
      .select('*')
      .eq('site_id', siteId)
      .eq('name', name)
      .eq('status', STATUS_ACTIVE)
      .maybeSingle();
    if (fetched.error) {
      return logAndFail(context, fetched.error, 'update');
    }
    if (!fetched.data) {
      return notFound(`${dimensionLabel} rule not found`);
    }

    const patch = { source: SOURCE_HUMAN, updated_by: getUserIdentifier(context) };
    if (hasNewName) {
      patch.name = newName;
    }
    if (hasUrls) {
      if (!isValidUrlListBody(body.urls)) {
        return badRequest(URL_LIST_ERROR);
      }
      const dedup = await findSampleUrlConflict(client, tableName, siteId, body.urls, name);
      if (dedup.error) {
        return logAndFail(context, dedup.error, 'update');
      }
      if (dedup.conflict) {
        return createResponse(
          { message: `URL "${dedup.conflict.url}" already belongs to ${dimensionLabel} rule "${dedup.conflict.owner}"` },
          409,
        );
      }
      try {
        const derived = regexFromUrls(body.urls);
        context.log?.info?.(`regexFromUrls result: method=${derived.method} regex=${derived.regex} evidence=${derived.evidence}`);
        patch.regex = derived.regex;
        patch.sample_urls = body.urls;
        patch.derivation_method = DERIVATION_CUSTOMER;
      } catch (err) {
        return badRequest(err.message);
      }
    }
    if (hasNewRegex) {
      try {
        patch.regex = validateUserRegex(body.newRegex);
        patch.derivation_method = DERIVATION_CUSTOMER;
      } catch (err) {
        return badRequest(err.message);
      }
    }

    const { data, error } = await client
      .from(tableName)
      .update(patch)
      .eq('site_id', siteId)
      .eq('name', name)
      .eq('status', STATUS_ACTIVE)
      .select()
      .maybeSingle();
    if (error) {
      return logAndFail(context, error, 'update');
    }
    if (!data) {
      return notFound(`${dimensionLabel} rule not found`);
    }
    return ok(AgenticRuleDto.toJSON(data));
  }

  /**
   * DELETE /sites/:siteId/agentic-{dimension}/:name
   * Soft delete: flip status to 'deleted' and stamp who, retaining the row for
   * audit. The active-rows partial unique index lets the name be re-created.
   */
  async function remove(context) {
    const auth = await authorize(context, { requireAdmin: true });
    if (auth.error) {
      return auth.error;
    }
    const { siteId, client } = auth;
    const decoded = decodeRuleName(context);
    if (decoded.error) {
      return decoded.error;
    }
    const { name } = decoded;
    const { data, error } = await client
      .from(tableName)
      .update({ status: STATUS_DELETED, updated_by: getUserIdentifier(context) })
      .eq('site_id', siteId)
      .eq('name', name)
      .eq('status', STATUS_ACTIVE)
      .select()
      .maybeSingle();
    if (error) {
      return logAndFail(context, error, 'delete');
    }
    if (!data) {
      return notFound(`${dimensionLabel} rule not found`);
    }
    return ok({ deleted: true, name });
  }

  return {
    list, create, update, remove,
  };
}

export default createRulesController;
