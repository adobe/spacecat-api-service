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
  siteIdentityFor,
  marketOf,
  republish,
} from './brand-urls.js';
import {
  dedupeAliases,
  sameAliasSetExact,
  benchmarkAliases,
  mergeBenchmarkAliases,
  rejectedAliasesFrom,
} from './aliases.js';
import { resolveProjects } from './resolve-projects.js';

/** @typedef {import('./rest-transport.js').SerenityTransport} SerenityTransport */

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
 * Builds the set of the brand's OWN site identities — every market/project domain
 * (the primary is one of them) and its own website URLs — that a competitor must
 * never collide with. Tracking your own property as a competitor would create a
 * benchmark that double-counts the brand against itself (or, for the project's
 * own domain, silently no-ops), so these are excluded from competitor sync.
 *
 * The reserved values are full identities ({@link siteIdentityFor}: host AND
 * path), not folded hosts. A brand tracked on a subpath shares its host with
 * genuinely different sites — `nba.com/kings` reserving the bare host `nba.com`
 * classified `nba.com/suns` as the brand's own property and discarded it. Only
 * the same site, spelled the same way down to the path, is the brand itself.
 *
 * A project `domain` is a bare FQDN (upstream rejects a path there), so it
 * reserves exactly that apex — a competitor at the bare apex is still the
 * project's own domain and is still dropped.
 *
 * Social / earned domains are intentionally NOT reserved: those are third-party
 * platform domains (e.g. a social network), legitimately also trackable.
 *
 * @param {Array<string>} [domains=[]] - project/market domains (and the primary).
 * @param {Array<string|{value:string}>} [urls=[]] - the brand's own website URLs.
 * @returns {Set<string>} reserved site identities.
 */
export function buildReservedIdentities(domains = [], urls = []) {
  const set = new Set();
  const add = (value) => {
    const identity = siteIdentityFor(value);
    if (identity !== null) {
      set.add(identity);
    }
  };
  for (const d of Array.isArray(domains) ? domains : []) {
    add(d);
  }
  for (const u of Array.isArray(urls) ? urls : []) {
    add(typeof u === 'string' ? u : u?.value);
  }
  return set;
}

// Whether a url IS one of the brand's own properties: its full site identity
// (host AND path) is reserved. An unparseable url is never self-referential.
function isReserved(url, reservedIdentities) {
  const identity = siteIdentityFor(url);
  return identity !== null && reservedIdentities?.has(identity) === true;
}

/**
 * Partitions competitors into the ones to keep and the self-referential ones to
 * drop (their site identity is one of the brand's `reservedIdentities`). Pure —
 * the caller persists `kept` and logs `dropped`.
 *
 * @param {Array<{url?: string}>} competitors - the submitted competitors.
 * @param {Set<string>} reservedIdentities - from {@link buildReservedIdentities}.
 * @returns {{ kept: object[], dropped: object[] }}
 */
export function dropReservedCompetitors(competitors, reservedIdentities) {
  const list = Array.isArray(competitors) ? competitors : [];
  const kept = [];
  const dropped = [];
  for (const c of list) {
    if (isReserved(c?.url, reservedIdentities)) {
      dropped.push(c);
    } else {
      kept.push(c);
    }
  }
  return { kept, dropped };
}

/**
 * The name a competitor is tracked under — its trimmed `name`, falling back to
 * its normalized domain when it carries none. Every keying decision in this
 * module goes through here, so the fallback the benchmark body sends as
 * `brand_name` and the fallback the diff matches on are always the same string.
 *
 * @returns {string} '' when the competitor has neither a name nor a usable url.
 */
function competitorNameOf(c) {
  if (hasText(c?.name)) {
    return String(c.name).trim();
  }
  const domain = normalizeBenchmarkDomain(c?.url);
  return domain === null ? '' : domain;
}

