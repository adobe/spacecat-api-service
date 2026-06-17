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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../utils.js';
import { SerenityTransportError } from './rest-transport.js';

/**
 * Brand-level URLs (the brand's own sites, social accounts, and earned-content
 * sources) propagated onto every market/project in a brand, mirroring how brand
 * aliases populate a project's `brand_names`. Upstream they are all "brand URLs"
 * attached to a project's main-brand benchmark, distinguished only by a
 * free-form `type` label (Semrush caps it at 32 chars).
 */
export const BRAND_URL_TYPE = Object.freeze({
  WEBSITE: 'website',
  SOCIAL: 'social',
  EARNED: 'earned',
});

// A market with no region constraint: brand URLs that should apply everywhere.
// Brand `urls` carry no region at all (always all-markets); social/earned carry
// an explicit `regions` list, where empty OR 'ww' (worldwide) also means all.
const WORLDWIDE = 'ww';

/**
 * Whether a URL tagged with `regions` applies to `market` (ISO-2 country code).
 * A URL applies when it has no regions (region-less ⇒ all markets), is marked
 * worldwide ('ww'), or explicitly lists the market. Matching is
 * case-insensitive (regions are stored lower-cased, e.g. ['us']).
 */
export function regionApplies(regions, market) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return true;
  }
  const target = String(market || '').trim().toLowerCase();
  return regions.some((r) => {
    const code = String(r || '').trim().toLowerCase();
    return code === WORLDWIDE || (target.length > 0 && code === target);
  });
}

// Normalizes one source entry to a single `{ url, type }`, keeping only HTTPS
// URLs (the brand-URLs API rejects non-https with 400, so a stored http URL
// would otherwise hard-fail the whole push). Returns null when unusable.
function toEntry(url, type) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!hasText(value) || !value.toLowerCase().startsWith('https://')) {
    return null;
  }
  return { url: value, type };
}

/**
 * Builds the `{ url, type }[]` to push to a single market's project from a
 * brand's URL sources (the V2 shape: `urls`, `socialAccounts`, `earnedContent`
 * — the same shape the create payload and a persisted brand both carry):
 *   - brand `urls` → type `website`, region-less (applied to every market);
 *   - `socialAccounts` → type `social`, filtered to the market's region;
 *   - `earnedContent` → type `earned`, filtered to the market's region.
 *
 * Only HTTPS URLs survive. The result is de-duplicated by URL (first-seen wins,
 * so a brand site listed both as a URL and a social account keeps its `website`
 * type) — brand URLs are unique per project upstream, so duplicates would be
 * skipped anyway; de-duping here keeps the `type` we send deterministic.
 *
 * @param {object} sources - { urls?, socialAccounts?, earnedContent? }.
 * @param {string} market - ISO-2 country code of the target project.
 * @returns {{url: string, type: string}[]}
 */
export function collectBrandUrlEntries(sources, market) {
  const urls = Array.isArray(sources?.urls) ? sources.urls : [];
  const social = Array.isArray(sources?.socialAccounts) ? sources.socialAccounts : [];
  const earned = Array.isArray(sources?.earnedContent) ? sources.earnedContent : [];

  const candidates = [
    // Brand URLs carry no region — always every market. Accept both the string
    // and the { value } object shape the create payload may use.
    ...urls.map((u) => toEntry(typeof u === 'string' ? u : u?.value, BRAND_URL_TYPE.WEBSITE)),
    ...social
      .filter((s) => regionApplies(s?.regions, market))
      .map((s) => toEntry(s?.url, BRAND_URL_TYPE.SOCIAL)),
    ...earned
      .filter((e) => regionApplies(e?.regions, market))
      .map((e) => toEntry(e?.url, BRAND_URL_TYPE.EARNED)),
  ];

  const seen = new Set();
  return candidates.filter((e) => {
    if (e === null || seen.has(e.url)) {
      return false;
    }
    seen.add(e.url);
    return true;
  });
}

/**
 * Resolves a project's main-brand benchmark id — the `benchmark_id` the brand
 * URL endpoints require. The main brand carries `main_brand: true`; we fall back
 * to the first benchmark if the flag is absent (older projects). Throws a 502
 * when the project has no benchmarks at all (it should always have its own).
 */
export async function resolveMainBenchmarkId(transport, workspaceId, projectId) {
  const resp = await transport.listBenchmarks(workspaceId, projectId);
  const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];
  const main = benchmarks.find((b) => b?.main_brand === true) || benchmarks[0];
  if (!main || !hasText(main.id)) {
    throw new ErrorWithStatusCode(
      `No main-brand benchmark for project ${projectId}`,
      502,
    );
  }
  return String(main.id);
}

