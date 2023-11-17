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
import auth from './support/auth.js';
import sqs from './support/sqs.js';
import trigger from './trigger/handler.js';

const HANDLERS = {
  trigger,
};

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

  if (!route) {
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

  const handler = HANDLERS[route];
  if (!handler) {
    const msg = `no such route /${route}`;
    log.error(msg);
    return new Response('', {
      status: 404,
      headers: {
        'x-error': msg,
      },
    });
  }

  const t0 = Date.now();

  try {
    return await handler(context);
  } catch (e) {
    const t1 = Date.now();
    log.error(`Handler exception after ${t1 - t0}ms`, e);
    return new Response('', {
      status: e.statusCode || 500,
      headers: {
        'x-error': 'internal server error',
      },
    });
  }
}

export const main = wrap(run)
  .with(auth)
  .with(enrichPathInfo)
  .with(bodyData)
  .with(sqs)
  .with(secrets)
  .with(helixStatus);