// The case-folded key a competitor and its benchmark are matched on. Upstream
// enforces `brand_name` uniqueness within a project case-insensitively, so this
// is the identity a benchmark actually has there.
function competitorKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * Builds the `{ name, key, domain, aliases }[]` competitor benchmarks to track
 * for a market, region-filtered (reuses {@link regionApplies}). The domain is
 * extracted from the competitor `url` and stays on the record — it is the
 * benchmark's `domain` payload field — but it is no longer the identity. Entries
 * without a usable url/domain are skipped, as are any whose site identity is one
 * of the brand's own `reservedIdentities`. `aliases` are the competitor's
 * alternate names, propagated to the benchmark's `brand_aliases`.
 *
 * De-duped by case-folded NAME, not by domain: a Semrush project holds several
 * benchmarks on one domain discriminated by `brand_name` (live-verified — one
 * `nba.com` project carries Lakers, Celtics, Warriors, Knicks and Spurs), and
 * upstream rejects a duplicate name within a project, never a duplicate domain.
 * De-duping on domain silently dropped every sibling but the first.
 *
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   competitors - the brand's competitors to track.
 * @param {string} market - ISO-2 country code of the target project.
 * @param {Set<string>} [reservedIdentities] - the brand's own site identities.
 * @returns {{name: string, key: string, domain: string, identity: string|null,
 *   aliases: string[]}[]}
 */
export function collectCompetitorBenchmarks(competitors, market, reservedIdentities = new Set()) {
  const list = Array.isArray(competitors) ? competitors : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!regionApplies(c?.regions, market)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const domain = normalizeBenchmarkDomain(c?.url);
    if (domain === null || isReserved(c?.url, reservedIdentities)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // Real competitors always carry a name; the domain fallback just keeps this
    // robust for one that does not.
    const name = competitorNameOf(c);
    const key = competitorKey(name);
    if (key === '' || seen.has(key)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    seen.add(key);
    out.push({
      name, key, domain, identity: siteIdentityFor(c?.url), aliases: dedupeAliases(c?.aliases),
    });
  }
  return out;
}

/**
 * The competitors present in `oldCompetitors` but not `newCompetitors`
 * (region-agnostic) — the ones to delete from upstream on a brand edit. The
 * caller reads the OLD competitors before persisting the update.
 *
 * @param {Array<{name?: string, url?: string}>} oldCompetitors - before the edit.
 * @param {Array<{name?: string, url?: string}>} newCompetitors - after the edit.
 *
 * An entry counts as removed only when NEITHER its name nor its site survives
 * into the new list. Both halves are load-bearing:
 *
 * - **Name**, because a domain diff could not see the removal of one of two
 *   same-host competitors at all — the surviving sibling kept the domain present,
 *   so the deletion was a silent no-op.
 * - **Site identity**, because a competitor that was merely RENAMED keeps its url,
 *   and reporting it as removed would delete its benchmark and create a fresh one
 *   instead of renaming in place. That loses the aliases Semrush's own resolution
 *   added to it, which only survive by being carried forward from the live list.
 *   Identity rather than host, so renaming one sibling does not shelter another.
 *
 * The `domain` is carried along so the sync can still find a benchmark created
 * before names were the key.
 *
 * @returns {{name: string, key: string, domain: string|null}[]}
 */
export function removedCompetitors(oldCompetitors, newCompetitors) {
  const newList = Array.isArray(newCompetitors) ? newCompetitors : [];
  const newKeys = new Set(
    newList.map((c) => competitorKey(competitorNameOf(c))).filter((k) => k !== ''),
  );
  const newIdentities = new Set(
    newList.map((c) => siteIdentityFor(c?.url)).filter((i) => i !== null),
  );
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(oldCompetitors) ? oldCompetitors : []) {
    const name = competitorNameOf(c);
    const key = competitorKey(name);
    const identity = siteIdentityFor(c?.url);
    if (key === '' || seen.has(key)
      || newKeys.has(key) || (identity !== null && newIdentities.has(identity))) {
      // eslint-disable-next-line no-continue
      continue;
    }
    seen.add(key);
    out.push({ name, key, domain: normalizeBenchmarkDomain(c?.url) });
  }
  return out;
}

