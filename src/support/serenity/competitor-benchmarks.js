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

import {
  regionApplies,
  normalizeBenchmarkDomain,
  marketOf,
  republishBestEffort,
} from './brand-urls.js';

/**
 * A brand's competitors ("other brands to track") propagated onto each
 * market/project as Semrush AIO **benchmarks** — the same surface as the
 * own-brand benchmark and brand URLs. NOTE: this replaces the earlier
 * `settings.ci.competitors` approach, which targets a Competitive-Intelligence
 * project feature that AIO projects do not have (their `settings.ci` is null, so
 * the CI PUT was a silent no-op). A competitor here is `{ name, domain }`; the
 * created benchmark is `main_brand: false` (the create API cannot set it).
 */

/**
 * Builds the set of the brand's OWN normalized domains — its primary, every
 * market/project domain, and its own website URLs — that a competitor must never
 * collide with. Tracking your own property as a competitor would create a
 * benchmark that double-counts the brand against itself (or, for the project's
 * own domain, silently no-ops), so these are excluded from competitor sync.
 *
 * Social / earned domains are intentionally NOT reserved: those are third-party
 * platform domains (e.g. a social network), legitimately also trackable.
 *
 * @param {Array<string>} [domains=[]] - project/market domains (and the primary).
 * @param {Array<string|{value:string}>} [urls=[]] - the brand's own website URLs.
 * @returns {Set<string>} normalized reserved domains.
 */
export function buildReservedDomains(domains = [], urls = []) {
  const set = new Set();
  for (const d of Array.isArray(domains) ? domains : []) {
    const n = normalizeBenchmarkDomain(d);
    if (n !== null) {
      set.add(n);
    }
  }
  for (const u of Array.isArray(urls) ? urls : []) {
    const n = normalizeBenchmarkDomain(typeof u === 'string' ? u : u?.value);
    if (n !== null) {
      set.add(n);
    }
  }
  return set;
}

/**
 * Resolves the brand's reserved domains for the persist-time guard: lists the
 * brand's projects (every market domain, incl. the primary) and folds in the
 * brand's own website URLs. Used to strip self-referential competitors BEFORE
 * they are stored, so `brand.competitors` never holds the brand's own property.
 *
 * @returns {Promise<Set<string>>} normalized reserved domains.
 */
export async function resolveReservedDomains(transport, workspaceId, brandOwnUrls = []) {
  const listing = await transport.listProjects(workspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];
  return buildReservedDomains(projects.map((p) => p?.domain), brandOwnUrls);
}

/**
 * Partitions competitors into the ones to keep and the self-referential ones to
 * drop (their domain is one of the brand's `reservedDomains`). Pure — the caller
 * persists `kept` and logs `dropped`.
 *
 * @returns {{ kept: object[], dropped: object[] }}
 */
export function dropReservedCompetitors(competitors, reservedDomains) {
  const list = Array.isArray(competitors) ? competitors : [];
  const kept = [];
  const dropped = [];
  for (const c of list) {
    const domain = normalizeBenchmarkDomain(c?.url);
    if (domain !== null && reservedDomains.has(domain)) {
      dropped.push(c);
    } else {
      kept.push(c);
    }
  }
  return { kept, dropped };
}

/**
 * Builds the `{ name, domain }[]` competitor benchmarks to track for a market,
 * region-filtered (reuses {@link regionApplies}). The domain is extracted from
 * the competitor `url`; entries without a usable url/domain or name are skipped,
 * as are any whose domain is one of the brand's own `reservedDomains` (its
 * primary, market domains, or own website URLs — a competitor can't be us).
 * De-duped by normalized domain (first-seen name wins).
 */
export function collectCompetitorBenchmarks(competitors, market, reservedDomains = new Set()) {
  const list = Array.isArray(competitors) ? competitors : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!regionApplies(c?.regions, market)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const domain = normalizeBenchmarkDomain(c?.url);
    if (domain === null || seen.has(domain) || reservedDomains.has(domain)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // Benchmark needs a brand_name; fall back to the domain when the competitor
    // has no name (real competitors always carry one, this just keeps it robust).
    const name = hasText(c?.name) ? String(c.name).trim() : domain;
    seen.add(domain);
    out.push({ name, domain });
  }
  return out;
}

/**
 * The competitor domains present in `oldCompetitors` but not `newCompetitors`
 * (region-agnostic) — the ones to delete from upstream on a brand edit. The
 * caller reads the OLD competitors before persisting the update.
 */
export function removedCompetitorDomains(oldCompetitors, newCompetitors) {
  const oldList = Array.isArray(oldCompetitors) ? oldCompetitors : [];
  const newList = Array.isArray(newCompetitors) ? newCompetitors : [];
  const newDomains = new Set(
    newList.map((c) => normalizeBenchmarkDomain(c?.url)).filter((d) => d !== null),
  );
  const removed = new Set();
  for (const c of oldList) {
    const domain = normalizeBenchmarkDomain(c?.url);
    if (domain !== null && !newDomains.has(domain)) {
      removed.add(domain);
    }
  }
  return [...removed];
}

