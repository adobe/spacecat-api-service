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
import secrets from '@adobe/helix-shared-secrets';
import bodyData from '@adobe/helix-shared-body-data';
import dataAccess from '@adobe/spacecat-shared-data-access';
import {
  badRequest,
  internalServerError,
  noContent,
  notFound,
  authWrapper,
  enrichPathInfo,
  LegacyApiKeyHandler,
  ScopedApiKeyHandler,
  AdobeImsHandler,
} from '@adobe/spacecat-shared-http-utils';
import { imsClientWrapper } from '@adobe/spacecat-shared-ims-client';
import {
  elevatedSlackClientWrapper,
  SLACK_TARGETS,
} from '@adobe/spacecat-shared-slack-client';
import { hasText, resolveSecretsName } from '@adobe/spacecat-shared-utils';

import sqs from './support/sqs.js';
import getRouteHandlers from './routes/index.js';
import matchPath, { sanitizePath } from './utils/route-utils.js';

import AuditsController from './controllers/audits.js';
import OrganizationsController from './controllers/organizations.js';
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
import ImportController from './controllers/import.js';
import { s3ClientWrapper } from './support/s3.js';
import { multipartFormData } from './support/multipart-form-data.js';
import ApiKeyController from './controllers/api-key.js';
import OpportunitiesController from './controllers/opportunities.js';
import SuggestionsController from './controllers/suggestions.js';
import BrandsController from './controllers/brands.js';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUUIDV4 = (uuid) => uuidRegex.test(uuid);

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
      'access-control-allow-headers': 'x-api-key, authorization, origin, x-requested-with, content-type, accept, x-import-api-key',
      'access-control-max-age': '86400',
      'access-control-allow-origin': '*',
    });
  }

  const t0 = Date.now();

  try {
    const routeHandlers = getRouteHandlers(
      AuditsController(context.dataAccess),
      ConfigurationController(context.dataAccess),
      HooksController(context),
      OrganizationsController(context.dataAccess, context.env),
      SitesController(context.dataAccess, log, context.env),
      ExperimentsController(context.dataAccess),
      SlackController(SlackApp),
      trigger,
      FulfillmentController(context),
      ImportController(context),
      ApiKeyController(context),
      SitesAuditsToggleController(context.dataAccess),
      OpportunitiesController(context.dataAccess),
      SuggestionsController(context.dataAccess, context.sqs, context.env),
      BrandsController(context.dataAccess, log, context.env),
    );

    const routeMatch = matchPath(method, suffix, routeHandlers);

    if (routeMatch) {
      const { handler, params } = routeMatch;
      //
      if (params.siteId && !isValidUUIDV4(params.siteId)) {
        return badRequest('Site Id is invalid. Please provide a valid UUID.');
      }
      if (params.organizationId && (!isValidUUIDV4(params.organizationId) && params.organizationId !== 'default')) {
        return badRequest('Organization Id is invalid. Please provide a valid UUID.');
      }
      context.params = params;

      return await handler(context);
    } else {
      const notFoundMessage = `no such route /${route}`;
      log.info(notFoundMessage);
      return notFound(notFoundMessage);
    }
  } catch (e) {
    const t1 = Date.now();
    log.error(`Handler exception after ${t1 - t0} ms. Path: ${sanitizePath(suffix)}`, e);
    return internalServerError(e.message);
  }
}

const { WORKSPACE_EXTERNAL } = SLACK_TARGETS;

export const main = wrap(run)
  .with(authWrapper, { authHandlers: [LegacyApiKeyHandler, ScopedApiKeyHandler, AdobeImsHandler] })
  .with(dataAccess)
  .with(bodyData)
  .with(multipartFormData)
  .with(enrichPathInfo)
  .with(sqs)
  .with(s3ClientWrapper)
  .with(imsClientWrapper)
  .with(elevatedSlackClientWrapper, { slackTarget: WORKSPACE_EXTERNAL })
  .with(secrets, { name: resolveSecretsName })
  .with(helixStatus);
