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

const CF_TOKEN_HEADER = 'x-cloudflare-token';
const CF_TOKEN_MISSING = 'Missing x-cloudflare-token header';
const EDGE_OPTIMIZE_API_KEY_SECRET = 'EDGE_OPTIMIZE_API_KEY';
const EDGE_OPTIMIZE_TARGET_HOST_BINDING = 'EDGE_OPTIMIZE_TARGET_HOST';

// Pin the worker script to an immutable commit SHA rather than a mutable branch HEAD so a
// push to llmo-code-samples can never silently change what is deployed to customer accounts.
// Overridable via env for forward-compat, but the default is always a pinned SHA.
const WORKER_SCRIPT_REF = 'd28ba321916a2bb2b62e65d265df9c76e24d0786';
const DEFAULT_WORKER_SCRIPT_URL = `https://raw.githubusercontent.com/adobe/llmo-code-samples/${WORKER_SCRIPT_REF}/optimize-at-edge/cloudflare/automation/src/worker.js`;
const WORKER_SCRIPT_FETCH_TIMEOUT_MS = 10_000;

// Boundary input validation (defense-in-depth, independent of CloudflareClient behaviour).
const CF_ID_RE = /^[0-9a-f]{32}$/; // Cloudflare account/zone IDs are 32-char lowercase hex
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const WORKER_NAME_PREFIX = 'edge-optimize-router';
const CF_MAX_SCRIPT_NAME_LEN = 63; // Cloudflare worker script name max length

/**
 * Derives the Edge Optimize worker name from a site's base URL: the canonical host (leading
 * "www." removed) with every run of non-alphanumeric characters collapsed to a single hyphen,
 * prefixed and length-capped, e.g. https://www.example.com -> edge-optimize-router-example-com.
 * Cloudflare worker names must match ^[a-z0-9][a-z0-9-]{0,62}$ (no dots), which this guarantees.
 */
const deriveWorkerName = (baseURL) => {
  const host = new URL(baseURL).hostname.replace(/^www\./i, '');
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    return null;
  }
  return `${WORKER_NAME_PREFIX}-${slug}`.slice(0, CF_MAX_SCRIPT_NAME_LEN).replace(/-+$/g, '');
};

/**
 * Whether `host` belongs to the onboarded site's domain: it must equal the site's canonical
 * host (base URL host minus leading "www.") or be a subdomain of it. Prevents pointing the
 * worker / a route at a host unrelated to the site being onboarded.
 */
const hostInSiteDomain = (host, baseURL) => {
  const siteHost = new URL(baseURL).hostname.replace(/^www\./i, '').toLowerCase();
  const h = host.toLowerCase();
  return h === siteHost || h.endsWith(`.${siteHost}`);
};

/**
 * Extracts the host from a Cloudflare route pattern (e.g. "*.example.com/path*" -> "example.com",
 * "https://www.example.com/*" -> "www.example.com"), stripping any scheme and leading wildcard.
 */
const routePatternHost = (pattern) => pattern
  .replace(/^https?:\/\//i, '')
  .split('/')[0]
  .replace(/^\*\.?/, '');

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
  const cfErrorResponse = (error, action) => {
    const message = error?.message || String(error);
    log.error(`Cloudflare ${action} failed: ${message}`);
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
      return cfErrorResponse(e, action);
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

  // GET /sites/:siteId/llmo/cdn-onboard/cloudflare/zones
  const listZones = cfListProxy('listZones', 'zone listing');

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/cloudflare/deploy
   * Body: { accountId, targetHost }
   * Fetches the Edge Optimize worker script from GitHub and deploys it under a name derived
   * from the site (see deriveWorkerName), then sets the LLMO API key as the
   * EDGE_OPTIMIZE_API_KEY secret on the worker.
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

    let llmoApiKey;
    try {
      llmoApiKey = await getLlmoApiKey(site, context);
    } catch (e) {
      log.error(`Failed to fetch LLMO metaconfig for site ${site.getId()}: ${e.message}`);
      return createResponse({ message: 'Failed to fetch site metaconfig' }, 502);
    }
    if (!hasText(llmoApiKey)) {
      log.error(`No LLMO API key found for site ${site.getId()}`);
      return internalServerError('LLMO API key not configured for this site');
    }

    let workerScript;
    try {
      workerScript = await fetchWorkerScript();
    } catch (e) {
      return cfErrorResponse(e, 'worker script fetch');
    }

    const bindings = [
      { name: EDGE_OPTIMIZE_TARGET_HOST_BINDING, type: 'plain_text', text: targetHost },
    ];

    try {
      await cfClient.deployWorkerScript(accountId, scriptName, workerScript, bindings);
    } catch (e) {
      return cfErrorResponse(e, 'worker deployment');
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
      log.error(
        `Worker '${scriptName}' deployed for site ${site.getId()} but setting the `
        + `${EDGE_OPTIMIZE_API_KEY_SECRET} secret failed: ${e.message}. `
        + 'The worker is live but non-functional and must be re-deployed.',
      );
      return createResponse({
        message: 'Worker deployed but failed to set its API key secret; '
          + 'the worker is live but not yet functional. Re-deploy to complete setup.',
        scriptName,
        accountId,
        partial: true,
      }, 502);
    }

    log.info(`Deployed Cloudflare worker '${scriptName}' for site ${site.getId()}`);
    return ok({ scriptName, accountId, targetHost });
  };

  /**
   * POST /sites/:siteId/llmo/cdn-onboard/cloudflare/zones/:zoneId/routes
   * Body: { pattern }
   * Verifies server-side that the pattern targets the site's own domain and does not collide
   * with an existing route in the zone before creating it, so a deploy cannot silently override
   * a route the customer already has.
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

    const { zoneId } = context.params;
    if (!hasText(zoneId)) {
      return badRequest('Missing zoneId');
    }
    if (!CF_ID_RE.test(zoneId)) {
      return badRequest('zoneId must be a 32-character hexadecimal Cloudflare zone ID');
    }

    const { pattern } = context.data || {};

    if (!hasText(pattern)) {
      return badRequest('Missing pattern in request body');
    }
    if (!hostInSiteDomain(routePatternHost(pattern), site.getBaseURL())) {
      return badRequest('route pattern must target the site\'s domain');
    }

    // Guard against overriding an existing route: fetch the zone's current routes and reject
    // if the requested pattern already exists.
    let existingRoutes;
    try {
      existingRoutes = await cfClient.listRoutes(zoneId);
    } catch (e) {
      return cfErrorResponse(e, 'route lookup');
    }

    const conflict = (existingRoutes || []).find((route) => route?.pattern === pattern);
    if (conflict) {
      log.info(`Route pattern '${pattern}' already exists in zone ${zoneId}; refusing to override`);
      return createResponse({
        message: `A route for pattern '${pattern}' already exists in this zone`,
        existingRoute: conflict,
      }, 409);
    }

    try {
      const route = await cfClient.addRoute(zoneId, pattern, scriptName);
      return ok(route);
    } catch (e) {
      return cfErrorResponse(e, 'route creation');
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