/**
 * Pushes the given brand-URL entries onto a project's main-brand benchmark.
 * A no-op when there are no entries. Errors propagate (the caller hard-fails the
 * surrounding create) — the upstream silently skips URLs already present in the
 * project, so a re-attach is naturally idempotent.
 *
 * @returns {Promise<{created: number}>} count of entries submitted (0 on no-op).
 */
export async function attachBrandUrlsToProject(transport, workspaceId, projectId, entries, log) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { created: 0 };
  }
  const benchmarkId = await resolveMainBenchmarkId(transport, workspaceId, projectId);
  await transport.createBrandUrls(workspaceId, projectId, benchmarkId, entries);
  log?.info?.('brand-urls: attached to project benchmark', {
    workspaceId, projectId, benchmarkId, count: entries.length,
  });
  return { created: entries.length };
}

// Best-effort republish after an edit-time change so the live view reflects it.
// Swallows a quota 405 (publishing an empty-units child 405s as a disguised
// quota rejection — same convention as the market-create path); any other
// failure propagates so the edit hard-fails. Shared by the brand-URL and
// CI-competitor edit re-syncs.
export async function republishBestEffort(transport, workspaceId, projectId, log) {
  try {
    await transport.publishProject(workspaceId, projectId);
  } catch (e) {
    if (e instanceof SerenityTransportError && e.status === 405) {
      log?.warn?.('brand-urls: republish skipped — quota 405, project left as draft', {
        workspaceId, projectId,
      });
      return;
    }
    throw e;
  }
}

// ISO-2 country code of a project's market (v1 default view echoes it at
// settings.ai.country.code). Used to region-filter per existing market on the
// edit re-sync. Null when absent (project skipped — not region-addressable).
// Shared by the brand-URL and CI-competitor edit re-syncs.
export function marketOf(project) {
  const code = project?.settings?.ai?.country?.code;
  return hasText(code) ? String(code).toLowerCase() : null;
}

/**
 * Re-syncs a brand's URL set onto every market/project in its sub-workspace
 * (the brand-edit path). For each project: builds the region-filtered desired
 * set, diffs it against the benchmark's live brand URLs, creates the additions,
 * deletes the removals, and republishes (best-effort) when anything changed.
 * Create/delete errors propagate so the edit hard-fails; a quota 405 on the
 * republish alone is tolerated.
 *
 * @returns {Promise<{markets: number, created: number, deleted: number}>}
 */
export async function syncBrandUrlsAcrossMarkets(transport, sources, workspaceId, log) {
  const listing = await transport.listProjects(workspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];

  let created = 0;
  let deleted = 0;
  let markets = 0;

  for (const project of projects) {
    const projectId = hasText(project?.id) ? String(project.id) : null;
    const market = marketOf(project);
    if (!projectId || market === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    markets += 1;

    const desired = collectBrandUrlEntries(sources, market);
    // eslint-disable-next-line no-await-in-loop
    const benchmarkId = await resolveMainBenchmarkId(transport, workspaceId, projectId);
    // eslint-disable-next-line no-await-in-loop
    const existingResp = await transport.listBrandUrls(workspaceId, projectId, benchmarkId);
    const existing = Array.isArray(existingResp?.brand_urls) ? existingResp.brand_urls : [];

    const existingByUrl = new Map();
    existing.forEach((row) => {
      if (hasText(row?.url)) {
        existingByUrl.set(row.url, row.id);
      }
    });
    const desiredUrls = new Set(desired.map((e) => e.url));

    const toCreate = desired.filter((e) => !existingByUrl.has(e.url));
    const toDelete = existing
      .filter((row) => hasText(row?.url) && hasText(row?.id) && !desiredUrls.has(row.url))
      .map((row) => row.id);

    if (toCreate.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await transport.createBrandUrls(workspaceId, projectId, benchmarkId, toCreate);
      created += toCreate.length;
    }
    if (toDelete.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await transport.deleteBrandUrls(workspaceId, projectId, benchmarkId, toDelete);
      deleted += toDelete.length;
    }
    if (toCreate.length > 0 || toDelete.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await republishBestEffort(transport, workspaceId, projectId, log);
    }
  }

  log?.info?.('brand-urls: re-synced across markets', {
    workspaceId, markets, created, deleted,
  });
  return { markets, created, deleted };
}
