/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import dataAccessV2 from '@adobe/spacecat-shared-data-access-v2';
import dataAccessV3 from '@adobe/spacecat-shared-data-access';
// TEMP: Local DB routing - import for creating a second PostgREST client
// eslint-disable-next-line import/no-extraneous-dependencies
import { PostgrestClient } from '@supabase/postgrest-js';
// END TEMP

/**
 * Data access middleware wrapper that selects between v2 (DynamoDB) and v3 (Postgres)
 * based on the DATA_SERVICE_PROVIDER environment variable.
 *
 * @param {Function} fn - The next middleware/handler function to wrap.
 * @returns {Function} - The wrapped function.
 */
/* c8 ignore start */
export default function dataAccess(fn) {
  return async (request, context) => {
    const { env } = context;

    if (env.DATA_SERVICE_PROVIDER === 'postgres') {
      if (!env.POSTGREST_URL) {
        throw new Error(
          'DATA_SERVICE_PROVIDER is set to "postgres" but POSTGREST_URL is not configured',
        );
      }

      // TEMP: Local DB routing - Wrap fn to inject a local PostgREST client for URL Inspector
      const wrappedFn = async (req, ctx) => {
        if (env.POSTGREST_URL_LOCAL) {
          ctx.localPostgrestClient = new PostgrestClient(env.POSTGREST_URL_LOCAL, {
            schema: env.POSTGREST_SCHEMA || 'public',
            headers: {
              ...(env.POSTGREST_API_KEY_LOCAL ? {
                apikey: env.POSTGREST_API_KEY_LOCAL,
                Authorization: `Bearer ${env.POSTGREST_API_KEY_LOCAL}`,
              } : {}),
            },
          });
          ctx.log.info('TEMP: Local PostgREST client initialized for URL Inspector');
        }
        return fn(req, ctx);
      };
      // END TEMP

      return dataAccessV3(wrappedFn)(request, context);
    }
    return dataAccessV2(fn)(request, context);
  };
}
/* c8 ignore stop */