/**
 * Matches each target competitor to the benchmark that represents it, returning
 * `key → { id, name, aliases, domain }` for the ones that resolve. A target with
 * no entry has no benchmark yet.
 *
 * Two passes, because the benchmarks in a project were not all written under the
 * same key:
 *
 * 1. **By name** — the real identity. Upstream enforces `brand_name` uniqueness
 *    within a project, so once a benchmark has been written under a competitor's
 *    name this is exact.
 * 2. **By domain, adopted** — benchmarks created before names were the key carry
 *    a `brand_name` that may match no current competitor (written before a
 *    rename, or from the surviving sibling of a set that domain de-duping
 *    collapsed). Matching those on name alone would call them absent and create a
 *    duplicate. So an unresolved target adopts an unclaimed benchmark on its host,
 *    but ONLY when that host holds exactly one of each — one unresolved target and
 *    one unclaimed benchmark. With siblings in play the pairing is a guess, and a
 *    wrong guess writes one competitor's name and aliases onto another's
 *    benchmark, which no later sync can detect or undo. A duplicate benchmark is
 *    the recoverable failure, so ambiguity is logged and left to create.
 *
 * The pass is self-limiting: once a sync writes the desired name onto an adopted
 * benchmark, pass 1 matches it from then on and pass 2 stops firing.
 *
 * The brand's OWN benchmark is never an adoption candidate. `main_brand` does not
 * identify it: {@link ensureOwnBrandBenchmark} creates one with `main_brand` unset
 * whenever Semrush has not auto-provisioned it, because the create API cannot set
 * that flag — and it carries the project domain, which is exactly the host a
 * subpath brand's competitors resolve to. Adopting it would rename the brand's own
 * benchmark after a competitor, with the brand's own URLs still hanging off it, and
 * nothing later would detect it. Benchmarks on a reserved identity are therefore
 * dropped from the domain index.
 *
 * They stay in the NAME index deliberately. A competitor at `nba.com/suns` sends
 * the bare `nba.com` as its benchmark `domain` — the reserved value — so excluding
 * those from name matching would fail to find its own benchmark and create a
 * duplicate on every sync.
 *
 * @param {Array<object>} benchmarks - `aio_benchmarks` from `listBenchmarks`.
 * @param {{key: string, name: string, domain: string|null}[]} targets - the
 *   competitors to place: the ones desired for this market plus the removed ones,
 *   whose benchmarks must still be found to be deleted.
 * @param {Set<string>} [reservedIdentities] - the brand's own site identities; a
 *   benchmark on one of them is never adopted by domain.
 * @param {object} [log]
 * @param {object} [logContext] - workspace/project ids, for the adoption logs.
 * @returns {Map<string, {id: string, name: string, aliases: string[], domain: string|null}>}
 */
