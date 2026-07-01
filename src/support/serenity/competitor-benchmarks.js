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
import { dedupeAliases, sameAliasSet, rejectedAliasesFrom } from './aliases.js';
import { resolveProjects } from './resolve-projects.js';

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
 * Builds the `{ name, domain, aliases }[]` competitor benchmarks to track for a
 * market, region-filtered (reuses {@link regionApplies}). The domain is extracted
 * from the competitor `url`; entries without a usable url/domain are skipped, as
 * are any whose domain is one of the brand's own `reservedDomains` (its primary,
 * market domains, or own website URLs — a competitor can't be us). `aliases` are
 * the competitor's alternate names, propagated to the benchmark's `brand_aliases`.
 * De-duped by normalized domain (first-seen name + aliases win).
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
    out.push({ name, domain, aliases: dedupeAliases(c?.aliases) });
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

// Builds the `{ brand_name, domain, brand_aliases? }` benchmark create/update
// body from a collected competitor. `brand_aliases` is omitted when empty so the
// upstream payload stays minimal (and an alias-less update clears nothing it
// shouldn't — the PUT replaces the full benchmark, so we always send the
// computed set, empty meaning "no aliases").
function benchmarkBody(c) {
  return {
    brand_name: c.name,
    domain: c.domain,
    ...(c.aliases.length > 0 ? { brand_aliases: c.aliases } : {}),
  };
}

