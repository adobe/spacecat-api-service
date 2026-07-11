/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import wrap from '@adobe/helix-shared-wrap';
import { helixStatus } from '@adobe/helix-status';
import vaultSecrets from '@adobe/spacecat-shared-vault-secrets';
import bodyData from '@adobe/helix-shared-body-data';
import {
  badRequest,
  compressResponse,
  internalServerError,
  noContent,
  notFound,
  authWrapper,
  enrichPathInfo,
  ScopedApiKeyHandler,
  AdobeImsHandler,
  JwtHandler,
  s2sAuthWrapper,
  readOnlyAdminWrapper,
  facsWrapper,
} from '@adobe/spacecat-shared-http-utils';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import { imsClientWrapper } from '@adobe/spacecat-shared-ims-client';
import {
  elevatedSlackClientWrapper,
  SLACK_TARGETS,
} from '@adobe/spacecat-shared-slack-client';
import { hasText, isValidUUID, logWrapper } from '@adobe/spacecat-shared-utils';
import { traceIdResponseWrapper } from './support/trace-id-response-wrapper.js';

import dataAccess from './support/data-access.js';
import sqs from './support/sqs.js';
import getRouteHandlers from './routes/index.js';
import matchPath, { sanitizePath } from './utils/route-utils.js';

import AuditsController from './controllers/audits.js';
import OrganizationsController from './controllers/organizations.js';
import ProjectsController from './controllers/project.js';
import SitesController from './controllers/sites.js';
import ExperimentsController from './controllers/experiments.js';
import HooksController from './controllers/hooks.js';
import SlackController from './controllers/slack.js';
import SitesAuditsToggleController from './controllers/sites-audits-toggle.js';
import trigger from './controllers/trigger.js';

// prevents webpack build error
import { App as SlackApp } from './utils/slack/bolt.cjs';
import ConfigurationController from './controllers/configuration.js';
import FulfillmentController from './controllers/event/fulfillment.js';
import { FixesController } from './controllers/fixes.js';
import ImportController from './controllers/import.js';
import { s3ClientWrapper } from './support/s3.js';
import { multipartFormData } from './support/multipart-form-data.js';
import ApiKeyController from './controllers/api-key.js';
import OpportunitiesController from './controllers/opportunities.js';
import PaidController from './controllers/paid.js';
import TopPaidOpportunitiesController from './controllers/paid/top-paid-opportunities.js';
import TrafficController from './controllers/paid/traffic.js';
import SuggestionsController from './controllers/suggestions.js';
import BrandsController from './controllers/brands.js';
import PreflightController from './controllers/preflight.js';
import SiteDetectionController from './controllers/site-detection.js';
import DemoController from './controllers/demo.js';
import ConsentBannerController from './controllers/consentBanner.js';
import ScrapeController from './controllers/scrape.js';
import RedirectsController from './controllers/redirects.js';
import ScrapeJobController from './controllers/scrapeJob.js';
import ReportsController from './controllers/reports.js';
import LlmoController from './controllers/llmo/llmo.js';
import LlmoCloudflareController from './controllers/llmo/llmo-cloudflare.js';
import LlmoCloudFrontController from './controllers/llmo/llmo-cloudfront.js';
import LlmoAkamaiController from './controllers/llmo/llmo-akamai.js';
import LlmoMysticatController from './controllers/llmo/llmo-mysticat-controller.js';
import LlmoOpportunitiesController from './controllers/llmo/opportunities/llmo-opportunities-controller.js';
import FanoutReportController from './controllers/llmo/fanout-report.js';
import UserActivitiesController from './controllers/user-activities.js';
import SiteEnrollmentsController from './controllers/site-enrollments.js';
import TrialUsersController from './controllers/trial-users.js';
import UserDetailsController from './controllers/user-details.js';
import EntitlementsController from './controllers/entitlements.js';
import SandboxAuditController from './controllers/sandbox-audit.js';
import EphemeralRunController from './controllers/ephemeral-run.js';
import UrlStoreController from './controllers/url-store.js';
import PTA2Controller from './controllers/paid/pta2.js';
import TrafficToolsController from './controllers/paid/traffic-tools.js';
import BotBlockerController from './controllers/bot-blocker.js';
import SentimentController from './controllers/sentiment.js';
import ConsumersController from './controllers/consumers.js';
import TokensController from './controllers/tokens.js';
import ImsOrgAccessController from './controllers/ims-org-access.js';
import FeatureFlagsController from './controllers/feature-flags.js';
import AutofixChecksController from './controllers/autofix-checks.js';
import DrsBpPgAuditController from './controllers/drs-bp-pg-audit.js';
import routeRequiredCapabilities, { INTERNAL_ROUTES } from './routes/required-capabilities.js';
import routeFacsCapabilities from './routes/facs-capabilities.js';
import ContactSalesLeadsController from './controllers/contact-sales-leads.js';
import PageRelationshipsController from './controllers/page-relationships.js';
import PlgOnboardingController from './controllers/plg/plg-onboarding.js';
import WebhooksController from './controllers/webhooks.js';
import AiVisibilityController from './controllers/ai-visibility.js';
import StateAccessMappingsController from './controllers/state-access-mappings.js';
import AgenticCategoriesController from './controllers/agentic-categories.js';
import AgenticPageTypesController from './controllers/agentic-page-types.js';
import SerenityController from './controllers/serenity.js';
import ElementsController from './controllers/elements.js';
import ProxyController from './controllers/proxy.js';
import ProfilesController from './controllers/profiles.js';
import WorkflowsController from './controllers/workflows.js';
import GitHubWebhookHmacHandler from './support/github-webhook-hmac-handler.js';
import AsoOverlayKeyHandler from './support/aso-overlay-key-handler.js';
import ApiKeyImsHandler from './support/api-key-ims-handler.js';
import RouteScopedLegacyApiKeyHandler from './support/route-scoped-legacy-api-key-handler.js';

