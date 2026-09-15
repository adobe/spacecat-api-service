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
import { POSTGREST_WRITER_JWT } from '../shared/postgrest-jwt.js';
import { resetPostgres } from './seed.js';
import leaseCasTests from '../shared/tests/lease-cas.js';

// Same PostgREST endpoint the harness seeds against; the writer JWT matches the
// app's own POSTGREST_API_KEY so UPDATE/SELECT grants mirror production.
const POSTGREST_URL = `http://localhost:${process.env.IT_POSTGREST_PORT || '3300'}`;
const headers = {
  apikey: POSTGREST_WRITER_JWT,
  Authorization: `Bearer ${POSTGREST_WRITER_JWT}`,
};

// The lease functions inject `context.dataAccess.services.postgrestClient`, which
// is a `@supabase/postgrest-js` client (service/index.js `createPostgrestService`).
// Build the same client shape here so the CAS runs through the real query builder.
const makeClient = (schema) => new PostgrestClient(POSTGREST_URL, { schema, headers });

leaseCasTests(
  () => makeClient('public'),
  // PGRST_DB_SCHEMAS exposes `public` only, so a claim against any other schema
  // returns a real PostgREST error — the fail-closed trigger.
  () => makeClient('nonexistent_schema'),
  resetPostgres,
);
