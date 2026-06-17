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

import { regionApplies, marketOf, republishBestEffort } from './brand-urls.js';

/**
 * Syncs a brand's competitors ("other brands to track") into a Semrush project's
 * CI competitor list. Semrush competitors are domain-only ({ domain, color }) —
 * the brand's competitor name/aliases/regions don't map. The CI competitor PUT
 * is a FULL destructive replace and Semrush auto-generates its own competitors,
 * so every sync read-merges: keep what's there, add our domains (region-filtered
 * to the market), and drop only the exact domains we removed from our DB — never
 * a Semrush-auto-generated one (those are never in our brand list).
 */

/**
 * Normalizes a URL or bare host to a comparable domain: lower-cased host with a
 * leading `www.` stripped and scheme/path/query/port removed. Returns null for
 * empty or unparseable input (those competitors are skipped — Semrush needs a
 * domain). A bare `example.com` (no scheme) is accepted.
 */
export function normalizeDomain(value) {
  if (!hasText(value)) {
    return null;
  }
  const raw = value.trim();
  let host;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  return hasText(host) ? host : null;
}

/**
 * The de-duplicated, normalized competitor domains that apply to `market`:
 * competitors are region-filtered (region-less ⇒ all markets, same rule as
 * social/earned URLs) and mapped to their URL's domain. Competitors with no
 * usable URL are skipped.
 *
 * @param {object[]} competitors - brand competitors ({ url, regions }).
 * @param {string} market - ISO-2 country code of the target project.
 * @returns {string[]} normalized domains (empty when none apply).
 */
export function collectCompetitorDomains(competitors, market) {
  const seen = new Set();
  return (Array.isArray(competitors) ? competitors : [])
    .filter((c) => regionApplies(c?.regions, market))
    .map((c) => normalizeDomain(c?.url))
    .filter((d) => d !== null && !seen.has(d) && seen.add(d));
}

// All normalized domains across a competitor list, ignoring region (used for
// the removal diff, which is brand-wide not per-market).
function collectAllDomains(competitors) {
  const seen = new Set();
  return (Array.isArray(competitors) ? competitors : [])
    .map((c) => normalizeDomain(c?.url))
    .filter((d) => d !== null && !seen.has(d) && seen.add(d));
}

/**
 * The normalized domains that were removed from the brand's competitor list in
 * an edit — present in `oldCompetitors` but not `newCompetitors` (region-agnostic:
 * a competitor deleted from the brand is removed everywhere). These are the only
 * domains the sync deletes from Semrush, honoring "remove only what we removed
 * from our DB" while leaving Semrush-auto-generated competitors untouched.
 */
export function removedCompetitorDomains(oldCompetitors, newCompetitors) {
  const newDomains = new Set(collectAllDomains(newCompetitors));
  const removed = new Set();
  collectAllDomains(oldCompetitors).forEach((d) => {
    if (!newDomains.has(d)) {
      removed.add(d);
    }
  });
  return [...removed];
}

/**
 * Merges our competitor domains into the project's existing CI competitor list,
 * producing the full list to PUT back:
 *   - keep every existing entry (preserving its domain + color) EXCEPT ones whose
 *     domain we just removed from our DB (`removedDomains`);
 *   - add our `ourDomains` not already present;
 *   - de-duplicate by normalized domain (first-seen wins).
 * Entries we add carry no color (Semrush assigns one); existing colors are kept.
 *
 * @returns {{domain: string, color?: string}[]} the full merged list for the PUT.
 */
export function mergeCiCompetitors(existing, ourDomains, removedDomains = []) {
  const removed = new Set(removedDomains);
  const present = new Set();
  const result = [];

  (Array.isArray(existing) ? existing : []).forEach((e) => {
    const domain = normalizeDomain(e?.domain);
    if (domain === null || removed.has(domain) || present.has(domain)) {
      return;
    }
    present.add(domain);
    const entry = { domain: e.domain };
    if (hasText(e?.color)) {
      entry.color = e.color;
    }
    result.push(entry);
  });

  (Array.isArray(ourDomains) ? ourDomains : []).forEach((domain) => {
    if (!hasText(domain) || present.has(domain)) {
      return;
    }
    present.add(domain);
    result.push({ domain });
  });

  return result;
}

// Whether the merged list differs from what's on the project (by normalized
// domain membership) — drives a skip when nothing changed (avoids a needless
// destructive PUT + republish).
function competitorSetChanged(existing, merged) {
  const existingList = Array.isArray(existing) ? existing : [];
  const before = new Set(
    existingList.map((e) => normalizeDomain(e?.domain)).filter(Boolean),
  );
  const after = new Set(merged.map((e) => normalizeDomain(e.domain)).filter(Boolean));
  if (before.size !== after.size) {
    return true;
  }
  return [...after].some((d) => !before.has(d));
}

/**
 * Syncs one project's CI competitors: read the current list, merge in our
 * domains (and drop our removed ones), and PUT the full list back when it
 * changed. A no-op (no PUT) when the merge matches what's already there. Errors
 * propagate so the caller hard-fails.
 *
 * @returns {Promise<{changed: boolean}>}
 */
export async function syncCiCompetitorsForProject(
  transport,
  workspaceId,
  projectId,
  ourDomains,
  removedDomains,
  log,
) {
  const project = await transport.getProject(workspaceId, projectId);
  const existing = project?.settings?.ci?.competitors || [];
  const merged = mergeCiCompetitors(existing, ourDomains, removedDomains);

  if (!competitorSetChanged(existing, merged)) {
    return { changed: false };
  }
  await transport.updateCiCompetitors(workspaceId, projectId, merged);
  log?.info?.('ci-competitors: synced project competitor list', {
    workspaceId, projectId, count: merged.length,
  });
  return { changed: true };
}

/**
 * Re-syncs a brand's competitors onto every market/project in its sub-workspace
 * (the brand-edit path). For each project: region-filters our competitor domains
 * to the market, merges (adding ours, dropping our removed ones), and
 * republishes (best-effort) when the list changed. Create/PUT errors propagate
 * so the edit hard-fails; a quota 405 on the republish alone is tolerated.
 *
 * @returns {Promise<{markets: number, changed: number}>}
 */
export async function syncCiCompetitorsAcrossMarkets(
  transport,
  competitors,
  removedDomains,
  workspaceId,
  log,
) {
  const listing = await transport.listProjects(workspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];

  let markets = 0;
  let changedCount = 0;

  for (const project of projects) {
    const projectId = hasText(project?.id) ? String(project.id) : null;
    const market = marketOf(project);
    if (!projectId || market === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    markets += 1;
    const ourDomains = collectCompetitorDomains(competitors, market);
    // eslint-disable-next-line no-await-in-loop
    const { changed } = await syncCiCompetitorsForProject(
      transport,
      workspaceId,
      projectId,
      ourDomains,
      removedDomains,
      log,
    );
    if (changed) {
      changedCount += 1;
      // eslint-disable-next-line no-await-in-loop
      await republishBestEffort(transport, workspaceId, projectId, log);
    }
  }

  log?.info?.('ci-competitors: re-synced across markets', {
    workspaceId, markets, changed: changedCount,
  });
  return { markets, changed: changedCount };
}
