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

/* eslint-disable no-await-in-loop */
import { execSync } from 'child_process';

import { POSTGREST_WRITER_JWT } from '../shared/postgrest-jwt.js';
import { organizations } from './seed-data/organizations.js';
import { facsAccessMappingAuditEvents } from './seed-data/facs-access-mapping-audit-events.js';
import { facsAccessMappings } from './seed-data/facs-access-mappings.js';
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
import { siteImsOrgAccesses } from './seed-data/site-ims-org-accesses.js';
import { brands } from './seed-data/brands.js';
import { brandSites } from './seed-data/brand-sites.js';
import { projectionAudits } from './seed-data/projection-audits.js';
import { featureFlags } from './seed-data/feature-flags.js';
import { prompts } from './seed-data/prompts.js';
import { brandPresenceExecutions } from './seed-data/brand-presence-executions.js';
import { taskManagementConnections } from './seed-data/task-management-connections.js';
import { tickets } from './seed-data/tickets.js';
import { ticketSuggestions } from './seed-data/ticket-suggestions.js';

const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;
const POSTGRES_CONTAINER = 'spacecat-it-db';
const POSTGRES_DB = 'mysticat';

/**
 * Inserts rows into a PostgREST table one at a time.
 * (Bulk inserts require uniform keys across all objects - PGRST102 - and seed
 * data has optional fields, so we insert individually but parallelize across tables.)
 */
async function insertRows(table, rows, { asWriter = false } = {}) {
  // Most tables grant INSERT to postgrest_anon (default), so the unauthenticated
  // seed works. Append-only audit tables revoke anon INSERT (writer-only), so
  // pass { asWriter: true } to seed them with the postgrest_writer JWT.
  const headers = {
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
  if (asWriter) {
    headers.Authorization = `Bearer ${POSTGREST_WRITER_JWT}`;
  }
  for (const row of rows) {
    const res = await fetch(`${POSTGREST_URL}/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to seed ${table}: ${res.status} ${text}`);
    }
  }
}

/**
 * Clears all test data via targeted DELETEs instead of TRUNCATE.
 * TRUNCATE acquires ACCESS EXCLUSIVE locks on every table even when empty (~1.4s).
 * DELETE from root tables with ON DELETE CASCADE is <1ms.
 *
 * Strategy (from mysticat-data-service#176):
 * 1. Delete blocker tables (ON DELETE RESTRICT/SET NULL or standalone)
 * 2. Delete root table (organizations) - CASCADE handles all children
 *
 * site_ims_org_accesses.organization_id and target_organization_id reference
 * organizations with ON DELETE RESTRICT, so grants must be cleared before
 * deleting organizations. access_grant_logs and facs_access_mappings use TEXT
 * columns (no FK to organizations) but are cleared for test isolation.
 */
function clearData() {
  execSync(
    `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d ${POSTGRES_DB} -c "`
    + 'DELETE FROM access_grant_logs;'
    + 'DELETE FROM facs_access_mappings;'
    + 'DELETE FROM facs_access_mapping_audit_events;'
    + 'DELETE FROM site_ims_org_accesses;'
    + 'DELETE FROM plg_onboardings;'
    + 'DELETE FROM consumers;'
    + 'DELETE FROM async_jobs;'
    + 'DELETE FROM projection_audit;'
    + 'DELETE FROM organizations;'
    + '"',
    { stdio: 'pipe', timeout: 10_000 },
  );
}

const REFERRAL_SOURCE_TABLES = {
  optel: 'referral_traffic_optel',
  cdn: 'referral_traffic_cdn',
  adobe_analytics: 'referral_traffic_adobe_analytics',
  ga4: 'referral_traffic_ga4',
  cja: 'referral_traffic_cja',
};

/**
 * Seeds referral-traffic source *presence* for the has-data IT.
 *
 * Clears all five `referral_traffic_*` tables, then inserts one minimal row per
 * requested source so `GET /sites/:siteId/referral-traffic/has-data` reports
 * exactly those sources (in the backend's resolution-priority order).
 *
 * Rows go into an on-demand far-future (2099) partition: the has-data existence
 * check is date-agnostic (`WHERE site_id = ? LIMIT 1`), and a 2099 range can't
 * collide with the image's real monthly partitions. Runs as the `postgres`
 * superuser via psql to bypass PostgREST role grants + partition routing.
 *
 * @param {string} siteId  Site the rows belong to (a canonical seed UUID).
 * @param {Array<'optel'|'cdn'|'adobe_analytics'|'ga4'|'cja'>} sources Sources to
 *   mark present; pass [] to clear all five (test cleanup).
 */
