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
import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import CloudflareClient from '@adobe/spacecat-shared-cloudflare-client';
import AccessControlUtil from '../../support/access-control-util.js';
import {
  deriveWorkerName, hostInSiteDomain, registrableDomain, routePatternHost, routePatternHostGlob,
  routePatternsOverlap,
} from './llmo-cloudflare-utils.js';

// Cap the conflicting-routes list returned in a 409 so a zone with many overlapping routes can't
// produce an unbounded response payload.
const MAX_CONFLICTING_ROUTES = 10;

const CF_TOKEN_HEADER = 'x-cloudflare-token';
const CF_TOKEN_MISSING = 'Missing x-cloudflare-token header';
const EDGE_OPTIMIZE_API_KEY_SECRET = 'EDGE_OPTIMIZE_API_KEY';
const EDGE_OPTIMIZE_TARGET_HOST_BINDING = 'EDGE_OPTIMIZE_TARGET_HOST';

// Stable ownership tag attached to every worker we deploy. CloudflareClient uses it to make
// re-deploys idempotent: a worker that already carries this tag is recognized as ours and the
// upload is skipped (deployWorkerScript returns null); a same-named worker WITHOUT it is a
// foreign collision and surfaces as an 'already exists' error (mapped to 409).
const CF_WORKER_OWNER_TAG = 'adobe-llmo';

// Cloudflare allows up to 8 tags per script and uses them in comma/colon-delimited filter
// expressions, so caller-derived tag values must be sanitized. Cloudflare explicitly disallows
// ',' and '&'; we conservatively restrict to [A-Za-z0-9._-] (dropping '@', ':', etc.) and cap the
// length, since the full validation rules are undocumented and a rejected tag fails the deploy.
const CF_TAG_MAX_LEN = 80;

// Pin the worker script to an immutable commit SHA rather than a mutable branch HEAD so a
// push to llmo-code-samples can never silently change what is deployed to customer accounts.
// Overridable via env for forward-compat, but the default is always a pinned SHA.
const WORKER_SCRIPT_REF = 'd28ba321916a2bb2b62e65d265df9c76e24d0786';
const DEFAULT_WORKER_SCRIPT_URL = `https://raw.githubusercontent.com/adobe/llmo-code-samples/${WORKER_SCRIPT_REF}/optimize-at-edge/cloudflare/automation/src/worker.js`;
const WORKER_SCRIPT_FETCH_TIMEOUT_MS = 10_000;

// Boundary input validation (defense-in-depth, independent of CloudflareClient behaviour).
const CF_ID_RE = /^[0-9a-f]{32}$/; // Cloudflare account/zone IDs are 32-char lowercase hex
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Identifies the API caller for audit logging and worker tagging. profile.email is an IMS user
 * GUID (GUID@hexOrgId.e), not an RFC-5322 address — see access-control-util.js. Returns 'unknown'
 * when the profile is unavailable (e.g. non-JWT auth) so audit lines always carry the field.
 */
const getCallerId = (context) => context?.attributes?.authInfo?.getProfile?.()?.email || 'unknown';

/**
 * Sanitizes a value (e.g. the caller's IMS identity) into a Cloudflare-safe worker tag: keeps
 * only [A-Za-z0-9._-], capped at CF_TAG_MAX_LEN. Returns null when there is no usable identity
 * (so the deploy still gets the stable ownership tag without an empty/invalid extra tag).
 */
const toWorkerTag = (value) => {
  if (!hasText(value) || value === 'unknown') {
    return null;
  }
  // Replacement preserves length (every char maps to itself or '_'), so a non-empty input always
  // yields a non-empty tag — no empty-result case to guard here.
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, CF_TAG_MAX_LEN);
};

/**
 * Builds a single greppable audit line for the Cloudflare onboarding operations. Every line
 * carries action, outcome, caller, and requestId so a deploy/route attempt can be correlated
 * end-to-end in Splunk; `fields` adds operation-specific identifiers (siteId, accountId, ...).
 * Null/undefined/empty fields are dropped to keep lines clean.
 */