// Accept any RFC 4122 / 9562-defined UUID version (v1..v8) instead of
// v4-only. Version nibble `[1-8]` covers all allocated versions; v0/nil
// (reserved) and v9..vF (unallocated) are still rejected. The clock-seq
// variant nibble is independently clamped to `[89ab]` (the `10xx` RFC
// variant) so genuinely malformed strings still fail. Version and variant
// are distinct UUID concepts — keeping that separation explicit in the regex.
//
// Why widen: producer-side IDs are progressively migrating to UUID v7 for
// sortable keys (Mystique-allocated site/opportunity IDs already use v7),
// and rejecting them at the API gateway breaks otherwise-valid routes
// (e.g. GET /sites/{siteId}/opportunities returns 400 "Site Id is invalid").
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUUIDAnyVersion = (uuid) => uuidRegex.test(uuid);

/**
 * LOCAL DEVELOPMENT ONLY - CORS middleware wrapper
 * Adds CORS headers to responses when ENABLE_CORS=true
 */
/* c8 ignore start */
function localCORSWrapper(fn) {
  return async (request, context) => {
    const response = await fn(request, context);
    const { env } = context;
    const enableCors = env.ENABLE_CORS === 'true';

    if (enableCors) {
      const allowedOrigins = (env.CORS_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim());
      const origin = request.headers.get('origin');

      if (origin && allowedOrigins.includes(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Credentials', 'true');
      }

      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key, x-ims-org-id, x-client-type, x-import-api-key, '
        + 'x-trigger-audits, x-requested-with, origin, accept, x-view-as-trial, x-product, x-promise-token',
      );
      response.headers.set('Access-Control-Max-Age', '86400');
    }

    return response;
  };
}
/* c8 ignore stop */

/* c8 ignore start */
/**
 * Auth handler that bypasses authentication when SKIP_AUTH=true.
 * For local development only — injects a mock admin identity.
 */
class SkipAuthHandler extends AbstractHandler {
  constructor(log) {
    super('skipAuth', log);
  }

  // eslint-disable-next-line no-unused-vars,class-methods-use-this
  async checkAuth(request, context) {
    if (context.env?.SKIP_AUTH !== 'true') {
      return null;
    }
    // Defense-in-depth: refuse to skip auth in a deployed Lambda environment
    if (context.func?.name || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      this.log('SKIP_AUTH is true but running in Lambda - ignoring', 'warn');
      return null;
    }
    this.log('SKIP_AUTH is true - injecting mock admin identity', 'info');
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({
        user_id: 'local-dev-admin',
        email: 'admin@localhost',
        is_admin: true,
        tenants: [],
      })
      .withType('api_key')
      .withScopes([{ name: 'admin' }]);
  }
}
/* c8 ignore stop */

