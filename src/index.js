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
  internalServerError,
  noContent,
  notFound,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, resolveSecretsName } from '@adobe/spacecat-shared-utils';

import auth from './support/auth.js';
import sqs from './support/sqs.js';
import getRouteHandlers from './routes/index.js';
import matchPath from './utils/route-utils.js';

import AuditsController from './controllers/audits.js';
import OrganizationsController from './controllers/organizations.js';
import SitesController from './controllers/sites.js';
import SlackController from './controllers/slack.js';
import trigger from './controllers/trigger.js';

// prevents webpack build error
import { App as SlackApp } from './utils/slack/bolt.cjs';
import FulfillmentsController from './controllers/event/fulfillments.js';

export function enrichPathInfo(fn) { // export for testing
  return async (request, context) => {
    const [_, route] = context?.pathInfo?.suffix?.split(/\/+/) || [];
    context.pathInfo = {
      ...context.pathInfo,
      ...{
        method: request.method.toUpperCase(),
        headers: request.headers.plain(),
        route,
      },
    };
    return fn(request, context);
  };
}

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
      'access-control-allow-headers': 'x-api-key, origin, x-requested-with, content-type, accept',
      'access-control-max-age': '86400',
      'access-control-allow-origin': '*',
    });
  }

  const t0 = Date.now();

  try {
    const routeHandlers = getRouteHandlers(
      AuditsController(context.dataAccess),
      OrganizationsController(context.dataAccess, log),
      SitesController(context.dataAccess, log),
      SlackController(SlackApp),
      trigger,
      FulfillmentsController(context.dataAccess),
    );

    const routeMatch = matchPath(method, suffix, routeHandlers);

    if (routeMatch) {
      const { handler, params } = routeMatch;
      context.params = params;

      return await handler(context);
    } else {
      const notFoundMessage = `no such route /${route}`;
      log.info(notFoundMessage);
      return notFound(notFoundMessage);
    }
  } catch (e) {
    const t1 = Date.now();
    log.error(`Handler exception after ${t1 - t0} ms`, e);
    return internalServerError(e.message);
  }
}

export const main = wrap(run)
  .with(dataAccess)
  .with(auth)
  .with(enrichPathInfo)
  .with(bodyData)
  .with(sqs)
  .with(secrets, { name: resolveSecretsName })
  .with(helixStatus);
