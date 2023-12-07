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
import { Response } from '@adobe/fetch';
import secrets from '@adobe/helix-shared-secrets';
import bodyData from '@adobe/helix-shared-body-data';
import dataAccess from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import App from '@slack/bolt';

import auth from './support/auth.js';
import sqs from './support/sqs.js';
import getRouteHandlers from './routes/index.js';
import matchPath from './utils/route-utils.js';

import AuditsController from './controllers/audits.js';
import SitesController from './controllers/sites.js';
import SlackController from './controllers/slack.js';
import trigger from './controllers/trigger.js';
import SlackHandler from './support/slack-handler.js';

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

function initSlackBot(lambdaContext) {
  const { env, log } = lambdaContext;
  const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN } = env;

  const slackHandler = SlackHandler();

  if (!hasText(SLACK_SIGNING_SECRET)) {
    throw new Error('Missing SLACK_SIGNING_SECRET');
  }

  if (!hasText(SLACK_BOT_TOKEN)) {
    throw new Error('Missing SLACK_BOT_TOKEN');
  }

  const app = new App({
    signingSecret: SLACK_SIGNING_SECRET,
    token: SLACK_BOT_TOKEN,
    logger: {
      getLevel: () => log.level,
      setLevel: () => true,
      debug: log.debug.bind(log),
      info: log.info.bind(log),
      warn: log.warn.bind(log),
      error: log.error.bind(log),
    },
  });

  app.use(async ({ context, next }) => {
    context.dataAccess = lambdaContext.dataAccess;
    await next();
  });

  app.event('app_mention', slackHandler.onAppMention);

  return app;
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
    return new Response('', {
      status: 404,
      headers: {
        'x-error': 'wrong path format',
      },
    });
  }

  if (method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS, DELETE',
        'access-control-allow-headers': 'x-api-key',
        'access-control-max-age': '86400',
      },
    });
  }

  const t0 = Date.now();

  try {
    const routeHandlers = getRouteHandlers(
      AuditsController(context.dataAccess),
      SitesController(context.dataAccess),
      SlackController(initSlackBot(context)),
      trigger,
    );

    const routeMatch = matchPath(method, suffix, routeHandlers);

    if (routeMatch) {
      const { handler, params } = routeMatch;
      context.params = params;

      return await handler(context);
    } else {
      const msg = `no such route /${route}`;
      log.error(msg);
      return new Response('', {
        status: 404,
        headers: {
          'x-error': msg,
        },
      });
    }
  } catch (e) {
    const t1 = Date.now();
    log.error(`Handler exception after ${t1 - t0} ms`, e);
    return new Response('', {
      status: e.statusCode || 500,
      headers: {
        'x-error': 'internal server error',
      },
    });
  }
}

export const main = wrap(run)
  .with(dataAccess)
  .with(auth)
  .with(enrichPathInfo)
  .with(bodyData)
  .with(sqs)
  .with(secrets)
  .with(helixStatus);
