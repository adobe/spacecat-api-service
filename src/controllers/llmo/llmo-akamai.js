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
  ok, badRequest, notFound, forbidden, unauthorized, internalServerError, createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import AkamaiClient, {
  normalizeDomain, defaultRuleHasCaching, getDefaultOriginSsl,
} from '@adobe/spacecat-shared-akamai-client';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  buildRuleConfig, mergeIntoTree, managedRuleNames, redactApiKey,
} from './llmo-akamai-utils.js';

// EdgeGrid credentials are CLIENT-SUPPLIED per request (never persisted, never logged): the caller
// passes them as headers, mirroring the Cloudflare controller's x-cloudflare-token model, and we
// build a fresh AkamaiClient from them for each call. Unlike Cloudflare's single bearer token,
// EdgeGrid needs four values (+ an optional account-switch key), so each maps to its own header.
const CRED_HEADERS = Object.freeze({
  host: 'x-akamai-host',
  clientToken: 'x-akamai-client-token',
  clientSecret: 'x-akamai-client-secret',
  accessToken: 'x-akamai-access-token',
  accountSwitchKey: 'x-akamai-account-switch-key', // optional
});
// The four EdgeGrid values required to sign any PAPI request. accountSwitchKey is optional and
// notifyEmails (needed only to activate) is not a credential, so it travels in the request body.
const REQUIRED_CRED_KEYS = ['host', 'clientToken', 'clientSecret', 'accessToken'];

const NETWORKS = ['STAGING', 'PRODUCTION'];

// Akamai activation statuses that mean the submit actually succeeded (in flight or already live).
// Used to recover from an activate POST that errored client-side — the PAPI activation call
// regularly exceeds the client request timeout on large rule trees (Akamai re-validates the whole
// tree), and a retry then returns `422 already-activated`; in BOTH cases Akamai has already QUEUED
// the activation, so we report success and let the UI poll instead of showing a false failure.
const IN_FLIGHT_ACTIVATION_STATUSES = new Set([
  'NEW', 'PENDING', 'ZONE_1', 'ZONE_2', 'ZONE_3', 'ACTIVE',
]);

// Akamai PAPI identifiers. Boundary validation (defense-in-depth): the shared client also encodes
// these into the path, but rejecting a malformed id here gives the caller a clean 400 instead of a
// 502 from PAPI.
const PROPERTY_ID_RE = /^prp_[A-Za-z0-9]+$/;
const CONTRACT_ID_RE = /^ctr_[A-Za-z0-9-]+$/;
const GROUP_ID_RE = /^grp_[A-Za-z0-9]+$/;
const ACTIVATION_ID_RE = /^atv_[A-Za-z0-9]+$/;
// A *real* Akamai activation id is numeric (atv_20135679). A just-queued activation can appear in
// the activations list before Akamai assigns its id — the placeholder serializes as "atv_null",
// which passes ACTIVATION_ID_RE but is not pollable. Use this stricter check when recovering an id
// so we never hand the UI an unpollable placeholder (it polls by network until a real id appears).
const REAL_ACTIVATION_ID_RE = /^atv_[0-9]+$/;
// SSRF guard: the client builds `https://${host}/...` from x-akamai-host, so restrict it to Akamai
// EdgeGrid hosts. The `.akamaiapis.net` suffix + this charset reject IP literals, ports (no ':'),
// and paths (no '/'), so a caller cannot point server-side requests at an arbitrary host.
const AKAMAI_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.akamaiapis\.net$/i;
// Account switch keys look like "1-ABCDEF" / "1-ABCDEF:1-2GHIJ"; validate so a malformed value
// fails cleanly here instead of as a raw upstream 4xx.
const ACCOUNT_SWITCH_KEY_RE = /^[A-Za-z0-9:_-]+$/;
// Numeric fields from the JSON body must be decimal-integer strings/numbers. Number() alone accepts
// true->1, "0x10"->16, "1e3"->1000, ["5"]->5, so gate on this before converting.
const DECIMAL_INT_RE = /^[0-9]+$/;

/**
 * Identifies the API caller for audit logging. profile.email is an IMS user GUID (see
 * access-control-util.js), not an RFC-5322 address. Returns 'unknown' when unavailable.
 */
const getCallerId = (context) => context?.attributes?.authInfo?.getProfile?.()?.email || 'unknown';