/**
 * This is the main function
 * @param {Request} request the request object (see fetch api)
 * @param {UniversalContext} context the context of the universal serverless function
 * @returns {Response} a response
 */
async function run(request, context) {
  const { log, pathInfo } = context;
  const { route, suffix, method } = pathInfo;

  if (!hasText(route)) {
    log.info(`Unable to extract path info. Wrong format: ${suffix}`);
    return notFound('wrong path format');
  }

  if (method === 'OPTIONS') {
    return noContent({
      'access-control-allow-methods': 'GET, HEAD, PATCH, POST, OPTIONS, DELETE',
      'access-control-allow-headers': 'x-api-key, authorization, origin, x-requested-with, content-type, accept, x-import-api-key, x-client-type, x-trigger-audits, x-view-as-trial, x-promise-token',
      'access-control-max-age': '86400',
      'access-control-allow-origin': '*',
    });
  }

  const t0 = Date.now();

  try {
    /* ---------- instantiate controllers once per request ---------- */
    const auditsController = AuditsController(context);
    const configurationController = ConfigurationController(context);
    const hooksController = HooksController(context);
    const organizationsController = OrganizationsController(context, context.env);
    const projectsController = ProjectsController(context, context.env);
    const sitesController = SitesController(context, log, context.env);
    const experimentsController = ExperimentsController(context);
    const slackController = SlackController(SlackApp);
    const fulfillmentController = FulfillmentController(context);
    const importController = ImportController(context);
    const apiKeyController = ApiKeyController(context);
    const sitesAuditsToggleController = SitesAuditsToggleController(context);
    const opportunitiesController = OpportunitiesController(context);
    const suggestionsController = SuggestionsController(context, context.sqs, context.env);
    const brandsController = BrandsController(context, log, context.env);
    const paidController = PaidController(context);
    const topPaidOpportunitiesController = TopPaidOpportunitiesController(context, context.env);
    const trafficController = TrafficController(context, log, context.env);
    const preflightController = PreflightController(context, log, context.env);
    const siteDetectionController = SiteDetectionController(context, log, context.env);
    const demoController = DemoController(context);
    const consentBannerController = ConsentBannerController(context);
    const scrapeController = ScrapeController(context);
    const redirectsController = RedirectsController(context);
    const scrapeJobController = ScrapeJobController(context);
    const reportsController = ReportsController(context, log, context.env);
    const llmoController = LlmoController(context);
    const llmoCloudflareController = LlmoCloudflareController(context);
    const llmoCloudFrontController = LlmoCloudFrontController(context);
    const llmoAkamaiController = LlmoAkamaiController(context);
    const llmoMysticatController = LlmoMysticatController(context);
    const llmoOpportunitiesController = LlmoOpportunitiesController(context);
    const fanoutReportController = FanoutReportController(context);
    const fixesController = new FixesController(context);
    const userActivitiesController = UserActivitiesController(context);
    const siteEnrollmentsController = SiteEnrollmentsController(context);
    const trialUsersController = TrialUsersController(context);
    const userDetailsController = UserDetailsController(context);
    const entitlementsController = EntitlementsController(context);
    const sandboxAuditController = SandboxAuditController(context);
    const ephemeralRunController = EphemeralRunController(context);
    const urlStoreController = UrlStoreController(context, log);
    const pta2Controller = PTA2Controller(context, log, context.env);
    const trafficToolsController = TrafficToolsController(context, log, context.env);
    const botBlockerController = BotBlockerController(context, log);
    const sentimentController = SentimentController(context, log);
    const consumersController = ConsumersController(context);
    const tokensController = TokensController(context);
    const imsOrgAccessController = ImsOrgAccessController(context);
    const contactSalesLeadsController = ContactSalesLeadsController(context);
    const featureFlagsController = FeatureFlagsController(context);
    const autofixChecksController = AutofixChecksController(context);
    const pageRelationshipsController = PageRelationshipsController(context);
    const plgOnboardingController = PlgOnboardingController(context);
    const drsBpPgAuditController = DrsBpPgAuditController(context);
    const webhooksController = WebhooksController(context);
    const aiVisibilityController = AiVisibilityController(context, log, context.env);
    const stateAccessMappingsController = StateAccessMappingsController(context);
    const agenticCategoriesController = AgenticCategoriesController();
    const agenticPageTypesController = AgenticPageTypesController();
    const serenityController = SerenityController(context, log, context.env);
    const elementsController = ElementsController(context, log, context.env);
    const proxyController = ProxyController();
    const profilesController = ProfilesController(context, log, context.env);
    const workflowsController = WorkflowsController(context, log);

    const routeHandlers = getRouteHandlers(
      auditsController,
      configurationController,
      hooksController,
      organizationsController,
      projectsController,
      sitesController,
      experimentsController,
      slackController,
      trigger,
      fulfillmentController,
      importController,
      apiKeyController,
      sitesAuditsToggleController,
      opportunitiesController,
      suggestionsController,
      brandsController,
      preflightController,
      demoController,
      consentBannerController,
      scrapeController,
      scrapeJobController,
      paidController,
      topPaidOpportunitiesController,
      trafficController,
      fixesController,
      llmoController,
      llmoCloudflareController,
      llmoCloudFrontController,
      llmoAkamaiController,
      llmoMysticatController,
      llmoOpportunitiesController,
      userActivitiesController,
      siteEnrollmentsController,
      trialUsersController,
      userDetailsController,
      entitlementsController,
      sandboxAuditController,
      reportsController,
      urlStoreController,
      pta2Controller,
      trafficToolsController,
      botBlockerController,
      sentimentController,
      consumersController,
      tokensController,
      imsOrgAccessController,
      contactSalesLeadsController,
      featureFlagsController,
      pageRelationshipsController,
      ephemeralRunController,
      autofixChecksController,
      siteDetectionController,
      plgOnboardingController,
      drsBpPgAuditController,
      webhooksController,
      aiVisibilityController,
      fanoutReportController,
      stateAccessMappingsController,
      agenticCategoriesController,
      agenticPageTypesController,
      serenityController,
      elementsController,
      proxyController,
      redirectsController,
      profilesController,
      workflowsController,
    );

    const routeMatch = matchPath(method, suffix, routeHandlers);

    if (routeMatch) {
      const { handler, params } = routeMatch;

      if (params.siteId && !isValidUUIDAnyVersion(params.siteId)) {
        return badRequest('Site Id is invalid. Please provide a valid UUID.');
      }
      if (params.organizationId
        && (!isValidUUIDAnyVersion(params.organizationId) && params.organizationId !== 'default')) {
        return badRequest('Organization Id is invalid. Please provide a valid UUID.');
      }
      if (params.spaceCatId && !isValidUUID(params.spaceCatId)) {
        return badRequest('Organization Id (spaceCatId) is invalid. Please provide a valid UUID.');
      }
      if (params.brandId && params.brandId !== 'all' && !isValidUUID(params.brandId)) {
        return badRequest('Brand Id is invalid. Please provide a valid UUID or "all".');
      }
      if (params.plgOnboardingId && !isValidUUIDAnyVersion(params.plgOnboardingId)) {
        return badRequest('PLG Onboarding Id is invalid. Please provide a valid UUID.');
      }
      if (params.onboardingId && !isValidUUIDAnyVersion(params.onboardingId)) {
        return badRequest('PLG Onboarding Id is invalid. Please provide a valid UUID.');
      }
      if (params.executionId && !isValidUUID(params.executionId)) {
        return badRequest('Execution Id is invalid. Please provide a valid UUID.');
      }
      if (params.jobId && !isValidUUIDAnyVersion(params.jobId)) {
        return badRequest('Job Id is invalid. Please provide a valid UUID.');
      }
      if (params.preflightId && !isValidUUID(params.preflightId)) {
        return badRequest('Preflight Id is invalid. Please provide a valid UUID.');
      }
      context.params = params;
      context.request = request;

      return await handler(context);
    } else {
      const notFoundMessage = `no such route /${route}`;
      return notFound(notFoundMessage);
    }
  } catch (e) {
    const t1 = Date.now();
    log.error(`Handler exception after ${t1 - t0} ms. Path: ${sanitizePath(suffix)}`, e);
    return internalServerError(e.message);
  }
}