const auditLine = (context, action, outcome, fields = {}) => {
  const entries = {
    action,
    outcome,
    caller: getCallerId(context),
    requestId: context?.invocation?.id || 'unknown',
    ...fields,
  };
  // Quote any value containing whitespace so key=value parsers (Splunk, grep) don't misread an
  // embedded space (e.g. in an error message) as a field boundary. Inner double quotes are
  // downgraded to single quotes to keep the token well-formed.
  const fmt = (v) => {
    const s = String(v);
    return /\s/.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
  };
  const kv = Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ');
  return `[llmo-cf] ${kv}`;
};

/**
 * Whether a deployWorkerScript failure indicates the target worker name is already taken.
 * CloudflareClient 1.1.x probed existence via GET /workers/scripts/:name, which returns
 * script source (not JSON) when the worker exists — that surfaced as a generic 502 upstream.
 */
const isWorkerDeployConflictError = (error) => {
  const message = error?.message || String(error);
  if (/already exists/i.test(message)) {
    return true;
  }
  return /non-JSON response on \/accounts\/[^/]+\/workers\/scripts\//i.test(message);
};

const workerAlreadyExistsResponse = (scriptName, accountId) => createResponse({
  message: `A worker named '${scriptName}' already exists in this Cloudflare account`,
  scriptName,
  accountId,
}, 409);

