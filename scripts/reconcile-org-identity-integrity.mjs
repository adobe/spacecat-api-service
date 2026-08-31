#!/usr/bin/env node
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

/* eslint-disable no-console */

/**
 * LLMO-7218 (AC8, AC9, AC12 + the "Monitoring" scope's foreign-enrollment / duplicate-brand
 * items): a read-only, always-dry-run reconciliation report over three org/identity integrity
 * signals. This script NEVER writes anything — per AC12 ("a production-safe dry-run command or
 * report identifies existing records requiring remediation without mutating them") and because
 * no code path anywhere in this codebase reassigns a site's organization today (confirmed by
 * repo-wide search), so there is nothing safe to auto-fix yet; a fix requires a human decision
 * about which side (the enrollment, the brand, or the site) is actually wrong for a given row.
 *
 * Three checks, run independently and reported separately:
 *
 * 1. Foreign LLMO enrollments (AC8's detection half): a `site_enrollments` row whose
 *    entitlement's `organization_id` differs from the site's CURRENT `organization_id`. This is
 *    the exact drift the ticket describes — "LLMO enrollments tied to an entitlement from
 *    another organization" — and confirmed structurally possible because `site_enrollments` has
 *    no `organization_id` column of its own; it only reaches an org indirectly via
 *    `entitlement_id`, so nothing re-links it when a site's own `organization_id` changes.
 * 2. Duplicate active normalized brand identities (AC9's detection half, the part NOT already
 *    covered by the DB): `brands` already has an exact-match unique constraint
 *    (`uq_brand_name_per_org`, `UNIQUE (organization_id, name)`), so this only surfaces
 *    *normalized* variants that constraint can't catch — different whitespace or casing within
 *    the same organization (e.g. "Acme Inc" vs "acme  inc"). Normalization here is
 *    whitespace-collapse + case-fold, the same shape as the established
 *    `transformer.py::_normalize_org_name()` / `book.py::_inline()` pattern from LLMO-7117,
 *    reimplemented in JS since there's no shared cross-language normalization helper.
 * 3. Brand/site organization mismatch: an active brand's own `organization_id` differs from its
 *    anchor site's CURRENT `organization_id` (via `brands.site_id`). Every active brand has a
 *    non-null `site_id` (enforced by `chk_active_brand_has_site_id`), so this join is always
 *    resolvable for the rows this check considers.
 *
 * None of these three needs a database migration, RPC function, or raw SQL: PostgREST can't
 * compare two columns to each other directly in a filter, so all three fetch the relevant rows
 * (paginated, via the standard REST embed pattern already used elsewhere in this codebase) and
 * do the cross-referencing in JS.
 *
 * Usage:
 *   POSTGREST_URL=<url> node scripts/reconcile-org-identity-integrity.mjs [--page-size N]
 *
 * Exit status:
 *   0  Report completed (regardless of whether any drift was found — finding drift is the
 *      expected, useful outcome of a report, not a failure).
 *   1  The report itself could not complete (a page fetch failed).
 *
 * Get POSTGREST_URL from the target env's Lambda configuration, same as the other scripts in
 * this directory:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.POSTGREST_URL'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';

const DEFAULT_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'page-size': { type: 'string' },
  },
});

// Upper bound on --page-size: PostgREST's own db-max-rows config is a server-side backstop,
// but a large operator-supplied value still asks for a single huge range unnecessarily -
// capping here gives a clear error instead of relying on that backstop.
const MAX_PAGE_SIZE = 10_000;

function parsePageSize(raw) {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    console.error(`ERROR: --page-size must be a positive integer no greater than ${MAX_PAGE_SIZE}, got "${raw}"`);
    exit(1);
  }
  return n;
}

const pageSize = parsePageSize(values['page-size']);

if (!env.POSTGREST_URL) {
  console.error('ERROR: POSTGREST_URL is required');
  exit(1);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const log = console;
// POSTGREST_API_KEY is deliberately NOT required: this script only ever reads (entitlements,
// site_enrollments, brands are all `GRANT SELECT ... TO postgrest_anon` with no RLS policy in
// mysticat-data-service), and createDataAccess simply omits the apikey/Authorization headers
// when it's absent, falling back to the unauthenticated postgrest_anon role — the same pattern
// scripts/reconcile-prompt-suggestion-schedules.mjs already documents for its own PostgREST reads.
const dataAccess = createDataAccess({
  postgrestUrl: env.POSTGREST_URL,
  postgrestSchema: env.POSTGREST_SCHEMA,
  postgrestApiKey: env.POSTGREST_API_KEY,
}, log);
const { postgrestClient } = dataAccess.services;

// Hard ceiling on rows accumulated by a single fetchAllRows() call — not a realistic size for
// any of this script's three tables today, but a safety valve against unbounded memory growth
// if a filter regresses to matching far more rows than expected, or a pagination bug loops.
const MAX_ROWS_PER_FETCH = 200_000;

/**
 * Fetches every row of a PostgREST table/select via keyset pagination on the immutable primary
 * key `id` (not a mutable timestamp, and not offset pagination — see below). Termination is
 * driven by an exact server-side row count (`{ count: 'exact' }`), not by "this page came back
 * short": PostgREST's own `db-max-rows` config can silently cap the rows a single page returns
 * below the requested limit, so a short page does NOT reliably mean "no more data" — relying on
 * it would let a `db-max-rows` cap at or below `pageSize` silently truncate the sweep into a
 * clean-looking but wrong "0 drift" report. `count: 'exact'` is unaffected by that per-page cap
 * (PostgREST computes it against the full filtered result set), so `rows.length >= totalCount`
 * is the only safe stop condition.
 *
 * Keyset (`.gt('id', lastId)`) rather than offset (`.range(from, to)`) for the cursor itself: an
 * offset cursor advances by a fixed amount per page, so if a page were ever short for any reason
 * (including the `db-max-rows` cap above), advancing by the full `pageSize` would skip the rows
 * that page never returned. A keyset cursor always resumes exactly after the last row actually
 * seen, so nothing is skippable regardless of how many rows any single page returns. It also
 * incidentally closes the gap the offset approach had with concurrent deletes (a deleted
 * earlier-sorting row can no longer shift a later page's boundary).
 * @param {string} table
 * @param {string} select
 * @param {(query: object) => object} [applyFilter] - optional filter chain applied to the query.
 * @returns {Promise<object[]>}
 */