/**
 * The authenticated caller's human-readable email, used server-side as the Akamai activation
 * notification address. Prefer trial_email (present for trial users), then preferred_username
 * (the RFC-5322 address on enterprise/IMS tokens); profile.email is an IMS user GUID, not a real
 * address, so it is only a last resort. Returns null when no usable address is present.
 */
const getCallerEmail = (context) => {
  const profile = context?.attributes?.authInfo?.getProfile?.() || {};
  const candidate = [profile.trial_email, profile.preferred_username, profile.email]
    .find((v) => hasText(v));
  return candidate ? candidate.trim() : null;
};

/**
 * Builds a single greppable audit line for Akamai onboarding operations, mirroring the Cloudflare
 * controller's [llmo-cf] format. Every line carries action, outcome, caller, and requestId so an
 * operation can be correlated end-to-end in Splunk; `fields` adds operation-specific identifiers.
 */
const auditLine = (context, action, outcome, fields = {}) => {
  const entries = {
    action,
    outcome,
    caller: getCallerId(context),
    requestId: context?.invocation?.id || 'unknown',
    ...fields,
  };
  const fmt = (v) => {
    const s = String(v);
    return /\s/.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
  };
  const kv = Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ');
  return `[llmo-akamai] ${kv}`;
};

/**
 * Controller for the Akamai "Optimize at Edge" onboarding wizard. Mirrors the structure of the
 * Cloudflare/CloudFront onboarding controllers: it owns the multi-step control-plane flow the LLMO
 * UI uses to wire a customer's Akamai property (via Property Manager / PAPI) to Edge Optimize —
 * find property → plan (dry-run merge) → deploy (new version + rules) → activate → poll status.
 * Every endpoint is gated on site access + LLMO admin. EdgeGrid credentials are client-supplied
 * per request via x-akamai-* headers (never persisted, never logged), mirroring the Cloudflare
 * controller's x-cloudflare-token model.
 */