function LlmoCloudflareController(ctx) {
  const { log, env } = ctx;
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
      return forbidden('Only LLMO administrators can access Cloudflare onboarding endpoints');
    }

    return { site };
  };

  const getCfToken = (context) => {
    const token = context.pathInfo?.headers?.[CF_TOKEN_HEADER];
    return hasText(token) ? token : null;
  };

  /**
   * Maps an error thrown by CloudflareClient (or the worker-script fetch) to an appropriate
   * HTTP response. These are external network calls, so failures are routine: we log the cause
   * and surface a sanitized, status-appropriate response instead of an unstructured 500.
   */
  const cfErrorResponse = (error, action, context, fields = {}) => {
    const message = error?.message || String(error);
    log.error(auditLine(context, 'cf-call', 'error', { op: action, ...fields, error: message }));
    if (/returned 401\b/.test(message)) {
      return unauthorized('Cloudflare authentication failed');
    }
    if (/returned 403\b/.test(message)) {
      return forbidden('Cloudflare authorization failed');
    }
    if (/returned 429\b/.test(message)) {
      return createResponse({ message: 'Cloudflare rate limit exceeded' }, 429);
    }
    // Upstream/network failure or any other Cloudflare error -> bad gateway.
    return createResponse({ message: `Cloudflare ${action} failed` }, 502);
  };

  const getLlmoApiKey = async (site, context) => {
    const tokowaka = TokowakaClient.createFrom(context);
    const metaconfig = await tokowaka.fetchMetaconfig(site.getBaseURL());
    return metaconfig?.apiKeys?.[0] ?? null;
  };

  const fetchWorkerScript = async () => {
    const url = hasText(env.EDGE_OPTIMIZE_WORKER_SCRIPT_URL)
      ? env.EDGE_OPTIMIZE_WORKER_SCRIPT_URL
      : DEFAULT_WORKER_SCRIPT_URL;
    const res = await fetch(url, { signal: AbortSignal.timeout(WORKER_SCRIPT_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Failed to fetch worker script: ${res.status} ${res.statusText}`);
    }
    return res.text();
  };

  /**
   * Resolves the caller's Cloudflare token into a client, or a badRequest when it is missing.
   * @returns {{ client: CloudflareClient } | { error: Response }}
   */
  const requireCfClient = (context) => {
    const cfToken = getCfToken(context);
    if (!cfToken) {
      return { error: badRequest(CF_TOKEN_MISSING) };
    }
    return { client: new CloudflareClient({ token: cfToken }, log) };
  };

  /**
   * Derives the service-owned worker name for a site, or a badRequest when the site base URL
   * yields no usable slug.
   * @returns {{ scriptName: string } | { error: Response }}
   */
  const requireScriptName = (site) => {
    const scriptName = deriveWorkerName(site.getBaseURL());
    if (!scriptName) {
      log.error(`Unable to derive a worker name from site base URL ${site.getBaseURL()}`);
      return { error: badRequest('Unable to derive a worker name from the site base URL') };
    }
    return { scriptName };
  };

  /**
   * Builds a handler for a parameter-less Cloudflare list call (accounts, zones, ...): runs
   * access control + token resolution, invokes `cfClient[method]()`, and maps failures.
   */
  const cfListProxy = (method, action) => async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { client, error } = requireCfClient(context);
    if (error) {
      return error;
    }
    try {
      return ok(await client[method]());
    } catch (e) {
      return cfErrorResponse(e, action, context, { siteId: context.params?.siteId });
    }
  };

  /**
   * GET /sites/:siteId/llmo/cdn-onboard/cloudflare/config
   * Returns the Cloudflare OAuth client ID for browser PKCE flow.
   */
  const getCloudflareConfig = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }

    const clientId = env.CLOUDFLARE_CLIENT_ID;
    if (!hasText(clientId)) {
      log.error('CLOUDFLARE_CLIENT_ID is not configured');
      return internalServerError('Cloudflare client ID is not configured');
    }
    return ok({ clientId });
  };

  // GET /sites/:siteId/llmo/cdn-onboard/cloudflare/accounts
  const listAccounts = cfListProxy('listAccounts', 'account listing');

  /**
   * GET /sites/:siteId/llmo/cdn-onboard/cloudflare/zones?accountId=<id>
   * Lists the zones belonging to the selected Cloudflare account that are relevant to the site —
   * i.e. whose registrable domain (resolved via the Public Suffix List) matches the site's
   * base-URL host, so the onboarding UI only offers zones for the site's own domain. `accountId`
   * is a Cloudflare identifier (not a SpaceCat entity), supplied as a query parameter.
   */
  const listZones = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client, error } = requireCfClient(context);
    if (error) {
      return error;
    }

    const { accountId } = context.data || {};
    if (!hasText(accountId)) {
      return badRequest('Missing accountId query parameter');
    }
    if (!CF_ID_RE.test(accountId)) {
      return badRequest('accountId must be a 32-character hexadecimal Cloudflare account ID');
    }

    try {
      // The client pushes account.id to the Cloudflare API, so account filtering happens
      // server-side; we then keep only the zones on the site's own registrable domain (PSL).
      const zones = await client.listZones({ accountId });
      const siteApex = registrableDomain(new URL(site.getBaseURL()).hostname);
      const matching = (zones || []).filter(
        (zone) => hasText(zone?.name) && !!siteApex && registrableDomain(zone.name) === siteApex,
      );
      return ok(matching);
    } catch (e) {
      return cfErrorResponse(e, 'zone listing', context, {
        siteId: context.params?.siteId,
        accountId,
      });
    }
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/cloudflare/deploy
   * Body: { accountId, targetHost }
   * Fetches the Edge Optimize worker script from GitHub and deploys it under a name derived
   * from the site (see deriveWorkerName), tagging it with CF_WORKER_OWNER_TAG (+ the caller's
   * IMS identity), then sets the LLMO API key as the EDGE_OPTIMIZE_API_KEY secret on the worker.
   *
   * Idempotency via tags: if a worker we previously deployed (matching CF_WORKER_OWNER_TAG)
   * already exists, the client skips the upload and we return 200 with `alreadyDeployed: true`
   * without re-setting the secret. A same-named worker that does NOT carry the tag is treated as
   * a foreign collision and returns 409.
   */
  const deployWorker = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client: cfClient, error: cfError } = requireCfClient(context);
    if (cfError) {
      return cfError;
    }

    // The worker name is owned by the service and derived from the site, not client-supplied.
    const { scriptName, error: nameError } = requireScriptName(site);
    if (nameError) {
      return nameError;
    }

    const { accountId, targetHost } = context.data || {};

    if (!hasText(accountId)) {
      return badRequest('Missing accountId in request body');
    }
    if (!CF_ID_RE.test(accountId)) {
      return badRequest('accountId must be a 32-character hexadecimal Cloudflare account ID');
    }
    if (!hasText(targetHost)) {
      return badRequest('Missing targetHost in request body');
    }
    if (!HOSTNAME_RE.test(targetHost)) {
      return badRequest('targetHost must be a valid hostname');
    }
    if (!hostInSiteDomain(targetHost, site.getBaseURL())) {
      return badRequest('targetHost must belong to the site\'s domain');
    }

    const siteId = site.getId();

    // Tags attached to the worker. CF_WORKER_OWNER_TAG is always present and always first so the
    // client's idempotency match (tags.some((t) => settings.tags?.includes(t))) recognizes any
    // worker we previously deployed — regardless of which IMS user originally created it. The
    // caller's IMS identity is appended (sanitized to a Cloudflare-safe value) purely as an audit
    // breadcrumb of who first deployed it; it never participates in cross-user matching.
    const callerTag = toWorkerTag(getCallerId(context));
    const tags = callerTag ? [CF_WORKER_OWNER_TAG, callerTag] : [CF_WORKER_OWNER_TAG];

    log.info(auditLine(context, 'deploy-worker', 'started', {
      siteId, accountId, scriptName, targetHost,
    }));

    let llmoApiKey;
    try {
      llmoApiKey = await getLlmoApiKey(site, context);
    } catch (e) {
      log.error(auditLine(context, 'deploy-worker', 'metaconfig-failed', {
        siteId, accountId, scriptName, error: e.message,
      }));
      return createResponse({ message: 'Failed to fetch site metaconfig' }, 502);
    }
    if (!hasText(llmoApiKey)) {
      log.error(auditLine(context, 'deploy-worker', 'no-api-key', { siteId, accountId, scriptName }));
      return internalServerError('LLMO API key not configured for this site');
    }

    let workerScript;
    try {
      workerScript = await fetchWorkerScript();
    } catch (e) {
      return cfErrorResponse(e, 'worker script fetch', context, { siteId, scriptName });
    }

    const bindings = [
      { name: EDGE_OPTIMIZE_TARGET_HOST_BINDING, type: 'plain_text', text: targetHost },
    ];

    let deployResult;
    try {
      // overwrite stays false. With tags, the client is idempotent: a worker already carrying
      // CF_WORKER_OWNER_TAG is recognized as ours and the upload is skipped (returns null); a
      // same-named worker WITHOUT the tag is a foreign collision and throws 'already exists'.
      deployResult = await cfClient.deployWorkerScript(
        accountId,
        scriptName,
        workerScript,
        bindings,
        { tags },
      );
    } catch (e) {
      if (isWorkerDeployConflictError(e)) {
        log.info(auditLine(context, 'deploy-worker', 'conflict-foreign', {
          siteId, accountId, scriptName,
        }));
        return workerAlreadyExistsResponse(scriptName, accountId);
      }
      return cfErrorResponse(e, 'worker deployment', context, { siteId, accountId, scriptName });
    }

    if (deployResult === null) {
      // The client skipped the upload because a worker we own (matching CF_WORKER_OWNER_TAG)
      // already exists. It already carries its API key secret from the original deploy, so this
      // is a no-op success: we return without re-setting the secret.
      log.info(auditLine(context, 'deploy-worker', 'already-deployed', {
        siteId, accountId, scriptName, targetHost,
      }));
      return ok({
        scriptName, accountId, targetHost, alreadyDeployed: true,
      });
    }

    try {
      await cfClient.setWorkerSecret(
        accountId,
        scriptName,
        EDGE_OPTIMIZE_API_KEY_SECRET,
        llmoApiKey,
      );
    } catch (e) {
      // The worker is already live on the edge but lacks its API key, so it is not yet
      // functional. We cannot delete it (the client exposes no delete-script operation), so
      // log the partial state explicitly and return a structured response the caller can
      // act on (re-deploy to set the secret).
      log.error(auditLine(context, 'deploy-worker', 'secret-failed', {
        siteId,
        accountId,
        scriptName,
        secret: EDGE_OPTIMIZE_API_KEY_SECRET,
        error: e.message,
        note: 'worker is live but non-functional; re-deploy to complete setup',
      }));
      return createResponse({
        message: 'Worker deployed but failed to set its API key secret; '
          + 'the worker is live but not yet functional. Re-deploy to complete setup.',
        scriptName,
        accountId,
        partial: true,
      }, 502);
    }

    log.info(auditLine(context, 'deploy-worker', 'deployed', {
      siteId, accountId, scriptName, targetHost,
    }));
    return ok({ scriptName, accountId, targetHost });
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/cloudflare/routes
   * Body: { zoneId, pattern }
   * Verifies server-side that the pattern targets the site's own domain and that no existing
   * route in the zone already targets the same host (compared by resolved host, not raw pattern
   * string) before creating it, so onboarding cannot silently add a second/overlapping route on
   * a host the customer already routes. `zoneId` is a Cloudflare identifier (not a SpaceCat
   * entity), so it is supplied in the body rather than the path.
   */
  const addRoute = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const { client: cfClient, error: cfError } = requireCfClient(context);
    if (cfError) {
      return cfError;
    }

    // The route targets the service-owned worker derived from the site, not a client value.
    const { scriptName, error: nameError } = requireScriptName(site);
    if (nameError) {
      return nameError;
    }

    const { zoneId, pattern } = context.data || {};

    if (!hasText(zoneId)) {
      return badRequest('Missing zoneId in request body');
    }
    if (!CF_ID_RE.test(zoneId)) {
      return badRequest('zoneId must be a 32-character hexadecimal Cloudflare zone ID');
    }
    if (!hasText(pattern)) {
      return badRequest('Missing pattern in request body');
    }
    if (!hostInSiteDomain(routePatternHost(pattern), site.getBaseURL())) {
      return badRequest('route pattern must target the site\'s domain');
    }

    const siteId = site.getId();
    log.info(auditLine(context, 'add-route', 'started', {
      siteId, zoneId, scriptName, pattern,
    }));

    // Protect the customer's existing routing: fetch the zone's routes and reject if any route
    // bound to a DIFFERENT worker shares a host with the one we are about to add (path ignored —
    // any host overlap is a conflict). We use generic host-glob intersection
    // (routePatternsOverlap), so a customer's "*.example.com/*" or broader "*example.com/*" worker
    // route blocks an onboarding attempt on "a.example.com/*", and scheme/wildcard variants are
    // caught too — not just exact duplicates. A route bound to our own worker is idempotent.
    let existingRoutes;
    try {
      existingRoutes = await cfClient.listRoutes(zoneId);
    } catch (e) {
      return cfErrorResponse(e, 'route lookup', context, { siteId, zoneId });
    }

    // Use the wildcard-preserving glob for display so a wildcard pattern is reported as
    // "*.example.com" (what it matches) rather than the stripped apex.
    const targetRouteHost = routePatternHostGlob(pattern);
    const overlapping = (existingRoutes || []).filter(
      (route) => hasText(route?.pattern) && routePatternsOverlap(route.pattern, pattern),
    );

    // Only a route bound to a DIFFERENT worker is a blocking conflict; a disabled/no-script route
    // on the same host has no worker to disrupt, so it does not block onboarding.
    const foreignConflicts = overlapping.filter(
      (route) => hasText(route.script) && route.script !== scriptName,
    );
    if (foreignConflicts.length > 0) {
      const conflictingRoutes = foreignConflicts.slice(0, MAX_CONFLICTING_ROUTES);
      log.info(auditLine(context, 'add-route', 'conflict-foreign', {
        siteId,
        zoneId,
        scriptName,
        pattern,
        host: targetRouteHost,
        conflictCount: foreignConflicts.length,
        conflicts: conflictingRoutes.map((r) => `${r.pattern}->${r.script}`).join(','),
      }));
      return createResponse({
        message: `Existing route(s) in this zone already route host '${targetRouteHost}' to `
          + 'another worker; refusing to add a route that could affect the customer\'s current '
          + 'routing',
        existingRoute: conflictingRoutes[0],
        conflictingRoutes,
      }, 409);
    }

    // An overlapping route already bound to our worker means this host is already onboarded.
    const ownExisting = overlapping.find((route) => route.script === scriptName);
    if (ownExisting) {
      log.info(auditLine(context, 'add-route', 'already-routed', {
        siteId, zoneId, scriptName, pattern, host: targetRouteHost,
      }));
      return ok({ ...ownExisting, alreadyRouted: true });
    }

    try {
      const route = await cfClient.addRoute(zoneId, pattern, scriptName);
      log.info(auditLine(context, 'add-route', 'created', {
        siteId, zoneId, scriptName, pattern,
      }));
      return ok(route);
    } catch (e) {
      return cfErrorResponse(e, 'route creation', context, { siteId, zoneId, scriptName });
    }
  };

  return {
    getCloudflareConfig,
    listAccounts,
    listZones,
    deployWorker,
    addRoute,
  };
}

export default LlmoCloudflareController;
