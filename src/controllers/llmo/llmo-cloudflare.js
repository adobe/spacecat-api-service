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
  ok, badRequest, notFound, forbidden, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import CloudflareClient from '@adobe/spacecat-shared-cloudflare-client';
import AccessControlUtil from '../../support/access-control-util.js';

const CF_TOKEN_HEADER = 'x-cloudflare-token';
const CF_TOKEN_MISSING = 'Missing x-cloudflare-token header';
const EDGE_OPTIMIZE_API_KEY_SECRET = 'EDGE_OPTIMIZE_API_KEY';
const EDGE_OPTIMIZE_TARGET_HOST_BINDING = 'EDGE_OPTIMIZE_TARGET_HOST';
const WORKER_SCRIPT_URL = 'https://raw.githubusercontent.com/adobe/llmo-code-samples/main/optimize-at-edge/cloudflare/automation/src/worker.js';

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

  const getLlmoApiKey = async (site, context) => {
    const tokowaka = TokowakaClient.createFrom(context);
    const metaconfig = await tokowaka.fetchMetaconfig(site.getBaseURL());
    return metaconfig?.apiKeys?.[0] ?? null;
  };

  const fetchWorkerScript = async () => {
    const res = await fetch(WORKER_SCRIPT_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch worker script: ${res.status} ${res.statusText}`);
    }
    return res.text();
  };

  /**
   * GET /sites/:siteId/llmo/onboarding/cloudflare/config
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

  /**
   * GET /sites/:siteId/llmo/onboarding/cloudflare/accounts
   */
  const listAccounts = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }

    const cfToken = getCfToken(context);
    if (!cfToken) {
      return badRequest(CF_TOKEN_MISSING);
    }

    const cfClient = new CloudflareClient({ token: cfToken }, log);
    const accounts = await cfClient.listAccounts();
    return ok(accounts);
  };

  /**
   * GET /sites/:siteId/llmo/onboarding/cloudflare/zones
   */
  const listZones = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }

    const cfToken = getCfToken(context);
    if (!cfToken) {
      return badRequest(CF_TOKEN_MISSING);
    }

    const cfClient = new CloudflareClient({ token: cfToken }, log);
    const zones = await cfClient.listZones();
    return ok(zones);
  };

  /**
   * GET /sites/:siteId/llmo/onboarding/cloudflare/zones/:zoneId/routes
   */
  const listRoutes = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }

    const cfToken = getCfToken(context);
    if (!cfToken) {
      return badRequest(CF_TOKEN_MISSING);
    }

    const { zoneId } = context.params;
    if (!hasText(zoneId)) {
      return badRequest('Missing zoneId');
    }

    const cfClient = new CloudflareClient({ token: cfToken }, log);
    const routes = await cfClient.listRoutes(zoneId);
    return ok(routes);
  };

  /**
   * POST /sites/:siteId/llmo/onboarding/cloudflare/deploy
   * Body: { accountId, scriptName, targetHost }
   * Fetches the Edge Optimize worker script from GitHub, deploys it, then sets the
   * LLMO API key as the EDGE_OPTIMIZE_API_KEY secret on the worker.
   */
  const deployWorker = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }
    const { site } = result;

    const cfToken = getCfToken(context);
    if (!cfToken) {
      return badRequest(CF_TOKEN_MISSING);
    }

    const body = await context.request.json();
    const { accountId, scriptName, targetHost } = body || {};

    if (!hasText(accountId)) {
      return badRequest('Missing accountId in request body');
    }
    if (!hasText(scriptName)) {
      return badRequest('Missing scriptName in request body');
    }
    if (!hasText(targetHost)) {
      return badRequest('Missing targetHost in request body');
    }

    const llmoApiKey = await getLlmoApiKey(site, context);
    if (!hasText(llmoApiKey)) {
      log.error(`No LLMO API key found for site ${site.getId()}`);
      return internalServerError('LLMO API key not configured for this site');
    }

    const workerScript = await fetchWorkerScript();

    const cfClient = new CloudflareClient({ token: cfToken }, log);

    const bindings = [
      { name: EDGE_OPTIMIZE_TARGET_HOST_BINDING, type: 'plain_text', text: targetHost },
    ];

    await cfClient.deployWorkerScript(accountId, scriptName, workerScript, bindings);
    await cfClient.setWorkerSecret(accountId, scriptName, EDGE_OPTIMIZE_API_KEY_SECRET, llmoApiKey);

    log.info(`Deployed Cloudflare worker '${scriptName}' for site ${site.getId()}`);
    return ok({ scriptName, accountId, targetHost });
  };

  /**
   * POST /sites/:siteId/llmo/onboarding/cloudflare/zones/:zoneId/routes
   * Body: { pattern, scriptName }
   */
  const addRoute = async (context) => {
    const result = await getSiteAndCheckAccess(context);
    if (result.status) {
      return result;
    }

    const cfToken = getCfToken(context);
    if (!cfToken) {
      return badRequest(CF_TOKEN_MISSING);
    }

    const { zoneId } = context.params;
    if (!hasText(zoneId)) {
      return badRequest('Missing zoneId');
    }

    const body = await context.request.json();
    const { pattern, scriptName } = body || {};

    if (!hasText(pattern)) {
      return badRequest('Missing pattern in request body');
    }
    if (!hasText(scriptName)) {
      return badRequest('Missing scriptName in request body');
    }

    const cfClient = new CloudflareClient({ token: cfToken }, log);
    const route = await cfClient.addRoute(zoneId, pattern, scriptName);
    return ok(route);
  };

  return {
    getCloudflareConfig,
    listAccounts,
    listZones,
    listRoutes,
    deployWorker,
    addRoute,
  };
}

export default LlmoCloudflareController;