/**
 * Syncs a brand's competitors onto ONE project as benchmarks: creates a
 * benchmark for each region-applicable competitor whose domain is not already a
 * benchmark (own-brand or a prior competitor), and deletes the benchmarks of
 * competitors removed from the brand (`removedDomains`). Never deletes the
 * main-brand benchmark. Returns the change counts.
 *
 * @param {string[]} removedDomains - normalized domains removed from the brand.
 * @returns {Promise<{created: number, deleted: number, changed: boolean}>}
 */
export async function syncCompetitorBenchmarksForProject(
  transport,
  workspaceId,
  projectId,
  competitors,
  removedDomains,
  market,
  log,
  reservedDomains = new Set(),
) {
  const desired = collectCompetitorBenchmarks(competitors, market, reservedDomains);
  const removedSet = new Set(
    (Array.isArray(removedDomains) ? removedDomains : [])
      .map((d) => normalizeBenchmarkDomain(d))
      .filter((d) => d !== null),
  );
  // Nothing to add or remove — skip the benchmark read entirely.
  if (desired.length === 0 && removedSet.size === 0) {
    return { created: 0, deleted: 0, changed: false };
  }

  const resp = await transport.listBenchmarks(workspaceId, projectId);
  const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];

  // Domain → benchmark id, for competitor (non-main) benchmarks we could delete.
  const competitorIdByDomain = new Map();
  const presentDomains = new Set();
  for (const b of benchmarks) {
    const domain = normalizeBenchmarkDomain(b?.domain);
    if (domain === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    presentDomains.add(domain);
    if (b?.main_brand !== true && hasText(b?.id)) {
      competitorIdByDomain.set(domain, String(b.id));
    }
  }

  const toCreate = desired
    .filter((c) => !presentDomains.has(c.domain))
    .map((c) => ({ brand_name: c.name, domain: c.domain }));

  const toDelete = [...removedSet]
    .map((d) => competitorIdByDomain.get(d))
    .filter((id) => hasText(id));

  let created = 0;
  let deleted = 0;
  if (toCreate.length > 0) {
    await transport.createBenchmarks(workspaceId, projectId, toCreate);
    created = toCreate.length;
  }
  if (toDelete.length > 0) {
    await transport.deleteBenchmarks(workspaceId, projectId, toDelete);
    deleted = toDelete.length;
  }
  if (created > 0 || deleted > 0) {
    log?.info?.('competitor-benchmarks: synced project', {
      workspaceId, projectId, created, deleted,
    });
  }
  return { created, deleted, changed: created > 0 || deleted > 0 };
}

/**
 * Re-syncs a brand's competitors as benchmarks across every market/project in
 * its sub-workspace (the brand-edit path): per project, region-filter + create
 * additions + delete removals, then republish (best-effort) when anything
 * changed. Create/delete errors propagate; a quota 405 on republish is tolerated.
 *
 * @param {Array<string|{value:string}>} [brandOwnUrls=[]] - the brand's own
 *   website URLs, reserved (with every project domain) so a competitor can't be
 *   one of the brand's own properties.
 * @returns {Promise<{markets: number, created: number, deleted: number}>}
 */
export async function syncCompetitorBenchmarksAcrossMarkets(
  transport,
  competitors,
  removedDomains,
  workspaceId,
  log,
  brandOwnUrls = [],
) {
  const listing = await transport.listProjects(workspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];

  // The brand's own domains across all its markets — every project's domain (the
  // primary is one of them) plus the brand's own website URLs. A competitor whose
  // domain matches any of these is dropped from the sync (can't track yourself).
  const reservedDomains = buildReservedDomains(
    projects.map((p) => p?.domain),
    brandOwnUrls,
  );

  let markets = 0;
  let created = 0;
  let deleted = 0;

  for (const project of projects) {
    const projectId = hasText(project?.id) ? String(project.id) : null;
    const market = marketOf(project);
    if (!projectId || market === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    markets += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await syncCompetitorBenchmarksForProject(
        transport,
        workspaceId,
        projectId,
        competitors,
        removedDomains,
        market,
        log,
        reservedDomains,
      );
      created += result.created;
      deleted += result.deleted;
      if (result.changed) {
        // eslint-disable-next-line no-await-in-loop
        await republishBestEffort(transport, workspaceId, projectId, log);
      }
    } catch (e) {
      // A mid-fan-out failure must name WHICH market split so the brand-edit
      // hard-fail (brands.js) is diagnosable per market, not just by the
      // aggregate count the caller logs. Record the failing project/market
      // (status only — the upstream error text carries the gateway URL), then
      // rethrow to fail the edit re-sync.
      log?.error?.('competitor-benchmarks: market sync failed', {
        workspaceId, projectId, market, status: e?.status,
      });
      throw e;
    }
  }

  log?.info?.('competitor-benchmarks: re-synced across markets', {
    workspaceId, markets, created, deleted,
  });
  return { markets, created, deleted };
}
