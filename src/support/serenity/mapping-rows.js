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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Best-effort maintenance of `brand_to_semrush_projects` rows in sub-workspace
 * mode (serenity-docs brand-semrush-mapping-maintenance.md §4). Every export
 * here catches its own errors, logs a greppable token, and never throws — a
 * mapping-row write failure must never fail a market create/delete that has
 * already succeeded upstream. Callers pass `dataAccess` only when the target
 * brand row is guaranteed to already exist (see `upsertMappingRow` doc); when
 * `dataAccess` is omitted, every helper here is a silent no-op.
 */

// Alarmed (CloudWatch metric filter, spec §6): a real write failure that needs
// a reconcile. Kept as one token across all four helpers, distinguished by the
// `op` field, per the spec's alarm design.
const WRITE_FAILED_TOKEN = 'SERENITY_MAPPING_ROW_WRITE_FAILED';

// Deliberately NOT alarmed: the accepted duplicate-slice / concurrent-adopt
// race (spec §6). Routing this into the alarmed token would fire the
// write-failure alarm — and the reconcile it triggers — on a condition that
// isn't drift.
const DUPLICATE_SLICE_SKIPPED_TOKEN = 'SERENITY_MAPPING_DUPLICATE_SLICE_SKIPPED';

// The live-slice partial unique index (mysticat-data-service migration
// 20260702083210). A 23505 naming it means another LIVE row already owns this
// (brand, geoTargetId, languageCode) slice under a different project id — the
// duplicate-slice race the sub-workspace handlers already tolerate via
// oldest-wins reads. Not necessarily "our" project losing: the loser is
// whichever project id sorts later under the handlers' `orderKey` (lexical,
// since the v1 listing omits `created_at`), which is not always the one that
// was just created.
const LIVE_SLICE_INDEX = 'uq_brand_to_semrush_slice_live';

/**
 * Classifies a `BrandSemrushProject.create` failure. `DataAccessError.cause`
 * (spacecat-shared-data-access) is the raw postgrest-js error: `.code` is the
 * Postgres error code, `.message` names the violated constraint. Anything this
 * cannot positively classify as the accepted race falls through to "error" —
 * fail noisy into the alarmed token, never silently swallow an unrecognized
 * failure.
 *
 * @param {any} error
 * @returns {'duplicate-slice'|'error'}
 */
function classifyUpsertError(error) {
  const cause = /** @type {{code?: string, message?: string}|undefined} */ (error?.cause);
  if (cause?.code === '23505' && String(cause.message || '').includes(LIVE_SLICE_INDEX)) {
    return 'duplicate-slice';
  }
  return 'error';
}

/**
 * Upserts a mapping row after a sub-workspace project is created or adopted.
 * Native PostgREST upsert keyed on `semrushProjectId` — atomic for the common
 * path, and reviving a tombstoned row (an earlier reconcile marked it deleted
 * while the project still existed upstream) for free: `deletedAt: null` is in
 * the payload, `siteId` deliberately is NOT (an upsert only touches the
 * columns it submits — omitting `siteId` leaves any existing link untouched;
 * `linkSiteToLiveRows` is the only writer of that column).
 *
 * IMPORTANT: only call this with a `brandId` that already exists as a row in
 * `brands` — the FK requires it. The sub-workspace market handlers (create,
 * activate's per-market loop) satisfy this; the brand-CREATE provisioning path
 * (`provisionBrandSubworkspace`) does not — it runs before the brand row is
 * written, so it must not receive `dataAccess` here (its caller writes the
 * initial-market row itself, after the brand row exists).
 *
 * @param {any} dataAccess - `ctx.dataAccess`, or undefined/null to no-op.
 * @param {{
 *   brandId: string|null|undefined,
 *   semrushProjectId: string|null|undefined,
 *   geoTargetId: number,
 *   languageCode: string|null|undefined,
 * }} slice
 * @param {any} [log]
 */
