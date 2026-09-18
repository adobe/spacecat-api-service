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
 * Pre-deploy enrollment migration for the merged multi-dimension custom-tag flag.
 *
 * `LLMO/serenity_unbounded_tag_authoring` (deep `tag` authoring) and
 * `LLMO/serenity_tag_search` (`GET /serenity/tags/search`) were merged into ONE brand-level
 * flag, `LLMO/serenity_tag_multi_dimension`. The merged code reads that name and NOTHING else --
 * no alias fallback -- so on the deploy that ships it every existing enrollment row carrying an
 * old name becomes inert, and every org/brand already enrolled silently loses the capability.
 * This script carries those enrollments forward BEFORE that deploy.
 *
 * MAPPING -- OR over the RESOLVED (not the raw) value of each old flag, per scope:
 *
 *   serenity_tag_multi_dimension(scope) := resolve(unbounded_tag_authoring, scope)
 *                                       OR resolve(tag_search, scope)
 *
 * where `resolve(flag, scope)` is the same brand-override-first rule the API itself uses
 * (`resolveFlagRowForBrand` in src/support/feature-flags-storage.js):
 *
 *   resolve(flag, org)          := the org row (brand_id IS NULL), else OFF
 *   resolve(flag, org + brand)  := the brand's own row, else the org row, else OFF
 *
 * Resolving before OR-ing is the whole correctness argument, and a raw row-by-row OR gets it
 * WRONG. Take an org row `unbounded_tag_authoring=true` and a brand row `tag_search=false` for
 * brand X (no brand row for authoring). Brand X resolves authoring=true today. A row-wise OR
 * would write brand X a merged override of `false` -- an override beats the org row -- and
 * REVOKE deep authoring from a brand that has it. Inheriting the missing half from the org row
 * first, as below, keeps X at `true`. Every such inherited half is reported per scope
 * (`(org)` vs `(brand)` in the plan output) so the operator can audit the derivation.
 *
 * A scope whose two old flags both resolve `false` is still written as an explicit `false`. For
 * a brand that is deliberately held back under an enabled org row, dropping the row would let it
 * inherit the org's `true` and switch the brand ON -- the exact opposite of what it says today.
 *
 * SAFE ORDERING (why this is a pre-deploy step and deletion is a post-deploy one):
 *   1. `--apply` writes + VERIFIES the new rows and keeps the old ones. Harmless before the
 *      deploy: the currently-deployed code does not read the new name, so nothing changes for
 *      anyone, and a rollback of the deploy still finds the old rows intact.
 *   2. deploy the merged-flag code.
 *   3. `--apply --delete-stale` removes the old rows, which are inert by then. Running step 3
 *      BEFORE the deploy would disable the capability for every enrolled customer until the
 *      deploy lands, which is why deletion is a separate, explicit opt-in.
 *
 * TRANSACTIONS: PostgREST runs each HTTP request in its own transaction and exposes no
 * multi-statement one, so "write the new rows and delete the old ones" cannot be a single atomic
 * unit from here (the only transactional seam in this codebase is a `wrpc_*` function in
 * mysticat-data-service -- see src/support/slack/llmo-org-move.js -- and adding one for a
 * one-time flag rename is not worth a schema migration). The script is therefore ordered to fail
 * SAFE instead: every new row is re-read and value-checked before ANY old row is deleted, and a
 * scope whose verification fails aborts the run with its old rows untouched. Both halves are
 * idempotent -- an already-migrated scope is reported as `already-migrated` and never
 * rewritten -- so RECOVERY FROM ANY INTERRUPTION IS SIMPLY RE-RUNNING THE SAME COMMAND. The
 * worst interruption leaves new rows written and old rows still present, which is exactly the
 * state step 1 is supposed to produce.
 *
 * CONFLICTS ARE FATAL TO EVERY WRITE MODE: a scope that already carries a
 * `serenity_tag_multi_dimension` row with a DIFFERENT value than the mapping derives is never
 * overwritten, and its presence stops the WHOLE run. `--apply` (with or without
 * `--delete-stale`) reports every conflict, writes nothing, deletes nothing, and exits 1. There
 * is deliberately no "skip the conflicting scope and migrate the rest" option: the scopes are not
 * independent. A brand's derived value can be inherited from its organization's old rows, so
 * migrating and then DELETING an organization's old rows changes what a still-unresolved brand
 * scope derives on the next run -- the conflict would silently resolve itself against a value
 * nobody reviewed. An operator resolves conflicts by hand (delete or correct the offending
 * `serenity_tag_multi_dimension` row) and re-runs; `--org-id` narrows a rehearsal to one
 * organization without ever partially migrating one.
 *
 * SCOPES EVALUATED: every scope carrying an old-flag row, PLUS every brand that carries only a
 * pre-existing `serenity_tag_multi_dimension` override while its organization still has old
 * rows -- that brand inherits the organization's old state, so its merged value has to be
 * checked even though it has no old row of its own (it is reported `already-migrated` or
 * `CONFLICT`, never `insert`). A scope with no old state anywhere -- neither its own rows nor an
 * organization row to inherit -- needs no migration and is not planned.
 *
 * SCHEMA (mysticat-data-service `feature_flags`):
 *   UNIQUE NULLS NOT DISTINCT (organization_id, product, flag_name, brand_id)
 *     -- `feature_flags_org_product_flag_name_brand_key`
 *   FOREIGN KEY (organization_id, brand_id) REFERENCES brands (organization_id, id)
 *   GRANT SELECT TO postgrest_anon; GRANT INSERT, UPDATE, DELETE TO postgrest_writer
 * Reads therefore work unauthenticated; writes need the writer key. Like `upsertFeatureFlag`,
 * this script never names that unique constraint as an `on_conflict` target -- it reads first
 * and inserts what is missing -- so it does not depend on the shape of the key, and it selects
 * `*` (never a `brand_id` projection) for the reason documented on `isOrgRow`.
 *
 * The admin endpoint is NOT a substitute for this script: `DELETE
 * /organizations/:id/feature-flags/:product/:flagName` sets the org row to `false` rather than
 * removing it, and neither PUT nor DELETE can address a brand-scoped override at all.
 *
 * Usage (preview is the default -- it writes NOTHING):
 *   POSTGREST_URL=<url> node scripts/serenity-tag-flag-migration.mjs
 *   POSTGREST_URL=<url> POSTGREST_API_KEY=<writer-key> \
 *     node scripts/serenity-tag-flag-migration.mjs --apply
 *   POSTGREST_URL=<url> POSTGREST_API_KEY=<writer-key> \
 *     node scripts/serenity-tag-flag-migration.mjs --apply --delete-stale
 *
 * Options:
 *   --apply             Write (and verify) the derived `serenity_tag_multi_dimension` rows.
 *                       Without it the script only reports what it WOULD do.
 *   --delete-stale      Additionally delete the old-flag rows of every VERIFIED scope. Requires
 *                       --apply. Run only AFTER the merged-flag code is deployed.
 *   --org-id UUID       Restrict every phase to one organization (a rehearsal on a single org,
 *                       or a follow-up for one that was skipped).
 *   --updated-by TEXT   Value written to `feature_flags.updated_by` (default
 *                       `serenity-tag-flag-migration`).
 *   --page-size N       Read page size (default 500).
 *
 * Exit status:
 *   0  Completed with no conflicts.
 *   1  At least one conflicting scope, a failed verification, a bad invocation, or a read/write
 *      error. A conflict means NOTHING was written or deleted anywhere; a failed verification
 *      means nothing was deleted on any scope that did not verify.
 *
 * Evidence to keep before deploying: the plan report's counts block plus the per-scope lines
 * (they spell out `old_flag=value(source) OR old_flag=value(source) => merged=value` for every
 * scope), and the independent `curl` verification in docs/serenity.md. Production example only,
 * NOT special-cased anywhere in this script: org `a6286f15-86c3-4f18-b4ee-f5f37c894248` (PAT03)
 * currently carries both old flags `true` at org scope and must come out of the migration with a
 * single `serenity_tag_multi_dimension=true` org row.
 *
 * Get POSTGREST_URL / POSTGREST_API_KEY from the target env's Lambda configuration, same as the
 * other scripts in this directory -- never hard-code or commit them:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.POSTGREST_URL' --output text
 * and the same call with --query 'Environment.Variables.POSTGREST_API_KEY' for the writer key.
 * docs/serenity.md ("Pre-deploy migration off the two retired flags") has the copy-pasteable
 * sequence, including the independent curl verification to run before and after the deploy.
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { argv, env, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

export const FEATURE_FLAG_PRODUCT = 'LLMO';
export const OLD_AUTHORING_FLAG_NAME = 'serenity_unbounded_tag_authoring';
export const OLD_SEARCH_FLAG_NAME = 'serenity_tag_search';
export const OLD_FLAG_NAMES = Object.freeze([OLD_AUTHORING_FLAG_NAME, OLD_SEARCH_FLAG_NAME]);
export const NEW_FLAG_NAME = 'serenity_tag_multi_dimension';
export const ALL_FLAG_NAMES = Object.freeze([...OLD_FLAG_NAMES, NEW_FLAG_NAME]);

export const DEFAULT_UPDATED_BY = 'serenity-tag-flag-migration';
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 10_000;
/** Safety valve against a pagination bug or a filter regression, not a realistic table size. */
export const MAX_ROWS_PER_FETCH = 200_000;
/** Ids per delete request: PostgREST puts the whole `in` list in the URL. */
export const DELETE_BATCH_SIZE = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable key for one flag scope: an organization's own row, or one brand's override of it.
 *
 * @param {string} organizationId - SpaceCat organization UUID.
 * @param {string|null} brandId - Brand UUID, or null for the organization's own row.
 * @returns {string} Scope key.
 */
export function scopeKey(organizationId, brandId) {
  return `${organizationId}::${brandId ?? 'ORG'}`;
}

/**
 * `brand_id` is absent from every row before the brand-scope migration and NULL on an
 * organization's row after it, so this normalizes both schemas to the same `null`.
 *
 * @param {object} row - Raw PostgREST `feature_flags` row.
 * @returns {string|null} The brand this row overrides, or null for the org's own row.
 */
const rowBrandId = (row) => row.brand_id ?? null;

/**
 * @param {object|null} brandRow - The brand's own row for one old flag, if any.
 * @param {object|null} orgRow - The organization's row for that flag, if any.
 * @returns {string} `brand`, `org`, or `absent` -- which scope supplied the resolved value.
 */
function derivationSource(brandRow, orgRow) {
  if (brandRow) {
    return 'brand';
  }
  if (orgRow) {
    return 'org';
  }
  return 'absent';
}

// ---------------------------------------------------------------------------
// Planning (pure -- no I/O, unit tested in test/scripts/)
// ---------------------------------------------------------------------------

/**
 * Groups raw `feature_flags` rows by organization, splitting them into the organization's own
 * old-flag rows, each brand's old-flag overrides, and whatever `serenity_tag_multi_dimension`
 * rows already exist. Rows of another product or another flag name are ignored.
 *
 * @param {object[]} rows - Raw PostgREST rows (wildcard projection).
 * @returns {Map<string, {organizationId: string, orgOld: Map<string, object>,
 *   brandOld: Map<string, Map<string, object>>, existingNew: Map<string|null, object>}>}
 */
function groupRowsByOrganization(rows) {
  const organizations = new Map();
  const ensure = (organizationId) => {
    let entry = organizations.get(organizationId);
    if (!entry) {
      entry = {
        organizationId,
        orgOld: new Map(),
        brandOld: new Map(),
        existingNew: new Map(),
      };
      organizations.set(organizationId, entry);
    }
    return entry;
  };

  const relevant = (rows ?? []).filter((row) => row?.product === FEATURE_FLAG_PRODUCT
    && ALL_FLAG_NAMES.includes(row?.flag_name));

  for (const row of relevant) {
    const entry = ensure(row.organization_id);
    const brandId = rowBrandId(row);
    if (row.flag_name === NEW_FLAG_NAME) {
      entry.existingNew.set(brandId, row);
    } else if (brandId === null) {
      entry.orgOld.set(row.flag_name, row);
    } else {
      const perBrand = entry.brandOld.get(brandId) ?? new Map();
      perBrand.set(row.flag_name, row);
      entry.brandOld.set(brandId, perBrand);
    }
  }

  return organizations;
}

/**
 * Derives one scope's merged value, its audit trail, the action to take, and the old rows that
 * become stale once it is migrated.
 *
 * @param {object} org - One entry of {@link groupRowsByOrganization}.
 * @param {string|null} brandId - Brand UUID, or null for the organization's own scope.
 * @returns {object} Plan entry.
 */
function buildScopeEntry(org, brandId) {
  const derivation = {};
  const staleRows = [];

  for (const flagName of OLD_FLAG_NAMES) {
    const orgRow = org.orgOld.get(flagName) ?? null;
    const brandRow = brandId === null
      ? null
      : (org.brandOld.get(brandId)?.get(flagName) ?? null);
    // Brand override first, then the organization's row -- the API's own resolution rule. A
    // brand that overrides only ONE of the two old flags INHERITS the other from its org, so
    // the OR below is over resolved values and never revokes an inherited capability.
    const resolvedRow = brandRow ?? orgRow;
    derivation[flagName] = {
      value: resolvedRow?.flag_value === true,
      source: derivationSource(brandRow, orgRow),
    };
    // Only rows of THIS scope are this scope's to delete: an inherited org row stays until the
    // org scope itself is migrated and verified.
    const ownRow = brandId === null ? orgRow : brandRow;
    if (ownRow) {
      staleRows.push({ id: ownRow.id, flagName, value: ownRow.flag_value === true });
    }
  }

  const value = OLD_FLAG_NAMES.some((flagName) => derivation[flagName].value);
  const existingRow = org.existingNew.get(brandId) ?? null;
  let action = 'insert';
  if (existingRow) {
    action = existingRow.flag_value === value ? 'already-migrated' : 'conflict';
  }

  return {
    key: scopeKey(org.organizationId, brandId),
    organizationId: org.organizationId,
    brandId,
    scope: brandId === null ? 'org' : 'brand',
    value,
    derivation,
    action,
    existingRowId: existingRow?.id ?? null,
    existingValue: existingRow ? existingRow.flag_value === true : null,
    inheritsFromOrg: OLD_FLAG_NAMES.some((flagName) => derivation[flagName].source === 'org')
      && brandId !== null,
    // False for a brand evaluated only because it carries a pre-existing merged override: it has
    // nothing of its own to delete, and its value comes entirely from its organization's old rows.
    hasOwnOldRows: staleRows.length > 0,
    staleRows,
  };
}

/**
 * Builds the whole migration plan from the raw rows of all three flag names.
 *
 * A scope is evaluated when it has old state to carry forward:
 *  - it carries at least one OLD-flag row of its own; or
 *  - it is a brand carrying ONLY a pre-existing `serenity_tag_multi_dimension` override while its
 *    organization still has old rows. That brand inherits the organization's old state, so its
 *    merged value has to be checked against the derived one -- omitting it would hide exactly the
 *    case where a brand override of `false` silently holds a brand back from (or a `true` pushes
 *    it ahead of) what its organization's old rows say. Such a scope has no old row of its own,
 *    so it is always `already-migrated` or `CONFLICT`, never `insert`, and has nothing to delete.
 *
 * A scope with no old state anywhere -- no rows of its own and no organization row to inherit --
 * needs no migration and is deliberately absent from the plan.
 *
 * @param {object[]} rows - Raw `feature_flags` rows for `LLMO` and the three flag names.
 * @returns {{entries: object[], conflicts: object[], counts: object}} The plan.
 */
export function planTagFlagMigration(rows) {
  const organizations = groupRowsByOrganization(rows);
  const entries = [];

  for (const org of organizations.values()) {
    const orgHasOldRows = OLD_FLAG_NAMES.some((flagName) => org.orgOld.has(flagName));
    if (orgHasOldRows) {
      entries.push(buildScopeEntry(org, null));
    }

    const brandIds = new Set(org.brandOld.keys());
    if (orgHasOldRows) {
      for (const brandId of org.existingNew.keys()) {
        if (brandId !== null) {
          brandIds.add(brandId);
        }
      }
    }
    for (const brandId of brandIds) {
      entries.push(buildScopeEntry(org, brandId));
    }
  }

  // Deterministic output: organization, its own row first, then its brands by id.
  entries.sort((a, b) => {
    if (a.organizationId !== b.organizationId) {
      return a.organizationId < b.organizationId ? -1 : 1;
    }
    if (a.brandId === b.brandId) {
      return 0;
    }
    if (a.brandId === null) {
      return -1;
    }
    if (b.brandId === null) {
      return 1;
    }
    return a.brandId < b.brandId ? -1 : 1;
  });

  const countWhere = (predicate) => entries.filter(predicate).length;
  const counts = {
    organizations: new Set(entries.map((e) => e.organizationId)).size,
    scopes: entries.length,
    orgScopes: countWhere((e) => e.scope === 'org'),
    brandScopes: countWhere((e) => e.scope === 'brand'),
    enabled: countWhere((e) => e.value === true),
    disabled: countWhere((e) => e.value === false),
    inserts: countWhere((e) => e.action === 'insert'),
    alreadyMigrated: countWhere((e) => e.action === 'already-migrated'),
    conflicts: countWhere((e) => e.action === 'conflict'),
    brandScopesInheriting: countWhere((e) => e.inheritsFromOrg),
    scopesWithoutOldRows: countWhere((e) => !e.hasOwnOldRows),
    staleRows: entries.reduce((total, e) => total + e.staleRows.length, 0),
  };

  return {
    entries,
    conflicts: entries.filter((e) => e.action === 'conflict'),
    counts,
  };
}

/**
 * Renders the plan as operator-readable evidence: a counts block to record before deploying,
 * then one block per scope spelling out the derivation that produced its value.
 *
 * @param {{entries: object[], counts: object}} plan - From {@link planTagFlagMigration}.
 * @returns {string[]} Report lines.
 */
export function formatPlanReport(plan) {
  const { counts } = plan;
  const lines = [
    '--- serenity tag flag migration plan --------------------------------------',
    `organizations touched        : ${counts.organizations}`,
    `scopes to migrate            : ${counts.scopes} (org ${counts.orgScopes}, brand ${counts.brandScopes})`,
    `  ${NEW_FLAG_NAME}=true      : ${counts.enabled}`,
    `  ${NEW_FLAG_NAME}=false     : ${counts.disabled}`,
    `actions                      : insert ${counts.inserts}, already-migrated ${counts.alreadyMigrated}, CONFLICT ${counts.conflicts}`,
    `brand scopes inheriting a half from their org row: ${counts.brandScopesInheriting}`,
    `scopes evaluated with no old row of their own    : ${counts.scopesWithoutOldRows}`,
    `stale old rows in scope for deletion             : ${counts.staleRows}`,
    '',
  ];

  for (const entry of plan.entries) {
    const scopeLabel = entry.brandId === null
      ? `org ${entry.organizationId} (org scope)`
      : `org ${entry.organizationId} brand ${entry.brandId}`;
    const derivation = OLD_FLAG_NAMES
      .map((flagName) => `${flagName}=${entry.derivation[flagName].value}(${entry.derivation[flagName].source})`)
      .join(' OR ');
    lines.push(`[${entry.action.toUpperCase()}] ${scopeLabel}`);
    lines.push(`    ${derivation} => ${NEW_FLAG_NAME}=${entry.value}`);
    if (entry.action === 'conflict') {
      lines.push(`    !! existing ${NEW_FLAG_NAME} row ${entry.existingRowId} carries ${entry.existingValue} -- NOT overwritten, resolve by hand`);
    }
    if (!entry.hasOwnOldRows) {
      lines.push(`    no old row of its own -- evaluated because it carries a pre-existing ${NEW_FLAG_NAME} override and inherits this org's old state`);
    }
    const stale = entry.staleRows.map((row) => `${row.flagName}=${row.value}#${row.id}`).join(', ');
    lines.push(`    stale rows: ${stale.length > 0 ? stale : '(none)'}`);
  }

  lines.push('---------------------------------------------------------------------------');
  return lines;
}

// ---------------------------------------------------------------------------
// PostgREST access (one query shape per operation, all injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Fetches every `feature_flags` row of the given LLMO flag names, keyset-paginated on the
 * immutable primary key `id` and terminating on an EMPTY page -- a short page means nothing
 * under PostgREST's server-side `db-max-rows` cap (same rationale as
 * scripts/reconcile-org-identity-integrity.mjs).
 *
 * Wildcard projection is mandatory: naming `brand_id` fails against a database that predates the
 * brand-scope migration, and omitting it once the column exists makes every override row arrive
 * as the organization's own (see `isOrgRow` in src/support/feature-flags-storage.js).
 *
 * @param {object} params
 * @param {object} params.postgrestClient - PostgREST client.
 * @param {string[]} params.flagNames - Flag names to read.
 * @param {string|null} [params.organizationId] - Optional single-organization filter.
 * @param {number} [params.pageSize] - Rows per page.
 * @returns {Promise<object[]>} Every matching row.
 */
