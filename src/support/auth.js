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
import { Response } from '@adobe/fetch';

export const ADMIN_ENDPOINTS = ['trigger']; // export for testing

/*
 * Placeholder authwrapper until a better one replaces
 */
export default function authWrapper(fn) {
  return async (request, context) => {
    const { log, pathInfo: { headers, route } } = context;

    const apiKeyFromHeader = headers['x-api-key'];

    if (!apiKeyFromHeader) {
      return new Response('API key missing in headers', {
        status: 400,
        headers: { 'x-error': 'API key missing' },
      });
    }

    const expectedApiKey = ADMIN_ENDPOINTS.includes(route)
      ? context.env.ADMIN_API_KEY
      : context.env.USER_API_KEY;

    if (!expectedApiKey) {
      log.error('API key was not configured');
      return new Response('Server configuration error', {
        status: 500,
      });
    }

    if (apiKeyFromHeader !== expectedApiKey) {
      return new Response('Not authorized', {
        status: 401,
        headers: { 'x-error': 'Incorrect or missing API key' },
      });
    }

    return fn(request, context);
  };
}