export async function upsertMappingRow(dataAccess, {
  brandId, semrushProjectId, geoTargetId, languageCode,
}, log) {
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (!BrandSemrushProject) {
    return;
  }
  if (!brandId || !hasText(brandId) || !semrushProjectId || !hasText(semrushProjectId)
      || !languageCode || !hasText(languageCode) || !geoTargetId || geoTargetId <= 0) {
    // Every real call site resolves these before calling in; a miss here means
    // an upstream bug, not an expected condition — worth a log, unlike the
    // silent `!BrandSemrushProject` no-op above (no data-access wired at all).
    // geoTargetId <= 0 catches a resolved-but-invalid slice (e.g. a caller
    // that couldn't read the upstream geoTargetId and normalized it to 0
    // rather than leaving it undefined) — 0 is never a real Google Ads Geo
    // Target ID (see handlers/markets.js's "must be a positive integer").
    log?.warn?.('serenity mapping row: upsert skipped — incomplete slice', {
      brandId, semrushProjectId, geoTargetId, languageCode,
    });
    return;
  }
  try {
    await BrandSemrushProject.create(
      {
        brandId, semrushProjectId, geoTargetId, languageCode, deletedAt: null,
      },
      { upsert: true, onConflict: 'semrushProjectId' },
    );
  } catch (e) {
    if (classifyUpsertError(e) === 'duplicate-slice') {
      log?.warn?.(`serenity mapping row: ${DUPLICATE_SLICE_SKIPPED_TOKEN} — another live row already owns this slice; not written`, {
        brandId, semrushProjectId, geoTargetId, languageCode, op: 'upsert',
      });
      return;
    }
    log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — upsert failed`, {
      brandId, semrushProjectId, geoTargetId, languageCode, op: 'upsert', error: e?.message,
    });
  }
}

/**
 * Tombstones the mapping row for a deleted project (`deletedAt` set, row kept
 * — Semrush data does not survive project deletion, so the row is the only
 * remaining record it existed). No-op when no row matches; `findBySemrushProjectId`
 * sees tombstones too, so a second call on an already-tombstoned row is a
 * harmless re-set.
 *
 * @param {any} dataAccess
 * @param {string|null|undefined} semrushProjectId
 * @param {any} [log]
 */
export async function tombstoneMappingRow(dataAccess, semrushProjectId, log) {
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (!BrandSemrushProject || !semrushProjectId || !hasText(semrushProjectId)) {
    return;
  }
  try {
    const row = await BrandSemrushProject.findBySemrushProjectId(semrushProjectId);
    if (!row) {
      return;
    }
    row.setDeletedAt(new Date().toISOString());
    await row.save();
  } catch (e) {
    log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — tombstone failed`, {
      semrushProjectId, op: 'tombstone', error: e?.message,
    });
  }
}

/**
 * Bulk-tombstones every LIVE mapping row for a brand (deactivate/decommission
 * — the sub-workspace is emptied, so every project the brand owned is gone).
 * By-brand rather than by-project because decommission only knows the
 * workspace id; this also sweeps rows whose upstream project had already
 * vanished before decommission ran.
 *
 * @param {any} dataAccess
 * @param {string|null|undefined} brandId
 * @param {any} [log]
 */
export async function tombstoneAllForBrand(dataAccess, brandId, log) {
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (!BrandSemrushProject || !brandId || !hasText(brandId)) {
    return;
  }
  try {
    const rows = await BrandSemrushProject.allByBrandId(brandId);
    const live = (Array.isArray(rows) ? rows : []).filter((row) => !row.getDeletedAt());
    const now = new Date().toISOString();
    // allSettled, not all: one row's save rejecting must not abandon the rest
    // mid-flight — a bulk op processes every row it can and only reports what
    // it couldn't, rather than leaving an unbounded number of un-tombstoned
    // rows behind a single transient failure.
    const results = await Promise.allSettled(live.map(async (row) => {
      row.setDeletedAt(now);
      await row.save();
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — partial bulk tombstone`, {
        brandId, op: 'tombstone-all', failed: failed.length, total: live.length,
      });
    }
  } catch (e) {
    log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — bulk tombstone failed`, {
      brandId, op: 'tombstone-all', error: e?.message,
    });
  }
}

/**
 * Links `siteId` onto every LIVE, currently-unlinked mapping row for a brand.
 * Scope-guarded to `siteId IS NULL` rows only — never overwrites an existing
 * link; correcting a wrong link is reconcile's job, not this best-effort call.
 * By-brand-where-null instead of per-project: every market in one create/
 * activate batch shares the single resolved `brandDomain`, hence one mirror
 * Site, so this also picks up sibling rows written elsewhere in the same
 * batch without threading per-project state between them.
 *
 * @param {any} dataAccess
 * @param {string|null|undefined} brandId
 * @param {string|null|undefined} siteId
 * @param {any} [log]
 */
export async function linkSiteToLiveRows(dataAccess, brandId, siteId, log) {
  const BrandSemrushProject = dataAccess?.BrandSemrushProject;
  if (!BrandSemrushProject || !brandId || !hasText(brandId) || !siteId || !hasText(siteId)) {
    return;
  }
  try {
    const rows = await BrandSemrushProject.allByBrandId(brandId);
    const unlinked = (Array.isArray(rows) ? rows : [])
      .filter((row) => !row.getDeletedAt() && !row.getSiteId());
    // Same allSettled rationale as tombstoneAllForBrand above.
    const results = await Promise.allSettled(unlinked.map(async (row) => {
      row.setSiteId(siteId);
      await row.save();
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — partial site link`, {
        brandId, siteId, op: 'link-site', failed: failed.length, total: unlinked.length,
      });
    }
  } catch (e) {
    log?.error?.(`serenity mapping row: ${WRITE_FAILED_TOKEN} — site link failed`, {
      brandId, siteId, op: 'link-site', error: e?.message,
    });
  }
}