export async function fetchFlagRows({
  postgrestClient,
  flagNames,
  organizationId = null,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const rows = [];
  let lastId = null;
  for (;;) {
    let query = postgrestClient
      .from('feature_flags')
      .select('*')
      .eq('product', FEATURE_FLAG_PRODUCT)
      .in('flag_name', flagNames)
      .order('id', { ascending: true });
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    if (lastId !== null) {
      query = query.gt('id', lastId);
    }
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await query.limit(pageSize);
    if (error) {
      throw new Error(`Failed to read feature_flags after id=${lastId ?? '(start)'}: ${error.message}`);
    }
    const page = data ?? [];
    if (page.length === 0) {
      return rows;
    }
    if (rows.length + page.length > MAX_ROWS_PER_FETCH) {
      throw new Error(
        `Aborting read: more than ${MAX_ROWS_PER_FETCH} feature_flags rows matched, which is far `
        + 'beyond this table\'s expected size and points at a filter or pagination bug.',
      );
    }
    rows.push(...page);
    lastId = page[page.length - 1].id;
  }
}

/**
 * Reads BOTH scopes of `serenity_tag_multi_dimension` for one organization in a single query and
 * returns the row governing one scope, mirroring `readFeatureFlagScopes`. Used to verify a write
 * landed, so it deliberately re-reads from the database rather than trusting the insert's echo.
 *
 * @param {object} params
 * @param {object} params.postgrestClient - PostgREST client.
 * @param {string} params.organizationId - Organization UUID.
 * @param {string|null} params.brandId - Brand UUID, or null for the organization's own row.
 * @returns {Promise<object|null>} The row for that exact scope, or null.
 */
export async function readNewFlagRow({ postgrestClient, organizationId, brandId }) {
  const { data, error } = await postgrestClient
    .from('feature_flags')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('product', FEATURE_FLAG_PRODUCT)
    .eq('flag_name', NEW_FLAG_NAME);
  if (error) {
    throw new Error(`Failed to read back ${NEW_FLAG_NAME} for org ${organizationId}: ${error.message}`);
  }
  // Scope selection happens in JS, not in the filter: `brand_id` cannot be named in a query
  // against a database that predates the brand-scope migration.
  return (data ?? []).find((row) => rowBrandId(row) === brandId) ?? null;
}

/**
 * Inserts one derived `serenity_tag_multi_dimension` row. No `on_conflict` target is named (the
 * plan already established the row is absent), so this does not depend on the shape of the
 * table's unique key -- the same trade-off `upsertFeatureFlag` documents.
 *
 * @param {object} params
 * @param {object} params.postgrestClient - PostgREST client.
 * @param {object} params.entry - Plan entry to write.
 * @param {string} params.updatedBy - `updated_by` audit value.
 * @returns {Promise<object>} The inserted row as echoed by PostgREST.
 */
export async function insertNewFlagRow({ postgrestClient, entry, updatedBy }) {
  const row = {
    organization_id: entry.organizationId,
    product: FEATURE_FLAG_PRODUCT,
    flag_name: NEW_FLAG_NAME,
    flag_value: entry.value,
    updated_by: updatedBy,
  };
  if (entry.brandId !== null) {
    // Composite FK (organization_id, brand_id) -> brands(organization_id, id) guarantees the
    // brand belongs to this organization; a foreign brand id is rejected by the database.
    row.brand_id = entry.brandId;
  }

  const { data, error } = await postgrestClient
    .from('feature_flags')
    .insert(row)
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to write ${NEW_FLAG_NAME} for ${entry.key}: ${error.message}`);
  }
  return data;
}

/**
 * Deletes rows by primary key, in batches. Addressing rows by `id` -- never by a
 * flag_name/org/brand filter -- means a deletion can only ever touch rows this run planned and
 * verified.
 *
 * @param {object} params
 * @param {object} params.postgrestClient - PostgREST client.
 * @param {string[]} params.ids - Row ids to delete.
 * @returns {Promise<string[]>} The ids PostgREST reports as deleted.
 */
export async function deleteRowsByIds({ postgrestClient, ids }) {
  const deleted = [];
  for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DELETE_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await postgrestClient
      .from('feature_flags')
      .delete()
      .in('id', batch)
      .select('id');
    if (error) {
      throw new Error(`Failed to delete stale rows [${batch.join(', ')}]: ${error.message}`);
    }
    deleted.push(...(data ?? []).map((row) => row.id));
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Reads, plans, reports and -- only when `apply` is set -- writes.
 *
 * Any conflicting scope aborts the whole run before the first write, `--delete-stale` included:
 * the scopes are not independent (a brand can inherit its org's old rows), so there is no safe
 * "migrate the rest" mode.
 *
 * Phase order is structural, not conventional: every write is followed by a read-back that
 * asserts the persisted `flag_value`, and the delete phase runs over the entries that survived
 * that check, after the loop. A verification failure throws out of the write loop, so the delete
 * phase is unreachable and the old rows are still there to re-run against.
 *
 * @param {object} params
 * @param {object} params.postgrestClient - PostgREST client.
 * @param {object} [params.options] - Parsed CLI options (see {@link parseOptions}).
 * @param {object} [params.log] - Logger.
 * @returns {Promise<object>} Summary counts for the operator.
 */
export async function runMigration({ postgrestClient, options = {}, log = console }) {
  const {
    apply = false,
    deleteStale = false,
    organizationId = null,
    pageSize = DEFAULT_PAGE_SIZE,
    updatedBy = DEFAULT_UPDATED_BY,
  } = options;

  if (deleteStale && !apply) {
    throw new Error('--delete-stale requires --apply: stale rows are only removed after the new rows are written and verified');
  }

  const rows = await fetchFlagRows({
    postgrestClient,
    flagNames: ALL_FLAG_NAMES,
    organizationId,
    pageSize,
  });
  const plan = planTagFlagMigration(rows);
  formatPlanReport(plan).forEach((line) => log.info(line));

  const summary = {
    mode: apply ? 'apply' : 'preview',
    counts: plan.counts,
    written: 0,
    verified: 0,
    deleted: 0,
    conflicts: plan.conflicts.map((entry) => ({
      key: entry.key,
      organizationId: entry.organizationId,
      brandId: entry.brandId,
      derivedValue: entry.value,
      existingValue: entry.existingValue,
      existingRowId: entry.existingRowId,
    })),
  };

  if (!apply) {
    log.info(`PREVIEW ONLY -- nothing was written or deleted. Re-run with --apply to write ${plan.counts.inserts} row(s).`);
    return summary;
  }

  // Fatal for every write mode, --delete-stale included. Migrating "the rest" and deleting an
  // organization's old rows would change what an unresolved brand scope derives on the next run,
  // so a conflict anywhere stops everything until an operator resolves it.
  if (plan.conflicts.length > 0) {
    throw new Error(
      `${plan.conflicts.length} scope(s) already carry a ${NEW_FLAG_NAME} row whose value differs `
      + 'from the derived one. NOTHING was written or deleted. Resolve each conflicting row by '
      + 'hand (delete it, or correct its value to the derived one) and re-run.',
    );
  }

  const verified = [];
  for (const entry of plan.entries) {
    if (entry.action === 'insert') {
      // eslint-disable-next-line no-await-in-loop
      await insertNewFlagRow({ postgrestClient, entry, updatedBy });
      summary.written += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    const persisted = await readNewFlagRow({
      postgrestClient,
      organizationId: entry.organizationId,
      brandId: entry.brandId,
    });
    if (!persisted || persisted.flag_value !== entry.value) {
      throw new Error(
        `Verification FAILED for ${entry.key}: expected ${NEW_FLAG_NAME}=${entry.value}, read back `
        + `${persisted ? persisted.flag_value : '(no row)'}. No stale row has been deleted; `
        + 'the old flags still govern. Re-run this command after investigating.',
      );
    }
    summary.verified += 1;
    verified.push(entry);
  }
  log.info(`Wrote ${summary.written} row(s); verified ${summary.verified} scope(s) against the database.`);

  if (!deleteStale) {
    log.info(
      `Stale old-flag rows KEPT (${plan.counts.staleRows} row(s)). They are inert once the merged-flag `
      + 'code is deployed; re-run with --apply --delete-stale AFTER that deploy to remove them.',
    );
    return summary;
  }

  const staleIds = verified.flatMap((entry) => entry.staleRows.map((row) => row.id));
  const deleted = await deleteRowsByIds({ postgrestClient, ids: staleIds });
  summary.deleted = deleted.length;
  if (deleted.length !== staleIds.length) {
    log.warn(`Requested deletion of ${staleIds.length} stale row(s) but the database reported ${deleted.length}. Re-run to confirm the remainder.`);
  }
  log.info(`Deleted ${summary.deleted} stale old-flag row(s) across ${verified.length} verified scope(s).`);
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parses and validates argv. Preview is the default: writing requires an explicit `--apply`, and
 * deleting requires `--delete-stale` on top of it. There is intentionally no flag that lets a run
 * proceed past a conflict -- an unknown option (including the removed `--skip-conflicts`) is
 * rejected by `parseArgs` in strict mode.
 *
 * @param {string[]} args - argv slice (without node and the script path).
 * @returns {object} Options for {@link runMigration}.
 * @throws {Error} On any invalid or unsafe combination.
 */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      apply: { type: 'boolean', default: false },
      'delete-stale': { type: 'boolean', default: false },
      'org-id': { type: 'string' },
      'updated-by': { type: 'string' },
      'page-size': { type: 'string' },
    },
  });

  const organizationId = values['org-id'] ?? null;
  if (organizationId !== null && !UUID_RE.test(organizationId)) {
    throw new Error(`--org-id must be a UUID, got "${organizationId}"`);
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (values['page-size'] !== undefined) {
    pageSize = Number(values['page-size']);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new Error(`--page-size must be an integer between 1 and ${MAX_PAGE_SIZE}, got "${values['page-size']}"`);
    }
  }

  const options = {
    apply: values.apply === true,
    deleteStale: values['delete-stale'] === true,
    organizationId,
    updatedBy: values['updated-by'] ?? DEFAULT_UPDATED_BY,
    pageSize,
  };

  if (options.deleteStale && !options.apply) {
    throw new Error('--delete-stale requires --apply');
  }
  return options;
}

/**
 * @param {object} [log] - Logger.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(log = console) {
  let options;
  try {
    options = parseOptions(argv.slice(2));
  } catch (e) {
    log.error(`ERROR: ${e.message}`);
    return 1;
  }

  if (!env.POSTGREST_URL) {
    log.error('ERROR: POSTGREST_URL is required');
    return 1;
  }
  // Writes need the postgrest_writer identity; reads are granted to postgrest_anon. The key is
  // always taken from the environment -- never a literal in this file or in a runbook.
  if (options.apply && !env.POSTGREST_API_KEY) {
    log.error('ERROR: POSTGREST_API_KEY (postgrest_writer) is required for --apply; reads alone run as postgrest_anon');
    return 1;
  }
  if (!options.apply && !env.POSTGREST_API_KEY) {
    log.warn('POSTGREST_API_KEY not set; previewing as postgrest_anon (read-only)');
  }

  const dataAccess = createDataAccess({
    postgrestUrl: env.POSTGREST_URL,
    postgrestSchema: env.POSTGREST_SCHEMA,
    postgrestApiKey: env.POSTGREST_API_KEY,
  }, log);

  try {
    const summary = await runMigration({
      postgrestClient: dataAccess.services.postgrestClient,
      options,
      log,
    });
    log.info(`Summary: ${JSON.stringify(summary)}`);
    if (summary.conflicts.length > 0) {
      log.error(`${summary.conflicts.length} conflicting scope(s) need an operator decision -- see the CONFLICT lines above.`);
      return 1;
    }
    return 0;
  } catch (e) {
    log.error(`ERROR: ${e.message}`);
    return 1;
  }
}

// Only self-execute when run as a script, so the exported helpers above can be unit tested.
const invokedDirectly = argv[1] !== undefined
  && import.meta.url === pathToFileURL(argv[1]).href;
/* c8 ignore next 3 -- CLI entry point, exercised by running the script itself */
if (invokedDirectly) {
  exit(await main());
}