const { WORKSPACE_EXTERNAL } = SLACK_TARGETS;

// Wrapper execution order (helix-shared-wrap: last .with() = outermost = runs first):
// 1. s2sAuthWrapper — intercepts S2S JWT bearer tokens, passes through non-S2S to authWrapper
// 2. authWrapper — handles JWT, IMS, scoped API key, route-scoped legacy API key
// 3. readOnlyAdminWrapper — enforces read-only access for read-only admin tokens (see
//    adobe/spacecat-shared#1469); routes not present in routeCapabilities default to deny
//    (fail-closed), so unmapped routes are blocked for read-only admins
// 4. facsWrapper — innermost (runs last, just before the route handler): enforces the
//    hybrid MAC/FACS permission model (JWT facs_permissions ∪ state-layer grants) for
//    FACS-governed external callers; internal identities and non-enrolled orgs bypass
//
// authHandlers order contract:
//  - SkipAuthHandler first: local-dev escape hatch (no-op in Lambda).
//  - GitHubWebhookHmacHandler next: path-scoped to /webhooks/* and returns null
//    for any other path, so non-webhook requests fall through cheaply. Must run
//    BEFORE path-agnostic handlers so a webhook request does not reach JwtHandler
//    / AdobeImsHandler and fail with a misleading 401 on a missing JWT.
//  - AsoOverlayKeyHandler: path-scoped to GET /config/.../redirects.txt; validates
//    the inbound X-ASO-API-Key (the ASO dispatcher-overlay read path). Returns null
//    for any other route. Same early-bail rationale as the webhook handler. Interim
//    static-key bridge — deletable once the dispatcher presents S2S (see ADR).
//  - JwtHandler: tried first for token-bearing requests (JWT path is the target
//    end-state for all consumers). S2S consumers use s2sAuthWrapper; all new
//    service integrations must onboard via S2S (SITES-34224).
//  - ApiKeyImsHandler: route-scoped IMS handler (/tools/api-keys/*) for IaaS-only
//    orgs that cannot acquire a JWT session token. Returns null for other paths,
//    falling through to AdobeImsHandler. Once Auto-Fix (ASO-607) migrates and
//    AdobeImsHandler is removed, this scoped handler keeps IaaS key management
//    working without re-introducing a global IMS auth backdoor.
//  - AdobeImsHandler: legacy global IMS path; kept for routes still on IMS auth
//    (e.g. Auto-Fix). To be removed once all consumers are JWT-migrated.
//  - ScopedApiKeyHandler: scoped API-key auth for Import-as-a-Service.
//  - RouteScopedLegacyApiKeyHandler: the only remaining legacy-key surface. Owns
//    exactly two routes whose external callers cannot be onboarded as IMS S2S
//    consumers: POST /event/fulfillment (external fulfillment webhook) and
//    POST /slack/channels/invite-by-user-id (external Slack integration).
//    Returns null for every other path. The list is frozen — no new routes will
//    be added; every new service integration must use S2S (SITES-34224).
// When adding a new path-scoped handler, place it in the same position (after
// SkipAuthHandler, before the path-agnostic handlers) to preserve early-bail.
// AUTH_HANDLERS order is enforced by test/auth-handlers-order.test.js.
const AUTH_HANDLERS = [
  SkipAuthHandler,
  GitHubWebhookHmacHandler,
  AsoOverlayKeyHandler,
  JwtHandler,
  ApiKeyImsHandler,
  AdobeImsHandler,
  ScopedApiKeyHandler,
  RouteScopedLegacyApiKeyHandler,
];

