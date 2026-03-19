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

import { execSync } from 'child_process';

import { organizations } from './seed-data/organizations.js';
import { sites } from './seed-data/sites.js';
import { audits } from './seed-data/audits.js';
import { opportunities } from './seed-data/opportunities.js';
import { suggestions } from './seed-data/suggestions.js';
import { fixes, fixEntitySuggestions } from './seed-data/fixes.js';
import { experiments } from './seed-data/experiments.js';
import { siteTopPages } from './seed-data/site-top-pages.js';
import { entitlements } from './seed-data/entitlements.js';
import { siteEnrollments } from './seed-data/site-enrollments.js';
import { projects } from './seed-data/projects.js';
import { sentimentTopics } from './seed-data/sentiment-topics.js';
import { sentimentGuidelines } from './seed-data/sentiment-guidelines.js';
import { auditUrls } from './seed-data/audit-urls.js';
import { trialUsers } from './seed-data/trial-users.js';
import { trialUserActivities } from './seed-data/trial-user-activities.js';
import { asyncJobs } from './seed-data/async-jobs.js';
import { consumers } from './seed-data/consumers.js';
import { plgOnboardings } from './seed-data/plg-onboardings.js';

const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;

/**
 * Bulk-inserts rows into a PostgREST table (single HTTP request per table).
 */
async function insertRows(table, rows) {
  if (rows.length === 0) return;

  const res = await fetch(`${POSTGREST_URL}/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to seed ${table}: ${res.status} ${text}`);
  }
}

/**
 * Truncates all data tables in the public schema via psql.
 * Uses CASCADE to handle foreign key dependencies.
 * Skips schema_migrations (used by dbmate).
 */
function truncate() {
  execSync(
    'docker exec spacecat-it-db psql -U postgres -d mysticat -c '
    + '"DO \\$\\$ DECLARE r RECORD; BEGIN '
    + "FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'schema_migrations') LOOP "
    + "EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE'; "
    + 'END LOOP; END \\$\\$;"',
    { stdio: 'pipe', timeout: 10_000 },
  );
}

/**
 * Seeds all tables, parallelizing inserts within each FK dependency level.
 *
 * Level 0: no FK deps
 * Level 1: depend on organizations
 * Level 2: depend on sites
 * Level 3: depend on opportunities, audits, topics, trial_users
 * Level 4: depend on fix_entities + suggestions
 */
async function seed() {
  // Level 0: no dependencies
  await Promise.all([
    insertRows('organizations', organizations),
    insertRows('trial_users', trialUsers),
    insertRows('async_jobs', asyncJobs),
    insertRows('consumers', consumers),
    insertRows('sentiment_topics', sentimentTopics),
  ]);

  // Level 1: depend on organizations
  await Promise.all([
    insertRows('projects', projects),
    insertRows('sites', sites),
    insertRows('entitlements', entitlements),
  ]);

  // Level 2: depend on sites
  await Promise.all([
    insertRows('audits', audits),
    insertRows('opportunities', opportunities),
    insertRows('site_enrollments', siteEnrollments),
    insertRows('experiments', experiments),
    insertRows('site_top_pages', siteTopPages),
    insertRows('plg_onboardings', plgOnboardings),
    insertRows('trial_user_activities', trialUserActivities),
  ]);

  // Level 3: depend on opportunities, audits, topics
  await Promise.all([
    insertRows('suggestions', suggestions),
    insertRows('fix_entities', fixes),
    insertRows('audit_urls', auditUrls),
    insertRows('sentiment_guidelines', sentimentGuidelines),
  ]);

  // Level 4: depend on fix_entities + suggestions
  await insertRows('fix_entity_suggestions', fixEntitySuggestions);
}

/**
 * Resets the PostgreSQL database: truncates all tables, then re-seeds baseline.
 * Called by each test suite in before() for full isolation.
 */
export async function resetPostgres() {
  truncate();
  await seed();
}
