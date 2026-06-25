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

import { SerenityTransportError } from './rest-transport.js';
import { resolveProjects } from './resolve-projects.js';

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

// Normalizes a benchmark/brand domain for identity comparison: lowercase host,
// no scheme, no leading `www.`, no path. Null when unparseable. Used to match an
// existing own-brand benchmark across runs (idempotent ensure) and shared by the
// competitor-benchmark sync to match/dedupe competitors by domain.
export function normalizeBenchmarkDomain(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return null;
  }
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Ensures the project has a benchmark to hang brand URLs on, and returns its id.
 *
 * Brand URLs can only be created *under a benchmark*. Semrush is meant to
 * auto-provision the project's own-brand (`main_brand: true`) benchmark from the
 * project's `brand_names`/`domain`, but some tenants don't — leaving the project
 * with zero benchmarks and nowhere to attach URLs. So we resolve the own-brand
 * benchmark, creating it when absent:
 *   1. an existing `main_brand: true` benchmark (the system one) always wins;
 *   2. else an existing benchmark whose domain matches the brand's own domain
 *      (the one a previous run created — keeps the ensure idempotent);
 *   3. else create it from the brand's name + domain + aliases.
 *
 * A benchmark we create is NOT `main_brand` (the create API can't set it), but
 * brand URLs attach to any benchmark, so that does not affect URL sync. Returns
 * `null` only when there is no benchmark to reuse AND no usable domain to create
 * one with — callers then skip the URL attach (never a hard failure).
 *
 * @param {object} brand - { name, domain, aliases? } identity of the own brand.
 */
export async function ensureOwnBrandBenchmark(transport, workspaceId, projectId, brand, log) {
  const resp = await transport.listBenchmarks(workspaceId, projectId);
  const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];
  const ownDomain = normalizeBenchmarkDomain(brand?.domain);
  const matchesOwn = (b) => hasText(b?.id) && ownDomain !== null
    && normalizeBenchmarkDomain(b?.domain) === ownDomain;

  const existing = benchmarks.find((b) => b?.main_brand === true && hasText(b?.id))
    || benchmarks.find(matchesOwn);
  if (existing) {
    return String(existing.id);
  }

  // Nothing to reuse — create the own-brand benchmark. Needs a name + domain.
  if (!hasText(brand?.name) || ownDomain === null) {
    return null;
  }
  const body = [{
    brand_name: brand.name,
    domain: brand.domain,
    ...(Array.isArray(brand.aliases) && brand.aliases.length
      ? { brand_aliases: brand.aliases }
      : {}),
  }];
  try {
    const created = await transport.createBenchmarks(workspaceId, projectId, body);
    const id = Array.isArray(created?.ids) && created.ids.length ? created.ids[0] : null;
    if (hasText(id)) {
      log?.info?.('brand-urls: created own-brand benchmark', {
        workspaceId, projectId, benchmarkId: id,
      });
      return String(id);
    }
  } catch (e) {
    // 409 = the benchmark already exists (race / duplicate brand name). Fall
    // through to re-list + match rather than failing the URL attach.
    if (!(e instanceof SerenityTransportError && e.status === 409)) {
      throw e;
    }
  }
  // Create returned no id (existing_count) or 409'd — re-list and match by domain.
  const after = await transport.listBenchmarks(workspaceId, projectId);
  const afterList = Array.isArray(after?.aio_benchmarks) ? after.aio_benchmarks : [];
  const found = afterList.find(matchesOwn);
  return found ? String(found.id) : null;
}

/**
 * Pushes the given brand-URL entries onto the project's own-brand benchmark,
 * creating that benchmark first when the project has none (see
 * {@link ensureOwnBrandBenchmark}). A no-op when there are no entries. When no
 * benchmark can be resolved or created (no usable brand domain), the attach is
 * skipped with a warning instead of failing. An upstream push error still
 * propagates; the upstream silently skips URLs already present, so a re-attach
 * is idempotent.
 *
 * @param {object} brand - { name, domain, aliases? } of the project's own brand,
 *   used to find-or-create the benchmark the URLs attach to.
 * @returns {Promise<{created: number, skipped?: boolean}>} count submitted
 *   (0 on no-op or when skipped for a missing benchmark).
 */
export async function attachBrandUrlsToProject(
  transport,
  workspaceId,
  projectId,
  entries,
  brand,
  log,
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { created: 0 };
  }
  const benchmarkId = await ensureOwnBrandBenchmark(transport, workspaceId, projectId, brand, log);
  if (benchmarkId === null) {
    log?.warn?.('brand-urls: no benchmark available — skipping URL attach', {
      workspaceId, projectId, count: entries.length,
    });
    return { created: 0, skipped: true };
  }
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
 * @param {object} transport - Semrush transport.
 * @param {object} sources - the brand's URL sources ({ urls?, socialAccounts?,
 *   earnedContent? }), region-filtered per market by {@link collectBrandUrlEntries}.
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {object} [log]
 * @param {Array<object>|null} [prefetchedProjects=null] - a pre-fetched project listing
 *   to reuse (the brand-edit path lists once and shares it across the URL/competitor/alias
 *   syncs); null/undefined lists here. An explicit `[]` reuses the prefetch (no re-list).
 * @returns {Promise<{markets: number, created: number, deleted: number}>}
 */
export async function syncBrandUrlsAcrossMarkets(
  transport,
  sources,
  workspaceId,
  log,
  prefetchedProjects = null,
) {
  // Reuse a pre-fetched project listing when the caller already has one (the
  // brand-edit path lists once and shares it across the URL/competitor/alias
  // syncs), else list here. The listing is stable across a brand-row write.
  const projects = await resolveProjects(transport, workspaceId, prefetchedProjects);

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

    try {
      const desired = collectBrandUrlEntries(sources, market);
      // Own-brand identity for the benchmark comes from the project itself: its
      // domain plus the brand_names (display name first, the rest are aliases).
      const ai = project?.settings?.ai || {};
      const brandNames = Array.isArray(ai.brand_names) ? ai.brand_names : [];
      const brand = {
        name: hasText(ai.brand_name_display) ? ai.brand_name_display : brandNames[0],
        domain: project?.domain,
        aliases: hasText(ai.brand_name_display) ? brandNames : brandNames.slice(1),
      };
      // eslint-disable-next-line no-await-in-loop
      const benchmarkId = await ensureOwnBrandBenchmark(
        transport,
        workspaceId,
        projectId,
        brand,
        log,
      );
      if (benchmarkId === null) {
        // No benchmark and none creatable for this project — skip (warn) instead
        // of failing the whole edit re-sync.
        log?.warn?.('brand-urls: no benchmark available — skipping market', {
          workspaceId, projectId,
        });
        markets -= 1;
        // eslint-disable-next-line no-continue
        continue;
      }
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
    } catch (e) {
      // A mid-fan-out failure must name WHICH market split so the brand-edit
      // hard-fail (brands.js) is diagnosable per market, not just by the
      // aggregate count the caller logs. Record the failing project/market
      // (status only — the upstream error text carries the gateway URL), then
      // rethrow to fail the edit re-sync.
      log?.error?.('brand-urls: market sync failed', {
        workspaceId, projectId, market, status: e?.status,
      });
      throw e;
    }
  }

  log?.info?.('brand-urls: re-synced across markets', {
    workspaceId, markets, created, deleted,
  });
  return { markets, created, deleted };
}