export function seedReferralPresence(siteId, sources = []) {
  const statements = [
    ...Object.values(REFERRAL_SOURCE_TABLES).map((t) => `DELETE FROM ${t};`),
    ...sources.flatMap((source) => {
      const table = REFERRAL_SOURCE_TABLES[source];
      return [
        `CREATE TABLE IF NOT EXISTS ${table}_itseed PARTITION OF ${table} FOR VALUES FROM ('2099-01-01') TO ('2099-02-01');`,
        `INSERT INTO ${table} (site_id, traffic_date, url_path, pageviews) VALUES ('${siteId}', '2099-01-15', '/it-seed', 1);`,
      ];
    }),
  ];
  execSync(
    `docker exec ${POSTGRES_CONTAINER} psql -U postgres -d ${POSTGRES_DB} -v ON_ERROR_STOP=1 -c "${statements.join(' ')}"`,
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
    insertRows('async_jobs', asyncJobs),
    insertRows('consumers', consumers),
    insertRows('projection_audit', projectionAudits),
    insertRows('facs_access_mapping_audit_events', facsAccessMappingAuditEvents, { asWriter: true }),
    insertRows('facs_access_mappings', facsAccessMappings),
  ]);

  // Level 1a: depend on organizations
  await Promise.all([
    insertRows('projects', projects),
    insertRows('entitlements', entitlements),
    insertRows('trial_users', trialUsers),
    // feature_flags grants INSERT to postgrest_writer only (SELECT to anon), so
    // seed it with the writer JWT — same as the append-only audit tables.
    insertRows('feature_flags', featureFlags, { asWriter: true }),
    insertRows('task_management_connections', taskManagementConnections),
  ]);

  // Level 1b: depend on projects
  await insertRows('sites', sites);

  // Level 2: depend on sites
  // brands.site_id → sites.id, and chk_active_brand_has_site_id requires an
  // active brand to carry a site_id, so brands must seed after sites.
  await Promise.all([
    insertRows('brands', brands),
    insertRows('audits', audits),
    insertRows('opportunities', opportunities),
    insertRows('site_enrollments', siteEnrollments),
    insertRows('site_ims_org_accesses', siteImsOrgAccesses),
    insertRows('experiments', experiments),
    insertRows('site_top_pages', siteTopPages),
    insertRows('plg_onboardings', plgOnboardings),
    insertRows('trial_user_activities', trialUserActivities),
    insertRows('sentiment_topics', sentimentTopics),
  ]);

  // Level 3: depend on opportunities, audits, topics, brands + sites
  await Promise.all([
    insertRows('suggestions', suggestions),
    insertRows('fix_entities', fixes),
    insertRows('audit_urls', auditUrls),
    insertRows('sentiment_guidelines', sentimentGuidelines),
    insertRows('brand_sites', brandSites),
    insertRows('tickets', tickets),
  ]);

  // Level 4: depend on fix_entities + suggestions + tickets
  await Promise.all([
    insertRows('fix_entity_suggestions', fixEntitySuggestions),
    insertRows('ticket_suggestions', ticketSuggestions),
  ]);
}

/**
 * Optional per-test fixture: a prompt carrying an `intent` plus a
 * brand_presence_executions row referencing it. NOT part of the baseline seed —
 * other suites (e.g. categories-prompts) count prompts under ORG_1/BRAND_1 and
 * assume an empty baseline, so this is seeded only by the topic-prompts IT after
 * resetPostgres(). Cleared by the next suite's clearData (organizations CASCADE).
 */
export async function seedBrandPresenceIntentFixture() {
  await insertRows('prompts', prompts); // FK: BPE.prompt_id → prompts.id
  await insertRows('brand_presence_executions', brandPresenceExecutions);
}

/**
 * Resets the PostgreSQL database: truncates all tables, then re-seeds baseline.
 * Called by each test suite in before() for full isolation.
 */
export async function resetPostgres() {
  clearData();
  await seed();
}
