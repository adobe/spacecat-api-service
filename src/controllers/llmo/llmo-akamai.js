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
import AkamaiClient, { normalizeDomain } from '@adobe/spacecat-shared-akamai-client';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  buildRuleConfig, mergeIntoTree, managedRuleNames,
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
// notifyEmails (needed only to activate) is not secret, so it travels in the request body.
const REQUIRED_CRED_KEYS = ['host', 'clientToken', 'clientSecret', 'accessToken'];

const NETWORKS = ['STAGING', 'PRODUCTION'];

// Akamai PAPI identifiers. Boundary validation (defense-in-depth): the shared client also encodes
// these into the path, but rejecting a malformed id here gives the caller a clean 400 instead of a
// 502 from PAPI.
const PROPERTY_ID_RE = /^prp_[A-Za-z0-9]+$/;
const CONTRACT_ID_RE = /^ctr_[A-Za-z0-9-]+$/;
const GROUP_ID_RE = /^grp_[A-Za-z0-9]+$/;

/**
 * Identifies the API caller for audit logging. profile.email is an IMS user GUID (see
 * access-control-util.js), not an RFC-5322 address. Returns 'unknown' when unavailable.
 */
const getCallerId = (context) => context?.attributes?.authInfo?.getProfile?.()?.email || 'unknown';

/**
 * The authenticated caller's human-readable email, used server-side as the Akamai activation
 * notification address. profile.trial_email is the RFC-5322 address on the IMS token (profile.email
 * is an IMS user GUID, not a real address). Returns null when no usable address is present.
 */
const getCallerEmail = (context) => {
  const profile = context?.attributes?.authInfo?.getProfile?.();
  return hasText(profile?.trial_email) ? profile.trial_email.trim() : null;
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
   * badRequest when a required credential header is missing. `notifyEmails` (not secret) is only
   * needed to activate() and is threaded through from the request body.
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
    try {
      return { client: new AkamaiClient({ ...creds, notifyEmails }, log) };
    } catch (e) {
      // The constructor re-validates the required keys; after the check above this is unexpected,
      // so surface it as a caller error without echoing any credential value.
      return { error: badRequest(`Invalid Akamai credentials: ${e.message}`) };
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
    if (/-> 401\b/.test(message)) {
      return unauthorized('Akamai authentication failed');
    }
    if (/-> 403\b/.test(message)) {
      return forbidden('Akamai authorization failed');
    }
    if (/-> 429\b/.test(message)) {
      return createResponse({ message: 'Akamai rate limit exceeded' }, 429);
    }
    return createResponse({ message: `Akamai ${action} failed` }, 502);
  };

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
    if (!serving) {
      const seen = (matches || []).map((m) => m.propertyId).join(', ') || 'none';
      log.info(auditLine(context, action, 'guard-blocked', {
        siteId: site.getId(), propertyId: ref.propertyId, host, seen,
      }));
      return forbidden(
        `Property ${ref.propertyId} does not serve '${host}' on an active hostname `
        + `(properties serving it: ${seen})`,
      );
    }
    return null;
  };

  /**
   * Resolves the merged rule config for a site (defaults + site hostname + LLMO API key), or a
   * response when the API key is unavailable.
   * @returns {Promise<{ cfg: object } | { error: Response }>}
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
    return { cfg: buildRuleConfig({ hostname: host, apiKey }) };
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

    const { cfg, error: cfgError } = await resolveRuleConfig(site, context);
    if (cfgError) {
      return cfgError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { insertIndex } = context.data;

    try {
      const version = await client.getLatestVersion(propertyId, contractId, groupId);
      const { ruleTree, ruleFormat } = await client.getRuleTree(
        propertyId,
        version,
        contractId,
        groupId,
      );
      const merged = mergeIntoTree(ruleTree, cfg, insertIndex);
      log.info(auditLine(context, 'plan', 'ok', {
        siteId: site.getId(), propertyId, version,
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
        merged,
      });
    } catch (e) {
      return papiErrorResponse(e, 'plan', context, { siteId: site.getId(), propertyId });
    }
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/akamai/deploy
   * Body: { propertyId, contractId, groupId, insertIndex? }
   * Creates a NEW property version from the latest, merges the managed rules into it, and PUTs the
   * rule tree with PAPI-side validation. Does NOT activate (that is a separate, explicit step).
   * Guarded so the target property must serve the site's own domain. Idempotent by rule name: the
   * merge replaces any previously-managed rules rather than duplicating them.
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

    const { cfg, error: cfgError } = await resolveRuleConfig(site, context);
    if (cfgError) {
      return cfgError;
    }

    const { propertyId, contractId, groupId } = ref;
    const { insertIndex } = context.data;
    const siteId = site.getId();

    const guard = await assertPropertyServesSite(client, ref, site, context, 'deploy');
    if (guard) {
      return guard;
    }

    log.info(auditLine(context, 'deploy', 'started', { siteId, propertyId }));

    try {
      const baseVersion = await client.getLatestVersion(propertyId, contractId, groupId);
      const { ruleTree, ruleFormat } = await client.getRuleTree(
        propertyId,
        baseVersion,
        contractId,
        groupId,
      );
      const merged = mergeIntoTree(ruleTree, cfg, insertIndex);

      const newVersion = await client.createVersion(propertyId, baseVersion, contractId, groupId);
      const updateResult = await client.updateRuleTree(
        propertyId,
        newVersion,
        contractId,
        groupId,
        merged,
        ruleFormat,
      );

      const papiErrors = updateResult?.errors || [];
      const warnings = updateResult?.warnings || [];
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
      return papiErrorResponse(e, 'deploy', context, { siteId, propertyId });
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
      version = Number(rawVersion);
      if (!Number.isInteger(version) || version < 1) {
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
      );
      const activationId = AkamaiClient.activationIdFromLink(activationLink);
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
    if (!hasText(activationId)) {
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
