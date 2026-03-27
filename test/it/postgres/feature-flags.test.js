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

// transitive dep via @adobe/spacecat-shared-data-access
// eslint-disable-next-line import/no-extraneous-dependencies
import { PostgrestClient } from '@supabase/postgrest-js';
import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import { POSTGREST_WRITER_JWT } from '../shared/postgrest-jwt.js';
import featureFlagsTests from '../shared/tests/feature-flags.js';

const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;

function getPostgrestClient() {
  return new PostgrestClient(POSTGREST_URL, {
    schema: 'public',
    headers: {
      apikey: POSTGREST_WRITER_JWT,
      Authorization: `Bearer ${POSTGREST_WRITER_JWT}`,
    },
  });
}

featureFlagsTests(
  () => ctx.httpClient,
  resetPostgres,
  getPostgrestClient,
  () => ({ baseUrl: ctx.baseUrl, adminToken: ctx.tokens.admin }),
);