export function resolveBenchmarksByCompetitor(
  benchmarks,
  targets,
  reservedIdentities,
  log,
  logContext = {},
) {
  const byName = new Map();
  const byDomain = new Map();
  for (const b of Array.isArray(benchmarks) ? benchmarks : []) {
    if (b?.main_brand === true || !hasText(b?.id)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const entry = {
      id: String(b.id),
      name: hasText(b?.brand_name) ? b.brand_name : '',
      aliases: Array.isArray(b?.brand_aliases) ? b.brand_aliases : [],
      domain: normalizeBenchmarkDomain(b?.domain),
    };
    const key = competitorKey(entry.name);
    if (key !== '') {
      if (byName.has(key)) {
        // Upstream enforces name uniqueness within a project case-insensitively, so
        // this should be unreachable. If it happens the project carries duplication
        // no sync of ours can resolve — first-seen wins and the other benchmark is
        // unreachable by name — so say so rather than picking one silently.
        log?.warn?.('competitor-benchmarks: duplicate benchmark name in project', {
          ...logContext,
          key,
          // Both spellings: the collision is case-folded, so the raw names can
          // differ and either one alone makes the pair hard to find upstream.
          matched: { id: byName.get(key).id, name: byName.get(key).name },
          ignored: { id: entry.id, name: entry.name },
        });
      } else {
        byName.set(key, entry);
      }
    }
    if (entry.domain !== null && !isReserved(b?.domain, reservedIdentities)) {
      if (!byDomain.has(entry.domain)) {
        byDomain.set(entry.domain, []);
      }
      byDomain.get(entry.domain).push(entry);
    }
  }

  const resolved = new Map();
  const claimed = new Set();
  const pending = new Map();
  for (const t of Array.isArray(targets) ? targets : []) {
    const entry = byName.get(t.key);
    if (entry) {
      resolved.set(t.key, entry);
      claimed.add(entry.id);
    } else if (t.domain !== null) {
      if (!pending.has(t.domain)) {
        pending.set(t.domain, []);
      }
      pending.get(t.domain).push(t);
    }
  }

  // Grouped by bare host because that is all a benchmark carries — its `domain` is
  // an FQDN with no path, so `nba.com/suns` and `nba.com/lakers` are indistinguishable
  // from the benchmark side. The host is therefore a hint, never a match, which is
  // exactly why adoption requires a 1:1 pairing before it acts: on any host where the
  // hint could point at more than one thing, it declines. This is one-time
  // reconciliation, not steady-state behaviour — the first sync writes the desired
  // name onto whatever it adopts, after which pass 1 matches it and this loop is a
  // no-op forever.
  for (const [domain, unresolved] of pending) {
    const candidates = (byDomain.get(domain) || []).filter((e) => !claimed.has(e.id));
    if (candidates.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (unresolved.length === 1 && candidates.length === 1) {
      resolved.set(unresolved[0].key, candidates[0]);
      claimed.add(candidates[0].id);
      log?.info?.('competitor-benchmarks: adopted domain-keyed benchmark', {
        ...logContext,
        domain,
        benchmarkId: candidates[0].id,
        benchmarkName: candidates[0].name,
        competitor: unresolved[0].name,
      });
    } else {
      log?.warn?.('competitor-benchmarks: benchmark could not be matched by name or domain', {
        ...logContext,
        domain,
        unresolvedCompetitors: unresolved.map((t) => t.name),
        candidateBenchmarks: candidates.map((e) => ({ id: e.id, name: e.name })),
      });
    }
  }
  return resolved;
}

// Builds the `{ brand_name, domain, brand_aliases }` benchmark create/update body
// from a collected competitor.
//
// `brand_aliases` is ALWAYS sent, even when empty. Omitting the field does not
// leave the stored list alone — it clears it (live-verified 2026-08-13: a PUT of
// `{brand_name, domain}` over a benchmark holding two aliases emptied it). An
// update that means to change only the name must therefore still carry the aliases
// it wants to keep.
//
// `aliases` is the already-resolved list to send: on create the preferred spellings
// for the competitor, on update those merged over the benchmark's live list.
function benchmarkBody(c, aliases) {
  return {
    brand_name: c.name,
    domain: c.domain,
    brand_aliases: aliases,
  };
}

/**
 * Syncs a brand's competitors onto ONE project as benchmarks:
 *   - creates a benchmark for each region-applicable competitor that does not
 *     already have one (with its `brand_aliases`);
 *   - updates an existing competitor benchmark in place (PUT) when its name,
 *     domain or alias set drifted from the brand;
 *   - deletes the benchmarks of competitors removed from the brand (`removed`).
 * Never updates or deletes the main-brand benchmark. After alias-bearing writes
 * it re-reads the benchmarks to capture any `rejected_brand_aliases` Semrush
 * silently dropped, so the caller can surface them.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {string} projectId - the market/project to sync competitor benchmarks on.
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   competitors - the brand's competitors to track (region-filtered by
 *   {@link collectCompetitorBenchmarks}).
 * @param {{name: string, key: string, domain: string|null}[]} removed - the
 *   competitors removed from the brand, from {@link removedCompetitors}.
 * @param {string} market - ISO-2 country code of the target project.
 * @param {object} [log] - optional logger ({ info? }).
 * @param {Set<string>} [reservedIdentities=new Set()] - the brand's own site
 *   identities, excluded so a competitor can't be one of the brand's properties.
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   [previousCompetitors=[]] - the competitors as they were BEFORE this edit. Run
 *   through the same region filter, so per competitor the aliases this edit dropped
 *   from THIS market are the only values removed from that benchmark; the rest of its
 *   live list (Semrush's enrichment) is carried forward.
 * @returns {Promise<{created: number, updated: number, deleted: number,
 *   changed: boolean, rejected: {name: string|null, domain: string|null,
 *   aliases: string[]}[]}>}
 */
export async function syncCompetitorBenchmarksForProject(
  transport,
  workspaceId,
  projectId,
  competitors,
  removed,
  market,
  log,
  reservedIdentities = new Set(),
  previousCompetitors = [],
) {
  const desired = collectCompetitorBenchmarks(competitors, market, reservedIdentities);
  const removedList = (Array.isArray(removed) ? removed : []).filter((r) => hasText(r?.key));
  // Nothing to add or remove — skip the benchmark read entirely.
  if (desired.length === 0 && removedList.length === 0) {
    return {
      created: 0, updated: 0, deleted: 0, changed: false, rejected: [],
    };
  }

  // Read the DRAFT view: the writes below act on the draft, so diffing the
  // published list would compare against a stale snapshot on any project that
  // already has pending changes.
  const resp = await transport.listBenchmarks(workspaceId, projectId, { draft: true });
  const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];

  // Competitor key → its benchmark. Resolved for the desired AND the removed in
  // one pass, so an adoption can never hand the same benchmark to both.
  const resolved = resolveBenchmarksByCompetitor(
    benchmarks,
    [...desired, ...removedList],
    reservedIdentities,
    log,
    { workspaceId, projectId, market },
  );

  const previousDesired = collectCompetitorBenchmarks(
    previousCompetitors,
    market,
    reservedIdentities,
  );
  const previousByKey = new Map(previousDesired.map((c) => [c.key, c.aliases]));
  const previousByIdentity = new Map(
    previousDesired.filter((c) => c.identity !== null).map((c) => [c.identity, c.aliases]),
  );
  // Per competitor, the aliases this edit dropped from THIS market, case-folded —
  // the form both consumers want (`mergeBenchmarkAliases` folds its `removed` list,
  // and the rejected-alias filter compares folded).
  //
  // Matched by name OR site identity, the same rule {@link removedCompetitors} uses
  // to decide a competitor is still present. By name alone a RENAME finds nothing
  // to drop, so an alias the edit removed is carried forward from the live list and
  // then never removed at all: the next edit's `previousCompetitors` no longer holds
  // it, so nothing will ever compute it as dropped again.
  const droppedByKey = new Map(desired.map((c) => {
    const before = previousByKey.get(c.key)
      ?? (c.identity !== null ? previousByIdentity.get(c.identity) : undefined)
      ?? [];
    const kept = new Set(c.aliases.map((a) => a.toLowerCase()));
    return [c.key, before.map((a) => a.toLowerCase()).filter((a) => !kept.has(a))];
  }));

  // Upstream enforces uniqueness across the union of every benchmark's name AND
  // aliases within the project, case-folded, and answers a duplicate with a 409
  // that fails the WHOLE write — for a batched create, every benchmark in it. So
  // the create batch and the update PUTs cannot each guard against the pre-write
  // listing alone: they would stay clean against what is already there while
  // colliding with each other. Both plan against this one owner map instead.
  //
  // Names are claimed before any alias is. A name is mandatory — a competitor with
  // nowhere to put it cannot be written at all — while an alias is a preference we
  // are free to drop. Claiming them together lets one competitor's optional alias
  // consume another's required name and discard that competitor outright.
  const owners = new Map();
  const claim = (key, ownerId) => {
    if (key !== '' && !owners.has(key)) {
      owners.set(key, ownerId);
    }
  };
  const availableTo = (key, ownerId) => {
    const owner = owners.get(key);
    return owner === undefined || owner === ownerId;
  };
  for (const b of benchmarks) {
    const ownerId = hasText(b?.id) ? String(b.id) : '';
    claim(competitorKey(b?.brand_name), ownerId);
    for (const a of Array.isArray(b?.brand_aliases) ? b.brand_aliases : []) {
      claim(competitorKey(a), ownerId);
    }
  }

  // Pass 1 — names. Each desired competitor either takes its existing benchmark or
  // reserves its name for a create. A name upstream already holds is unwritable, so
  // the competitor is skipped with a warning rather than sent to a certain 409.
  const ownerIdByKey = new Map();
  const updatable = [];
  const creatable = [];
  for (const c of desired) {
    const existing = resolved.get(c.key);
    const ownerId = existing ? existing.id : `pending:${c.key}`;
    if (!availableTo(c.key, ownerId)) {
      log?.warn?.('competitor-benchmarks: skipped, name already used in project', {
        workspaceId, projectId, market, competitor: c.name, domain: c.domain,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    claim(c.key, ownerId);
    ownerIdByKey.set(c.key, ownerId);
    if (existing) {
      updatable.push({ competitor: c, benchmark: existing });
    } else {
      creatable.push(c);
    }
  }

  // Pass 2 — aliases, and the drift decision they feed. A created benchmark has no
  // live list to merge over, so it takes the preferred spellings as they are: the
  // one moment we get to choose them, since upstream keeps whatever spelling an
  // alias was created with.
  const plannedAliases = new Map();
  const createdAliases = new Map();
  const toUpdate = [];
  for (const c of desired) {
    const ownerId = ownerIdByKey.get(c.key);
    if (ownerId === undefined) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const preferred = benchmarkAliases(c.name, c.aliases).filter((a) => availableTo(a, ownerId));
    for (const a of preferred) {
      claim(a, ownerId);
    }
    const existing = resolved.get(c.key);
    if (!existing) {
      createdAliases.set(c.key, preferred);
      // eslint-disable-next-line no-continue
      continue;
    }
    const planned = mergeBenchmarkAliases(existing.aliases, preferred, droppedByKey.get(c.key));
    plannedAliases.set(c.key, planned);
    // The live aliases the merge carried forward are this benchmark's too.
    for (const a of planned) {
      claim(competitorKey(a), ownerId);
    }
    // Update when the display name, the domain, OR the alias set drifted. A rename
    // that keeps the same URL would otherwise never re-sync, and a competitor that
    // MOVED to another domain is an in-place PUT on its own benchmark rather than a
    // create that orphans the old one.
    //
    // Re-sync a name only when the upstream benchmark carries one that differs from
    // the desired one (a genuine rename, or a benchmark adopted by domain). An
    // absent upstream name is left alone rather than backfilled, so a benchmark we
    // did not name is never touched.
    const nameDrifted = existing.name !== '' && existing.name !== c.name;
    const domainDrifted = existing.domain !== null && existing.domain !== c.domain;
    // Aliases compared with casing significant; the merge keeps live spellings, so
    // this is quiet in the steady state.
    if (nameDrifted || domainDrifted || !sameAliasSetExact(existing.aliases, planned)) {
      toUpdate.push({ competitor: c, benchmark: existing });
    }
  }

  const toDelete = [];
  for (const r of removedList) {
    const id = resolved.get(r.key)?.id;
    if (id && hasText(id)) {
      toDelete.push(id);
    }
  }

  let created = 0;
  let updated = 0;
  let deleted = 0;
  if (creatable.length > 0) {
    await transport.createBenchmarks(
      workspaceId,
      projectId,
      creatable.map((c) => benchmarkBody(c, createdAliases.get(c.key))),
    );
    created = creatable.length;
  }
  for (const { competitor, benchmark } of toUpdate) {
    // eslint-disable-next-line no-await-in-loop
    await transport.updateBenchmark(
      workspaceId,
      projectId,
      benchmark.id,
      benchmarkBody(competitor, plannedAliases.get(competitor.key)),
    );
    updated += 1;
  }
  if (toDelete.length > 0) {
    await transport.deleteBenchmarks(workspaceId, projectId, toDelete);
    deleted = toDelete.length;
  }

  // Report the aliases a benchmark we just wrote is not carrying, so the caller can
  // warn the operator. Only re-read when an alias-bearing write happened.
  //
  // Values THIS sync removed also land in `rejected_brand_aliases` (live-verified
  // 2026-08-13), so they are filtered out per competitor — flagging the operator's
  // own deletion back at them is noise, not a warning.
  //
  // Selected by NAME, which is what identifies the benchmark we just wrote: on a
  // host carrying siblings, a domain match would attribute one competitor's
  // rejected aliases to another.
  let rejected = [];
  const wroteAliases = toUpdate.length > 0
    || creatable.some((c) => (createdAliases.get(c.key) || []).length > 0);
  if (wroteAliases) {
    const writtenKeys = new Set([
      ...toUpdate.map((u) => u.competitor.key),
      ...creatable.filter((c) => (createdAliases.get(c.key) || []).length > 0)
        .map((c) => c.key),
    ]);
    // Draft again — the writes above are not published yet.
    const after = await transport.listBenchmarks(workspaceId, projectId, { draft: true });
    const list = Array.isArray(after?.aio_benchmarks) ? after.aio_benchmarks : [];
    rejected = rejectedAliasesFrom(
      list,
      (b) => b?.main_brand !== true && writtenKeys.has(competitorKey(b?.brand_name)),
    )
      .map((r) => {
        const dropped = new Set(droppedByKey.get(competitorKey(r.name)) || []);
        return { ...r, aliases: r.aliases.filter((a) => !dropped.has(String(a).toLowerCase())) };
      })
      .filter((r) => r.aliases.length > 0);
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
 * additions + update alias drift + delete removals, then republish when anything
 * changed. Create/update/delete/republish errors propagate. `rejected` aggregates
 * the per-market competitor aliases Semrush refused, tagged with their project/market, so the
 * caller can surface them.
 *
 * @param {SerenityTransport} transport
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   competitors - the brand's competitors to track as benchmarks (region-filtered per
 *   market by {@link collectCompetitorBenchmarks}).
 * @param {{name: string, key: string, domain: string|null}[]} removed - the competitors
 *   removed from the brand (their benchmarks are deleted per market), from
 *   {@link removedCompetitors}.
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {object} [log]
 * @param {Array<string|{value:string}>} [brandOwnUrls=[]] - the brand's own
 *   website URLs, reserved (with every project domain) so a competitor can't be
 *   one of the brand's own properties.
 * @param {Array<object>|null} [prefetchedProjects=null] - a pre-fetched project listing
 *   to reuse (the brand-edit path lists once and shares it across the URL/competitor/alias
 *   syncs); null/undefined lists here. An explicit `[]` reuses the prefetch (no re-list).
 * @param {Array<{name?: string, url?: string, regions?: string[], aliases?: string[]}>}
 *   [previousCompetitors=[]] - the competitors as they were BEFORE this edit (the same
 *   list `removed` was computed from), so each benchmark's alias write removes
 *   only what this edit dropped and carries Semrush's enrichment forward.
 * @returns {Promise<{markets: number, created: number, updated: number,
 *   deleted: number, rejected: {projectId: string, market: string,
 *   name: string|null, domain: string|null, aliases: string[]}[]}>}
 */
export async function syncCompetitorBenchmarksAcrossMarkets(
  transport,
  competitors,
  removed,
  workspaceId,
  log,
  brandOwnUrls = [],
  prefetchedProjects = null,
  previousCompetitors = [],
) {
  // Reuse a pre-fetched project listing when supplied (the brand-edit path lists
  // once and shares it across the URL/competitor/alias syncs), else list here.
  const projects = await resolveProjects(transport, workspaceId, prefetchedProjects);

  // The brand's own site identities across all its markets — every project's
  // domain (the primary is one of them) plus the brand's own website URLs. A
  // competitor whose identity matches one of these is dropped from the sync (can't
  // track yourself). Host AND path, so a sibling site on the same host survives.
  const reservedIdentities = buildReservedIdentities(
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
        removed,
        market,
        log,
        reservedIdentities,
        previousCompetitors,
      );
      created += result.created;
      updated += result.updated;
      deleted += result.deleted;
      rejected.push(...result.rejected.map((r) => ({ projectId, market, ...r })));
      if (result.changed) {
        // eslint-disable-next-line no-await-in-loop
        await republish(transport, workspaceId, projectId, log);
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