function LlmoAkamaiController(ctx) {
  const { log } = ctx;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getSiteAndCheckAccess = async (context) => {
    const { siteId } = context.params;
    const { dataAccess } = context;
    const { Site } = dataAccess;

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound(`Site not found: ${siteId}`);
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }
    if (!accessControlUtil.isLLMOAdministrator()) {
      return forbidden('Only LLMO administrators can access Akamai onboarding endpoints');
    }
    return { site };
  };

  /**
   * Extracts the client-supplied EdgeGrid credentials from the request headers. These are held in
   * memory for the duration of the request only — never persisted and never logged (audit lines
   * and error responses below deliberately omit them).
   * @returns {{host?, clientToken?, clientSecret?, accessToken?, accountSwitchKey?}}
   */
  const getCredentials = (context) => {
    const headers = context?.pathInfo?.headers || {};
    const creds = {};
    Object.entries(CRED_HEADERS).forEach(([key, header]) => {
      const value = headers[header];
      if (hasText(value)) {
        creds[key] = value.trim();
      }
    });
    return creds;
  };

  /**
   * Builds a per-request AkamaiClient from the caller's EdgeGrid credential headers, or a
   * badRequest when a required credential header is missing. `notifyEmails` (not a credential) is
   * only needed to activate() and is threaded through from the request body.
   * @returns {{ client: AkamaiClient } | { error: Response }}
   */
  const requireClient = (context, { notifyEmails } = {}) => {
    const creds = getCredentials(context);
    const missing = REQUIRED_CRED_KEYS.filter((key) => !hasText(creds[key]));
    if (missing.length > 0) {
      return {
        error: badRequest(
          `Missing Akamai EdgeGrid credential header(s): ${missing.map((k) => CRED_HEADERS[k]).join(', ')}`,
        ),
      };
    }
    // SSRF guard: reject anything that is not an Akamai EdgeGrid host before it reaches the client
    // (which would otherwise issue a signed request to `https://${host}/...`).
    if (!AKAMAI_HOST_RE.test(creds.host)) {
      return { error: badRequest(`${CRED_HEADERS.host} must be an Akamai EdgeGrid host (*.akamaiapis.net)`) };
    }
    if (hasText(creds.accountSwitchKey) && !ACCOUNT_SWITCH_KEY_RE.test(creds.accountSwitchKey)) {
      return { error: badRequest(`${CRED_HEADERS.accountSwitchKey} contains invalid characters`) };
    }
    try {
      return { client: new AkamaiClient({ ...creds, notifyEmails }, log) };
    } catch (e) {
      // The constructor re-validates the required keys; after the checks above this is unexpected.
      // Log the error name only (not the message, which can echo credential-derived detail) and
      // return a generic message to the caller.
      log.error(`AkamaiClient construction failed: ${e.name}`);
      return { error: badRequest('Invalid Akamai credentials') };
    }
  };

  /**
   * Maps an error thrown by AkamaiClient to an appropriate HTTP response. PAPI calls are external
   * network calls, so failures are routine: we log the cause and surface a sanitized,
   * status-appropriate response instead of an unstructured 500. AkamaiClient error messages carry
   * the upstream status as "-> <status>:" (see akamai-client.js #request).
   */
  const papiErrorResponse = (error, action, context, fields = {}) => {
    const message = error?.message || String(error);
    log.error(auditLine(context, 'papi-call', 'error', { op: action, ...fields, error: message }));
    // Read the status from the "-> <status>:" token the client emits right after the path, not by
    // scanning the whole string: the response body (up to 1000 chars) can itself contain a
    // "-> 404" and mis-map a genuine 5xx. Take the FIRST such token, which is the real status.
    const status = Number(message.match(/-> (\d{3}):/)?.[1]);
    // Surface a version the operation may have already created before a later call threw (e.g.
    // deploy created a new version, then updateRuleTree failed) so the caller can find/clean it up.
    const extra = fields.newVersion !== undefined ? { newVersion: fields.newVersion } : {};
    if (status === 401) {
      return unauthorized('Akamai authentication failed');
    }
    if (status === 403) {
      return forbidden('Akamai authorization failed');
    }
    if (status === 404) {
      // A missing property/version/activation is a caller-addressable 404, not an upstream fault.
      return notFound(`Akamai ${action} target not found`);
    }
    if (status === 429) {
      return createResponse({ message: 'Akamai rate limit exceeded', ...extra }, 429);
    }
    return createResponse({ message: `Akamai ${action} failed`, ...extra }, 502);
  };

  // The LLMO API key is a CONFIDENTIAL string: it is injected into the managed rule tree
  // (x-edgeoptimize-api-key) and sent to Akamai at deploy, but it must never be logged or returned
  // to a client. Never put the resolved key, the config, or the un-redacted merged tree into a log
  // line or response (plan redacts it via redactApiKey; audit lines carry only ids/versions).
  const getLlmoApiKey = async (site, context) => {
    const tokowaka = TokowakaClient.createFrom(context);
    const metaconfig = await tokowaka.fetchMetaconfig(site.getBaseURL());
    return metaconfig?.apiKeys?.[0] ?? null;
  };

  const siteHostname = (site) => {
    try {
      return normalizeDomain(new URL(site.getBaseURL()).hostname);
    } catch {
      return null;
    }
  };

  /**
   * Validates the (propertyId, contractId, groupId) triple present in the request body/query.
   * @returns {{ ref: {propertyId, contractId, groupId} } | { error: Response }}
   */
  const requirePropertyRef = (context) => {
    const { propertyId, contractId, groupId } = context.data || {};
    if (!hasText(propertyId) || !PROPERTY_ID_RE.test(propertyId)) {
      return { error: badRequest('propertyId is required and must look like prp_<id>') };
    }
    if (!hasText(contractId) || !CONTRACT_ID_RE.test(contractId)) {
      return { error: badRequest('contractId is required and must look like ctr_<id>') };
    }
    if (!hasText(groupId) || !GROUP_ID_RE.test(groupId)) {
      return { error: badRequest('groupId is required and must look like grp_<id>') };
    }
    return { ref: { propertyId, contractId, groupId } };
  };

  /**
   * Validates the optional insertIndex, consistent with how `version` is validated in activate.
   * mergeIntoTree already clamps/truncates it, but rejecting a malformed value here gives the
   * caller a clean 400 instead of silently coercing garbage to 0.
   * @returns {Response|null} a badRequest to block, or null when absent/valid
   */
  const validateInsertIndex = (insertIndex) => {
    if (insertIndex === undefined || insertIndex === null || insertIndex === '') {
      return null;
    }
    // Require a decimal-integer literal: Number() would otherwise accept true, "0x10", "1e3".
    if (!DECIMAL_INT_RE.test(String(insertIndex))) {
      return badRequest('insertIndex must be a non-negative integer');
    }
    return null;
  };

  /**
   * Safety guard (mirrors the POC's _enforce_guard): before any mutation/activation, confirm the
   * target property actually serves the site's own domain on an active hostname. This prevents an
   * onboarding call from touching a property that belongs to a different site.
   * @returns {Promise<Response|null>} a response to BLOCK, or null to allow
   */
  const assertPropertyServesSite = async (client, ref, site, context, action) => {
    const host = siteHostname(site);
    if (!host) {
      return badRequest('Unable to derive a hostname from the site base URL');
    }
    let matches;
    try {
      matches = await client.findPropertiesByDomain(host);
    } catch (e) {
      return papiErrorResponse(e, 'property lookup', context, { siteId: site.getId() });
    }
    const serving = (matches || []).some(
      (m) => m.propertyId === ref.propertyId && (m.matchedOn || []).includes('hostname'),
    );
    if (serving) {
      return null;
    }

    // findPropertiesByDomain swallows per-search failures (bad/expired creds, rate limiting, ...)
    // and returns [], so an empty result can be an auth/permission failure rather than a genuine
    // "wrong property". Probe with an authenticated call that DOES surface errors, so we return a
    // truthful 401/403/404/5xx instead of a misleading "does not serve site" 403. A non-empty
    // result (properties matched, just not this one) is unambiguous and skips the probe.
    if (!(matches || []).length) {
      try {
        await client.getLatestVersion(ref.propertyId, ref.contractId, ref.groupId);
      } catch (e) {
        return papiErrorResponse(e, 'property lookup', context, {
          siteId: site.getId(), propertyId: ref.propertyId,
        });
      }
    }

    const seen = (matches || []).map((m) => m.propertyId).join(', ') || 'none';
    log.info(auditLine(context, action, 'guard-blocked', {
      siteId: site.getId(), propertyId: ref.propertyId, host, seen,
    }));
    return forbidden(cleanupHeaderValue(
      `Property ${ref.propertyId} does not serve '${host}' on an active hostname `
      + `(properties serving it: ${seen})`,
    ));
  };

  /**
   * Resolves the site's onboarding inputs (normalized hostname + LLMO API key), or a response when
   * either is unavailable. The final rule config is built later (buildCfgFromTree) — it depends on
   * the property's rule tree (SSL scope gate + whether to add a Caching behavior).
   * @returns {Promise<{ host: string, apiKey: string } | { error: Response }>}
   */
  const resolveRuleConfig = async (site, context) => {
    const host = siteHostname(site);
    if (!host) {
      return { error: badRequest('Unable to derive a hostname from the site base URL') };
    }
    let apiKey;
    try {
      apiKey = await getLlmoApiKey(site, context);
    } catch (e) {
      log.error(auditLine(context, 'resolve-config', 'metaconfig-failed', {
        siteId: site.getId(), error: e.message,
      }));
      return { error: createResponse({ message: 'Failed to fetch site metaconfig' }, 502) };
    }
    if (!hasText(apiKey)) {
      return { error: internalServerError('LLMO API key not configured for this site') };
    }
    return { host, apiKey };
  };

  /**
   * Builds the managed rule config from the property's rule tree, enforcing the CUSTOM-default
   * scope gate and deciding whether the OAE rule needs its own Caching behavior.
   *
   * - Scope gate: Optimize at Edge currently supports only properties whose default origin uses
   *   "Choose Your Own" (CUSTOM) SSL verification. The OAE origin uses CUSTOM (Match SAN), which
   *   PAPI rejects as incompatible when the default rule is on "Use Platform Settings".
   * - Caching: Cache ID Modification requires a Caching behavior in scope. Add one to the OAE rule
   *   ONLY when the default rule has none — otherwise (the common case) inherit the default's
   *   caching, because adding a Caching behavior to the OAE rule overrides the property's HTML
   *   no-store and makes the optimized path cacheable (serving stale/passthrough content to bots).
   *
   * @returns {{ cfg: object } | { error: Response }}
   */
  const buildCfgFromTree = (host, apiKey, ruleTree, edgeDomain) => {
    const ssl = getDefaultOriginSsl(ruleTree);
    if (!ssl || ssl.verificationMode !== 'CUSTOM') {
      const mode = ssl?.verificationMode || 'an unknown mode';
      return {
        error: badRequest(
          'Optimize at Edge onboarding requires the property\'s default origin to use '
          + `"Choose Your Own" (CUSTOM) SSL verification; this property uses ${mode}.`,
        ),
      };
    }
    const addCaching = !defaultRuleHasCaching(ruleTree);
    // originHostname routes AI-bot traffic to the env-appropriate Edge Optimize worker
    // (dev/stage/live.edgeoptimize.net) via EDGE_OPTIMIZE_EDGE_DOMAIN; falls back to prod default.
    return {
      cfg: buildRuleConfig({
        hostname: host, apiKey, addCaching, originHostname: edgeDomain,
      }),
    };
  };

  /**
   * GET /sites/:siteId/llmo/cdn-onboard/akamai/config
   * Returns the supported activation networks plus the credential headers the caller must supply,
   * so the UI can prompt for the right EdgeGrid values. EdgeGrid credentials are client-supplied,
   * so there is no server-side "configured" state.
   */
  const getConfig = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    return ok({
      networks: NETWORKS,
      credentialHeaders: CRED_HEADERS,
      requiredCredentialHeaders: REQUIRED_CRED_KEYS.map((k) => CRED_HEADERS[k]),
    });
  };

  /**
   * GET /sites/:siteId/llmo/cdn-onboard/akamai/properties
   * Lists Akamai properties that serve the site's domain, so the onboarding UI can offer the
   * candidate property/contract/group to operate on. Read-only.
   */
  const listProperties = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client, error } = requireClient(context);
    if (error) {
      return error;
    }

    const host = siteHostname(site);
    if (!host) {
      return badRequest('Unable to derive a hostname from the site base URL');
    }

    try {
      // NOTE: findPropertiesByDomain swallows per-search failures and returns []; an empty list can
      // therefore mean "no matching property" OR a credentials/permission failure. It only rejects
      // on an empty domain (guarded above), so the catch below is defensive against future client
      // versions. Mutating flows (deploy/activate) disambiguate this via an authenticated probe.
      const properties = await client.findPropertiesByDomain(host);
      return ok({ domain: host, properties });
    } catch (e) {
      return papiErrorResponse(e, 'property listing', context, { siteId: site.getId(), host });
    }
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/akamai/plan
   * Body: { propertyId, contractId, groupId, insertIndex? }
   * Dry run: fetches the property's latest version + rule tree, merges the managed Edge Optimize
   * rules in memory, and returns the before/after child-rule names plus the merged tree for the UI
   * to preview/diff. No mutation, no new version.
   */
  const plan = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client, error } = requireClient(context);
    if (error) {
      return error;
    }

    const { ref, error: refError } = requirePropertyRef(context);
    if (refError) {
      return refError;
    }

    const { host, apiKey, error: cfgError } = await resolveRuleConfig(site, context);
    if (cfgError) {
      return cfgError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { insertIndex } = context.data;
    const insertIndexError = validateInsertIndex(insertIndex);
    if (insertIndexError) {
      return insertIndexError;
    }

    try {
      const version = await client.getLatestVersion(propertyId, contractId, groupId);
      const {
        ruleTree, ruleFormat,
      } = await client.getRuleTree(propertyId, version, contractId, groupId);

      // Enforce the CUSTOM-default scope gate and decide the caching behavior from the actual tree.
      const edgeDomain = context.env?.EDGE_OPTIMIZE_EDGE_DOMAIN;
      const { cfg, error: gateError } = buildCfgFromTree(host, apiKey, ruleTree, edgeDomain);
      if (gateError) {
        return gateError;
      }
      const merged = mergeIntoTree(ruleTree, cfg, insertIndex);

      // Validate the exact change deploy will make: dry-run the full-tree PUT. PAPI validates the
      // submitted tree and returns errors/warnings without persisting. A dry-run PUT still needs an
      // EDITABLE version, so if `version` is activated it 403s — fall back to the base tree's
      // warnings and flag the preview unvalidated (deploy validates on its own new version anyway).
      let errors = [];
      let warnings = [];
      let validated = true;
      try {
        const dryRun = await client.updateRuleTree(
          propertyId,
          version,
          contractId,
          groupId,
          merged,
          ruleFormat,
          { dryRun: true },
        );
        errors = dryRun?.errors || [];
        warnings = dryRun?.warnings || [];
      } catch (dryRunError) {
        // A dry-run is best-effort: never fail the read-only preview because validation couldn't be
        // performed. Fall back to the base tree's own warnings and flag that this preview is
        // unvalidated so the UI can say so.
        validated = false;
        warnings = ruleTree.warnings || [];
        log.warn(auditLine(context, 'plan', 'dry-run-failed', {
          siteId: site.getId(), propertyId, version, error: dryRunError.message,
        }));
      }

      log.info(auditLine(context, 'plan', 'ok', {
        siteId: site.getId(), propertyId, version, validated, errorCount: errors.length,
      }));
      return ok({
        propertyId,
        latestVersion: version,
        ruleFormat,
        managedRules: managedRuleNames(cfg),
        // ruleTree.rules is guaranteed present here (mergeIntoTree throws otherwise, caught below);
        // only its children may be absent. merge always writes a children array.
        currentChildRules: (ruleTree.rules.children || []).map((c) => c.name),
        mergedChildRules: merged.rules.children.map((c) => c.name),
        // PAPI validation of the exact change deploy will make (see the dry-run above). `validated`
        // is false only when the dry-run itself couldn't run.
        validated,
        errors,
        warnings,
        // Redact the injected LLMO API key before returning the preview — plan is read-only and
        // the real key is only needed server-side at deploy; the merged tree ends up in browser
        // devtools / HAR exports / proxy logs otherwise.
        merged: redactApiKey(merged),
      });
    } catch (e) {
      return papiErrorResponse(e, 'plan', context, { siteId: site.getId(), propertyId });
    }
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/akamai/deploy
   * Body: { propertyId, contractId, groupId, insertIndex?, baseVersion? }
   * Creates a NEW property version from `baseVersion` (default: latest) and applies the managed
   * rules via a full-tree PUT with PAPI-side validation, pinning the base version's ruleFormat.
   * Supported only for properties whose default origin uses CUSTOM SSL verification (scope gate).
   * Does NOT activate (a separate, explicit step). Guarded so the target property must serve the
   * site's own domain. Idempotent by rule name (trimmed): re-running replaces prior managed rules
   * rather than duplicating them.
   */
  const deploy = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client, error } = requireClient(context);
    if (error) {
      return error;
    }

    const { ref, error: refError } = requirePropertyRef(context);
    if (refError) {
      return refError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { insertIndex, baseVersion: rawBaseVersion } = context.data;
    const insertIndexError = validateInsertIndex(insertIndex);
    if (insertIndexError) {
      return insertIndexError;
    }
    // Optional: copy from a specific version instead of the latest. PAPI versions start at 1, so
    // reject 0 here (it passes DECIMAL_INT_RE) for a clean 400 instead of an opaque PAPI 404/500 —
    // mirrors the version check in activate.
    if (rawBaseVersion !== undefined && rawBaseVersion !== null && rawBaseVersion !== ''
      && (!DECIMAL_INT_RE.test(String(rawBaseVersion)) || Number(rawBaseVersion) < 1)) {
      return badRequest('baseVersion must be a positive integer');
    }
    const siteId = site.getId();

    // Guard before fetching the metaconfig — no point resolving the API key for a call we will
    // block anyway.
    const guard = await assertPropertyServesSite(client, ref, site, context, 'deploy');
    if (guard) {
      return guard;
    }

    const { host, apiKey, error: cfgError } = await resolveRuleConfig(site, context);
    if (cfgError) {
      return cfgError;
    }

    log.info(auditLine(context, 'deploy', 'started', { siteId, propertyId }));

    // Hoisted so the catch can report it: createVersion may succeed before a later call throws.
    let newVersion;
    try {
      const baseVersion = (rawBaseVersion !== undefined && rawBaseVersion !== null && rawBaseVersion !== '')
        ? Number(rawBaseVersion)
        : await client.getLatestVersion(propertyId, contractId, groupId);

      // Read the base version's tree first so we can enforce the CUSTOM-default scope gate and
      // decide caching BEFORE creating a version — a rejected onboarding then leaves no orphan
      // version behind. The new version is a clone of baseVersion, so merging the base tree and
      // PUTting it into the new version is equivalent, and pins the base version's ruleFormat.
      const { ruleTree, ruleFormat } = await client.getRuleTree(
        propertyId,
        baseVersion,
        contractId,
        groupId,
      );
      const edgeDomain = context.env?.EDGE_OPTIMIZE_EDGE_DOMAIN;
      const { cfg, error: gateError } = buildCfgFromTree(host, apiKey, ruleTree, edgeDomain);
      if (gateError) {
        return gateError;
      }
      const merged = mergeIntoTree(ruleTree, cfg, insertIndex);

      newVersion = await client.createVersion(propertyId, baseVersion, contractId, groupId);
      const putResult = await client.updateRuleTree(
        propertyId,
        newVersion,
        contractId,
        groupId,
        merged,
        ruleFormat,
      );

      const papiErrors = putResult?.errors || [];
      const warnings = putResult?.warnings || [];
      if (papiErrors.length > 0) {
        log.error(auditLine(context, 'deploy', 'papi-rejected', {
          siteId, propertyId, newVersion, errorCount: papiErrors.length,
        }));
        return createResponse({
          message: 'Akamai rejected the rule tree',
          newVersion,
          papiErrors,
          warnings,
        }, 422);
      }

      log.info(auditLine(context, 'deploy', 'deployed', {
        siteId, propertyId, baseVersion, newVersion, warningCount: warnings.length,
      }));
      return ok({
        propertyId,
        baseVersion,
        newVersion,
        managedRules: managedRuleNames(cfg),
        warnings,
      });
    } catch (e) {
      return papiErrorResponse(e, 'deploy', context, { siteId, propertyId, newVersion });
    }
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/akamai/activate
   * Body: { propertyId, contractId, groupId, network, version? }
   * Activates a property version (the given one, or the latest) to STAGING or PRODUCTION. PAPI
   * requires at least one address to notify about activation progress; we derive it server-side
   * from the authenticated caller, never client-supplied. Guarded so the target property must serve
   * the site's own domain. Returns the activation id/link the UI polls with activation-status.
   */
  const activate = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { ref, error: refError } = requirePropertyRef(context);
    if (refError) {
      return refError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { network: rawNetwork, version: rawVersion } = context.data;
    const siteId = site.getId();

    const network = hasText(rawNetwork) ? rawNetwork.toUpperCase() : 'STAGING';
    if (!NETWORKS.includes(network)) {
      return badRequest(`network must be one of ${NETWORKS.join(', ')}`);
    }

    let version;
    if (rawVersion !== undefined && rawVersion !== null && rawVersion !== '') {
      // Require a decimal-integer literal (Number() would accept true, "0x10", "1e3", ["5"] and
      // could activate an unintended version).
      if (!DECIMAL_INT_RE.test(String(rawVersion))) {
        return badRequest('version must be a positive integer');
      }
      version = Number(rawVersion);
      if (version < 1) {
        return badRequest('version must be a positive integer');
      }
    }

    // PAPI requires at least one notify address to activate. Derive it from the authenticated
    // caller's IMS profile (trial_email is the human-readable RFC-5322 address; profile.email is
    // an IMS user GUID) — never accepted from the client.
    const notifyEmail = getCallerEmail(context);
    if (!notifyEmail) {
      log.error(auditLine(context, 'activate', 'no-notify-email', { siteId, propertyId }));
      return forbidden('Unable to derive a notification email from the authenticated user');
    }

    const { client, error } = requireClient(context, { notifyEmails: [notifyEmail] });
    if (error) {
      return error;
    }

    const guard = await assertPropertyServesSite(client, ref, site, context, 'activate');
    if (guard) {
      return guard;
    }

    try {
      if (version === undefined) {
        version = await client.getLatestVersion(propertyId, contractId, groupId);
      }
      const activationLink = await client.activate(
        propertyId,
        version,
        contractId,
        groupId,
        network,
        // Akamai's version author is the API credential; attribute the human operator in the
        // activation note so it shows in Property Manager's Activation History.
        `Optimize at Edge — onboarded by ${notifyEmail} via Adobe LLM Optimizer`,
      );
      const activationId = AkamaiClient.activationIdFromLink(activationLink);
      if (!hasText(activationId)) {
        // PAPI accepted the activation but returned no usable link — surface it rather than
        // reporting success with an empty activationId the UI cannot poll.
        log.error(auditLine(context, 'activate', 'no-activation-link', {
          siteId, propertyId, version, network,
        }));
        return createResponse({ message: 'Akamai returned no activation link' }, 502);
      }
      log.info(auditLine(context, 'activate', 'submitted', {
        siteId, propertyId, version, network, activationId,
      }));
      return ok({
        propertyId, version, network, activationId, activationLink,
      });
    } catch (e) {
      // Defensive: notifyEmails is validated non-empty above, but if the client still rejects it
      // surface a caller error rather than a PAPI failure.
      if (/notifyEmails/.test(e?.message || '')) {
        return badRequest('notifyEmails is required to activate');
      }
      // The activation POST regularly errors client-side even though Akamai queued the activation:
      // a large rule tree makes PAPI exceed the client request timeout, and any retry then returns
      // `422 already-activated`. Before surfacing a failure, look for an in-flight (or freshly
      // active) activation for this exact version+network and, if found, report success so the UI
      // polls it. Genuine failures (no matching activation) still fall through to the error.
      if (version !== undefined) {
        try {
          const recovered = await client.latestActivation(propertyId, contractId, groupId, network);
          // A matching in-flight/active activation for this EXACT version+network means the
          // version is (being) activated on that network — the desired end state — so report
          // success regardless of age. We intentionally do NOT gate on submit recency: that made
          // re-activating an already-active version (Akamai 422 already-activated) surface as a
          // false "activation failed". The version match is the correct guard.
          if (recovered
            && Number(recovered.propertyVersion) === Number(version)
            && IN_FLIGHT_ACTIVATION_STATUSES.has(String(recovered.status || '').toUpperCase())) {
            // Only hand back a real (numeric) id; a just-queued activation can still be a
            // placeholder ("atv_null") — return null so the UI polls by network for it.
            const recoveredId = REAL_ACTIVATION_ID_RE.test(recovered.activationId || '')
              ? recovered.activationId
              : null;
            log.info(auditLine(context, 'activate', 'recovered', {
              siteId,
              propertyId,
              version,
              network,
              activationId: recoveredId,
              status: recovered.status,
            }));
            return ok({
              propertyId,
              version,
              network,
              activationId: recoveredId,
              activationLink: null,
              recovered: true,
            });
          }
        } catch (recoverErr) {
          // Double failure (activate POST AND the recovery probe both failed) — log at error level
          // for alerting visibility; the caller still gets the sanitized activation error below.
          log.error(auditLine(context, 'activate', 'recover-failed', {
            siteId, propertyId, version, network, error: recoverErr?.message,
          }));
        }
      }
      return papiErrorResponse(e, 'activation', context, { siteId, propertyId });
    }
  };

  /**
   * GET /sites/:siteId/llmo/cdn-onboard/akamai/activation-status
   * Query: { propertyId, contractId, groupId, network, activationId? }
   * Returns the status of an activation. With activationId, checks that specific activation
   * directly (fast, precise — use right after activate); without it, returns the most recent
   * activation for the network. Read-only.
   */
  const activationStatus = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client, error } = requireClient(context);
    if (error) {
      return error;
    }

    const { ref, error: refError } = requirePropertyRef(context);
    if (refError) {
      return refError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { network: rawNetwork, activationId } = context.data;
    const siteId = site.getId();

    let network;
    if (hasText(activationId)) {
      // Boundary validation consistent with the other PAPI identifiers: reject a malformed id
      // here with a clean 400 rather than passing it straight through to PAPI.
      if (!ACTIVATION_ID_RE.test(activationId)) {
        return badRequest('activationId must look like atv_<id>');
      }
    } else {
      network = hasText(rawNetwork) ? rawNetwork.toUpperCase() : 'STAGING';
      if (!NETWORKS.includes(network)) {
        return badRequest(`network must be one of ${NETWORKS.join(', ')}`);
      }
    }

    try {
      const activation = hasText(activationId)
        ? await client.getActivation(propertyId, activationId, contractId, groupId)
        : await client.latestActivation(propertyId, contractId, groupId, network);
      if (!activation) {
        return notFound('No matching activation found');
      }
      return ok({ propertyId, activation });
    } catch (e) {
      return papiErrorResponse(e, 'activation status', context, { siteId, propertyId });
    }
  };

  return {
    getConfig,
    listProperties,
    plan,
    deploy,
    activate,
    activationStatus,
  };
}

export default LlmoAkamaiController;