/**
 * Syncs a brand's competitors onto ONE project as benchmarks:
 *   - creates a benchmark for each region-applicable competitor whose domain is
 *     not already a benchmark (with its `brand_aliases`);
 *   - updates an existing competitor benchmark in place (PUT) when its alias set
 *     drifted from the brand (domain unchanged, aliases changed);
 *   - deletes the benchmarks of competitors removed from the brand (`removedDomains`).
 * Never updates or deletes the main-brand benchmark. After alias-bearing writes
 * it re-reads the benchmarks to capture any `rejected_brand_aliases` Semrush
 * silently dropped, so the caller can surface them.
 *
 * @param {object} transport - Semrush transport (lists/creates/updates/deletes benchmarks).
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {string} projectId - the market/project to sync competitor benchmarks on.
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   competitors - the brand's competitors to track (region-filtered by
 *   {@link collectCompetitorBenchmarks}).
 * @param {string[]} removedDomains - normalized domains removed from the brand.
 * @param {string} market - ISO-2 country code of the target project.
 * @param {object} [log] - optional logger ({ info? }).
 * @param {Set<string>} [reservedDomains=new Set()] - the brand's own normalized
 *   domains, excluded so a competitor can't be one of the brand's properties.
 * @returns {Promise<{created: number, updated: number, deleted: number,
 *   changed: boolean, rejected: {domain: string, aliases: string[]}[]}>}
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
    return {
      created: 0, updated: 0, deleted: 0, changed: false, rejected: [],
    };
  }

  const resp = await transport.listBenchmarks(workspaceId, projectId);
  const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];

  // Domain → competitor (non-main) benchmark { id, aliases }, for update/delete.
  const competitorByDomain = new Map();
  const presentDomains = new Set();
  for (const b of benchmarks) {
    const domain = normalizeBenchmarkDomain(b?.domain);
    if (domain === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    presentDomains.add(domain);
    if (b?.main_brand !== true && hasText(b?.id)) {
      competitorByDomain.set(domain, {
        id: String(b.id),
        name: hasText(b?.brand_name) ? b.brand_name : '',
        aliases: Array.isArray(b?.brand_aliases) ? b.brand_aliases : [],
      });
    }
  }

  const toCreate = desired.filter((c) => !presentDomains.has(c.domain));
  // Update an existing competitor benchmark when its display name OR its alias
  // set drifted. The benchmark is keyed by domain, so a rename that keeps the
  // same URL (e.g. "test1234" → "test12345" on test1234.de) would otherwise
  // never re-sync — leaving the upstream brand_name stale vs the brand row.
  const toUpdate = desired.filter((c) => {
    const existing = competitorByDomain.get(c.domain);
    if (!existing) {
      return false;
    }
    // Re-sync only when the upstream benchmark carries a name that differs from
    // the desired one (a genuine rename). An absent upstream name is left alone
    // rather than backfilled, so a benchmark we did not name is never touched.
    const nameDrifted = existing.name !== '' && existing.name !== c.name;
    return nameDrifted || !sameAliasSet(existing.aliases, c.aliases);
  });
  const toDelete = [...removedSet]
    .map((d) => competitorByDomain.get(d)?.id)
    .filter((id) => hasText(id));

  let created = 0;
  let updated = 0;
  let deleted = 0;
  if (toCreate.length > 0) {
    await transport.createBenchmarks(workspaceId, projectId, toCreate.map(benchmarkBody));
    created = toCreate.length;
  }
  for (const c of toUpdate) {
    const { id } = competitorByDomain.get(c.domain);
    // eslint-disable-next-line no-await-in-loop
    await transport.updateBenchmark(workspaceId, projectId, id, benchmarkBody(c));
    updated += 1;
  }
  if (toDelete.length > 0) {
    await transport.deleteBenchmarks(workspaceId, projectId, toDelete);
    deleted = toDelete.length;
  }

  // Capture aliases Semrush rejected on the benchmarks we just wrote with aliases.
  // Only re-read when an alias-bearing create or any update happened (a plain
  // create-without-aliases or a delete can't produce rejections).
  let rejected = [];
  const wroteAliases = toUpdate.length > 0 || toCreate.some((c) => c.aliases.length > 0);
  if (wroteAliases) {
    const desiredAliasDomains = new Set(
      desired.filter((c) => c.aliases.length > 0).map((c) => c.domain),
    );
    const after = await transport.listBenchmarks(workspaceId, projectId);
    const list = Array.isArray(after?.aio_benchmarks) ? after.aio_benchmarks : [];
    rejected = rejectedAliasesFrom(list, (b) => {
      const d = normalizeBenchmarkDomain(b?.domain);
      return b?.main_brand !== true && d !== null && desiredAliasDomains.has(d);
    });
  }

  if (created > 0 || updated > 0 || deleted > 0) {
    log?.info?.('competitor-benchmarks: synced project', {
      workspaceId, projectId, created, updated, deleted, rejected: rejected.length,
    });
  }
  return {
    created, updated, deleted, changed: created > 0 || updated > 0 || deleted > 0, rejected,
  };
}

/**
 * Re-syncs a brand's competitors as benchmarks across every market/project in
 * its sub-workspace (the brand-edit path): per project, region-filter + create
 * additions + update alias drift + delete removals, then republish (best-effort)
 * when anything changed. Create/update/delete errors propagate; a quota 405 on
 * republish is tolerated. `rejected` aggregates the per-market competitor aliases
 * Semrush refused, tagged with their project/market, so the caller can surface them.
 *
 * @param {object} transport - Semrush transport.
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   competitors - the brand's competitors to track as benchmarks (region-filtered per
 *   market by {@link collectCompetitorBenchmarks}).
 * @param {string[]} removedDomains - normalized competitor domains removed from the brand
 *   (their benchmarks are deleted per market).
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {object} [log]
 * @param {Array<string|{value:string}>} [brandOwnUrls=[]] - the brand's own
 *   website URLs, reserved (with every project domain) so a competitor can't be
 *   one of the brand's own properties.
 * @param {Array<object>|null} [prefetchedProjects=null] - a pre-fetched project listing
 *   to reuse (the brand-edit path lists once and shares it across the URL/competitor/alias
 *   syncs); null/undefined lists here. An explicit `[]` reuses the prefetch (no re-list).
 * @returns {Promise<{markets: number, created: number, updated: number,
 *   deleted: number, rejected: {projectId: string, market: string,
 *   domain: string|null, aliases: string[]}[]}>}
 */
export async function syncCompetitorBenchmarksAcrossMarkets(
  transport,
  competitors,
  removedDomains,
  workspaceId,
  log,
  brandOwnUrls = [],
  prefetchedProjects = null,
) {
  // Reuse a pre-fetched project listing when supplied (the brand-edit path lists
  // once and shares it across the URL/competitor/alias syncs), else list here.
  const projects = await resolveProjects(transport, workspaceId, prefetchedProjects);

  // The brand's own domains across all its markets — every project's domain (the
  // primary is one of them) plus the brand's own website URLs. A competitor whose
  // domain matches any of these is dropped from the sync (can't track yourself).
  const reservedDomains = buildReservedDomains(
    projects.map((p) => p?.domain),
    brandOwnUrls,
  );

  let markets = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const rejected = [];

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
      updated += result.updated;
      deleted += result.deleted;
      rejected.push(...result.rejected.map((r) => ({ projectId, market, ...r })));
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
    workspaceId, markets, created, updated, deleted, rejected: rejected.length,
  });
  return {
    markets, created, updated, deleted, rejected,
  };
}