const wrappedMain = wrap(run)
  // Innermost: runs after auth wrappers have populated authInfo and after
  // dataAccess/enrichPathInfo (applied on `main`), but before the route handler.
  // Enforces the hybrid MAC/FACS model (JWT facs_permissions ∪ state-layer grants)
  // for FACS-governed external callers; internal identities and non-enrolled orgs
  // bypass. See routeFacsCapabilities for route → capability classification.
  .with(facsWrapper, { routeFacsCapabilities })
  .with(readOnlyAdminWrapper, {
    routeCapabilities: routeRequiredCapabilities,
    internalRoutes: INTERNAL_ROUTES,
  })
  .with(authWrapper, { authHandlers: AUTH_HANDLERS })
  .with(s2sAuthWrapper, { routeCapabilities: routeRequiredCapabilities });

export const main = wrappedMain
  .with(localCORSWrapper)
  .with(traceIdResponseWrapper)
  .with(logWrapper)
  .with(dataAccess)
  .with(bodyData)
  .with(multipartFormData)
  .with(enrichPathInfo)
  .with(sqs)
  .with(s3ClientWrapper)
  .with(imsClientWrapper)
  .with(elevatedSlackClientWrapper, { slackTarget: WORKSPACE_EXTERNAL })
  .with(vaultSecrets)
  .with(compressResponse)
  .with(helixStatus);
