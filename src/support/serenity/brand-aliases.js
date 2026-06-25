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
 * A brand's aliases (the extra names it is known by) propagated to its Semrush
 * projects. Each market/project carries them in two upstream surfaces, both kept
 * in lock-step here:
 *   - the project's `settings.ai.brand_names` (display name + aliases — classifies
 *     branded prompts), updated via PATCH project;
 *   - the project's own-brand benchmark `brand_aliases`, updated via PUT benchmark.
 *
 * Unlike brand URLs/competitors (region-less or region-listed third parties), an
 * alias carries `regions` and is clamped to the markets it lists: an alias only
 * lands on a project whose market it applies to (region-less / 'ww' = all). A
 * region that matches no existing project is therefore a no-op.
 */

/**
 * Region-filters aliases to the name strings applicable to `market` (reuses
 * {@link regionApplies}; region-less / 'ww' apply everywhere), trimmed +
 * de-duplicated. Used for both the edit re-sync (per project) and the create path
 * (per new market). Tolerates both the `{ name, regions }` object shape (the
 * persisted/V2 form) and a bare alias string (treated as region-less), so the
 * create path can pass either.
 *
 * @param {Array<string|{name: string, regions?: string[]}>} aliases
 * @param {string} market - ISO-2 country code of the target project.
 * @returns {string[]}
 */
export function collectAliasNames(aliases, market) {
  const list = Array.isArray(aliases) ? aliases : [];
  return dedupeAliases(
    list
      .filter((a) => regionApplies(typeof a === 'string' ? [] : a?.regions, market))
      .map((a) => (typeof a === 'string' ? a : a?.name)),
  );
}

/**
 * Re-syncs a brand's aliases onto every market/project in its sub-workspace (the
 * brand-edit path). For each project: region-filter the aliases for that market,
 * then — when drifted — PATCH the project's `brand_names` (display name + aliases)
 * and PUT its own-brand benchmark's `brand_aliases`, republishing (best-effort)
 * when anything changed. PATCH/PUT errors propagate so the edit hard-fails (an
 * already-live brand must not silently diverge). `rejected` aggregates the aliases
 * Semrush refused per market, so the caller can surface them.
 *
 * @param {object} transport - Semrush transport.
 * @param {Array<{name: string, regions?: string[]}>} aliases - the brand's aliases.
 * @param {string} displayName - the brand's display name (project `brand_name_display`
 *   + first `brand_names` entry).
 * @param {string} workspaceId - the brand's sub-workspace id.
 * @param {object} [log]
 * @param {Array<object>|null} [prefetchedProjects=null] - a pre-fetched project listing
 *   to reuse (the brand-edit path lists once and shares it across the URL/competitor/alias
 *   syncs); null/undefined lists here. An explicit `[]` reuses the prefetch (no re-list).
 * @returns {Promise<{markets: number, projectsUpdated: number,
 *   benchmarksUpdated: number, rejected: {projectId: string, market: string,
 *   domain: string|null, aliases: string[]}[]}>}
 */
export async function syncBrandAliasesAcrossMarkets(
  transport,
  aliases,
  displayName,
  workspaceId,
  log,
  prefetchedProjects = null,
) {
  // Reuse a pre-fetched project listing when supplied (the brand-edit path lists
  // once and shares it across the URL/competitor/alias syncs), else list here.
  const projects = await resolveProjects(transport, workspaceId, prefetchedProjects);

  let markets = 0;
  let projectsUpdated = 0;
  let benchmarksUpdated = 0;
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
      const desiredAliases = collectAliasNames(aliases, market);
      const ai = project?.settings?.ai || {};
      let display = null;
      if (hasText(displayName)) {
        display = displayName;
      } else if (hasText(ai.brand_name_display)) {
        display = ai.brand_name_display;
      }
      // Project brand_names = display name first, then the region-applicable
      // aliases (de-duped case-insensitively; display name wins its slot).
      const desiredBrandNames = dedupeAliases([
        ...(hasText(display) ? [display] : []),
        ...desiredAliases,
      ]);

      let changed = false;

      // 1) Project brand_names (PATCH) — only when drifted from the live set.
      const currentBrandNames = Array.isArray(ai.brand_names) ? ai.brand_names : [];
      if (!sameAliasSet(currentBrandNames, desiredBrandNames)) {
        // eslint-disable-next-line no-await-in-loop
        await transport.updateProject(workspaceId, projectId, {
          ...(hasText(display) ? { brand_name_display: display } : {}),
          brand_names: desiredBrandNames,
        });
        projectsUpdated += 1;
        changed = true;
      }

      // 2) Own-brand benchmark brand_aliases (PUT) — only when drifted.
      // eslint-disable-next-line no-await-in-loop
      const resp = await transport.listBenchmarks(workspaceId, projectId);
      const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];
      const ownDomain = normalizeBenchmarkDomain(project?.domain);
      const own = benchmarks.find((b) => b?.main_brand === true && hasText(b?.id))
        || benchmarks.find((b) => hasText(b?.id) && ownDomain !== null
          && normalizeBenchmarkDomain(b?.domain) === ownDomain);
      if (own) {
        const currentAliases = Array.isArray(own.brand_aliases) ? own.brand_aliases : [];
        if (!sameAliasSet(currentAliases, desiredAliases)) {
          // eslint-disable-next-line no-await-in-loop
          await transport.updateBenchmark(workspaceId, projectId, String(own.id), {
            // Keep brand_name deterministic: own → display → project domain → ''
            // (never undefined, which would make the PUT body non-deterministic).
            brand_name: hasText(own.brand_name)
              ? own.brand_name
              : (display || project?.domain || ''),
            domain: own.domain ?? project?.domain,
            brand_aliases: desiredAliases,
          });
          benchmarksUpdated += 1;
          changed = true;

          // Capture aliases Semrush rejected on the own-brand benchmark.
          if (desiredAliases.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            const after = await transport.listBenchmarks(workspaceId, projectId);
            const list = Array.isArray(after?.aio_benchmarks) ? after.aio_benchmarks : [];
            rejected.push(
              ...rejectedAliasesFrom(list, (b) => String(b?.id) === String(own.id))
                .map((r) => ({ projectId, market, ...r })),
            );
          }
        }
      }

      if (changed) {
        // eslint-disable-next-line no-await-in-loop
        await republishBestEffort(transport, workspaceId, projectId, log);
      }
    } catch (e) {
      // Name WHICH market split so the brand-edit hard-fail (brands.js) is
      // diagnosable per market (status only — the upstream text carries the URL).
      log?.error?.('brand-aliases: market sync failed', {
        workspaceId, projectId, market, status: e?.status,
      });
      throw e;
    }
  }

  log?.info?.('brand-aliases: re-synced across markets', {
    workspaceId, markets, projectsUpdated, benchmarksUpdated, rejected: rejected.length,
  });
  return {
    markets, projectsUpdated, benchmarksUpdated, rejected,
  };
}