async function fetchAllRows(table, select, applyFilter = (q) => q) {
  const rows = [];
  let lastId = null;
  let totalCount = null;
  for (;;) {
    let query = applyFilter(
      postgrestClient.from(table).select(select, { count: 'exact' }).order('id', { ascending: true }),
    );
    if (lastId !== null) {
      query = query.gt('id', lastId);
    }
    // eslint-disable-next-line no-await-in-loop
    const { data, error, count } = await query.limit(pageSize);
    if (error) {
      throw new Error(`Failed to fetch ${table} rows after id=${lastId ?? '(start)'}: ${error.message}`);
    }
    if (totalCount === null) {
      totalCount = count;
    }
    if (rows.length + (data?.length ?? 0) > MAX_ROWS_PER_FETCH) {
      throw new Error(
        `Aborting fetch of ${table}: would exceed ${MAX_ROWS_PER_FETCH} rows, which is far beyond `
        + 'this table\'s expected size and likely indicates a filter or pagination bug.',
      );
    }
    rows.push(...(data ?? []));
    if (!data || data.length === 0 || rows.length >= totalCount) {
      log.info(`Fetched ${rows.length}/${totalCount ?? '?'} rows from ${table}`);
      return rows;
    }
    lastId = data[data.length - 1].id;
  }
}

/** Whitespace-collapse + case-fold, matching the established LLMO-7117 normalization shape. */
function normalizeBrandName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Check 1: foreign LLMO enrollments
// ---------------------------------------------------------------------------
async function findForeignLlmoEnrollments() {
  // `entitlements!inner`/`sites!inner` (here and in findActiveBrandIntegrityIssues below) make
  // the nested-field access below null-safe, but as a side effect they silently drop any row
  // with a dangling reference (a site_enrollment pointing at a deleted entitlement, an active
  // brand whose site_id doesn't resolve) rather than surfacing it. Assumed prevented by FK
  // constraints today; not verified by this script.
  const rows = await fetchAllRows(
    'site_enrollments',
    'id,site_id,entitlement_id,entitlements!inner(organization_id,product_code),sites!inner(organization_id,base_url)',
    (q) => q.eq('entitlements.product_code', 'LLMO'),
  );
  return rows
    .filter((row) => row.entitlements.organization_id !== row.sites.organization_id)
    .map((row) => ({
      enrollmentId: row.id,
      siteId: row.site_id,
      siteBaseUrl: row.sites.base_url,
      siteOrganizationId: row.sites.organization_id,
      entitlementId: row.entitlement_id,
      entitlementOrganizationId: row.entitlements.organization_id,
    }));
}

// ---------------------------------------------------------------------------
// Checks 2 and 3: duplicate normalized active brands, and brand/site org mismatch
// (share one fetch — both only ever consider active brands)
// ---------------------------------------------------------------------------
async function findActiveBrandIntegrityIssues() {
  const brands = await fetchAllRows(
    'brands',
    'id,name,organization_id,site_id,sites!inner(organization_id,base_url)',
    (q) => q.eq('status', 'active'),
  );

  const byOrgAndNormalizedName = new Map();
  const orgMismatches = [];
  for (const brand of brands) {
    const key = `${brand.organization_id}::${normalizeBrandName(brand.name)}`;
    const group = byOrgAndNormalizedName.get(key) ?? [];
    group.push(brand);
    byOrgAndNormalizedName.set(key, group);

    if (brand.organization_id !== brand.sites.organization_id) {
      orgMismatches.push({
        brandId: brand.id,
        brandName: brand.name,
        brandOrganizationId: brand.organization_id,
        siteId: brand.site_id,
        siteBaseUrl: brand.sites.base_url,
        siteOrganizationId: brand.sites.organization_id,
      });
    }
  }

  const duplicateNormalizedNames = [...byOrgAndNormalizedName.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      organizationId: group[0].organization_id,
      normalizedName: normalizeBrandName(group[0].name),
      brands: group.map((b) => ({ id: b.id, name: b.name })),
    }));

  return { duplicateNormalizedNames, orgMismatches };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
log.info('Reconciliation report: org/identity integrity (read-only, no writes)');

let failed = false;

try {
  const foreignEnrollments = await findForeignLlmoEnrollments();
  log.info('---');
  log.info(`Foreign LLMO enrollments: ${foreignEnrollments.length}`);
  for (const row of foreignEnrollments) {
    log.warn(`  enrollment=${row.enrollmentId} site=${row.siteId} (${JSON.stringify(row.siteBaseUrl)}, org=${row.siteOrganizationId}) entitlement=${row.entitlementId} (org=${row.entitlementOrganizationId})`);
  }
} catch (error) {
  failed = true;
  log.error(`FAILED to check foreign LLMO enrollments: ${error.message}`);
}

try {
  const { duplicateNormalizedNames, orgMismatches } = await findActiveBrandIntegrityIssues();

  log.info('---');
  log.info(`Duplicate active normalized brand identities: ${duplicateNormalizedNames.length}`);
  for (const group of duplicateNormalizedNames) {
    log.warn(`  org=${group.organizationId} normalized=${JSON.stringify(group.normalizedName)} brands=[${group.brands.map((b) => `${b.id} (${JSON.stringify(b.name)})`).join(', ')}]`);
  }

  log.info('---');
  log.info(`Active brand / site organization mismatches: ${orgMismatches.length}`);
  for (const row of orgMismatches) {
    log.warn(`  brand=${row.brandId} (${JSON.stringify(row.brandName)}, org=${row.brandOrganizationId}) site=${row.siteId} (${JSON.stringify(row.siteBaseUrl)}, org=${row.siteOrganizationId})`);
  }
} catch (error) {
  failed = true;
  log.error(`FAILED to check active brand integrity: ${error.message}`);
}

exit(failed ? 1 : 0);
