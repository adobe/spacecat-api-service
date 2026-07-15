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

import { resolveElementModel } from '../constants.js';

/**
 * Builds the payload for the Stats-per-URL element (9af5ed83, `table`) scoped to a
 * single (project, date, model). Identical shape to the owned-urls stats payload
 * (date in BOTH simple + advanced, `CBF_model` in an `or` block, `category__<label>`
 * tag, region via top-level `project_id`). `startDate`/`endDate` are required
 * (validated in the controller).
 *
 * The domain filter is NOT expressed here: the element ignores a server-side domain
 * filter (verified live — `CBF_domain`/`cbf_domain`/`CBF_source`, eq + contains, all
 * returned the full project table unchanged), so `hostname` is applied client-side in
 * the transform. This mirrors how owned-urls filters `domain_type='Owned'` client-side.
 *
 * @param {object} params
 * @param {string} [params.model] - AI model (Semrush engine or UI platform code).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` wins.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @param {string} [params.category] - Category label → tag `category__<label>`.
 * @param {string} [params.projectId] - Semrush project id (region scope, top-level).
 */
export function buildDomainUrlsPayload({
  model, platform, startDate, endDate, category, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
  ];
  if (category) {
    advancedFilters.push({ op: 'eq', val: `category__${category}`, col: 'CBF_tags' });
  }
  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { CBF_date__start: startDate, CBF_date__end: endDate },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Extracts the registrable-domain-agnostic host of a URL: lowercased, `www.`-stripped.
 * Returns null for unparseable values (defensive — Semrush `source` is always a URL).
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `host` is `hostname` itself or a subdomain of it.
 *
 * The incoming `hostname` comes from the cited-domains element (98b91d00), which
 * reports the REGISTERED domain (eTLD+1, e.g. `openai.com`, `cambridge.org`). But the
 * Stats-per-URL element's `source` hosts are often subdomains (`help.openai.com`,
 * `dictionary.cambridge.org`). So an exact-host match would drop most (or, for
 * `cambridge.org`, ALL) of a domain's URLs. Matching `host === hostname ||
 * host.endsWith('.'+hostname)` captures the apex + every subdomain without a
 * public-suffix list, and the leading-dot guard prevents `notopenai.com` from
 * matching `openai.com`. Verified live (2026-07-10): `cambridge.org` → 46 URLs, all
 * under `dictionary.cambridge.org`; exact match would have returned 0.
 */
function hostMatches(host, hostname) {
  return host === hostname || host.endsWith(`.${hostname}`);
}

/**
 * Parses the pagination params (0-based `page`, `pageSize`) mirroring the legacy
 * parsePaginationParams (defaultPageSize 50, clamped to [1, 1000]).
 */
function parsePagination({ page, pageSize } = {}) {
  return {
    page: Math.max(0, Number.parseInt(page, 10) || 0),
    pageSize: Math.min(Math.max(1, Number.parseInt(pageSize, 10) || 50), 1000),
  };
}

/**
 * Merges per-project Stats-per-URL responses into the legacy URL Inspector
 * `domain-urls` contract (Phase 2 drilldown):
 *   { urls: [{ urlId, url, contentType, citations, promptsCited, categories,
 *              regions }], totalCount }
 *
 * Field mapping (verified against live element rows):
 *   url          ← stats.source
 *   citations    ← stats.citations                (summed across a URL's projects)
 *   promptsCited ← stats.prompts_with_citation    (summed)
 *   contentType  ← stats.domain_type
 *   regions      ← the region code(s) of each project the URL appears in, joined
 * Gaps with NO Semrush source (stubbed, see LLMO-6160 notes / cf LLMO-6086):
 *   urlId ('' — Semrush has no source_urls.id), categories ('' — no per-URL tag source).
 * `regions`/`categories` are STRINGS here (the legacy contract + the UI `DomainUrlRow`
 * type), NOT arrays like owned-urls.
 *
 * Only rows whose `source` host matches `hostname` (host-or-subdomain, see
 * {@link hostMatches}) are kept. An optional `channel` (content-type) filter is then
 * applied client-side on `contentType` (case-insensitive) — the element has no
 * server-side content-type filter, so this mirrors cited-domains + the legacy RPC's
 * `p_channel`. Semrush has no server-side pagination, so after filtering we sort by
 * citations desc and slice client-side; `totalCount` is the post-filter, pre-slice count.
 *
 * @param {Array<{region?: string, stats: object}>} projectResults
 * @param {object} params - { hostname (required), channel, page, pageSize }.
 * @returns {{ urls: Array<object>, totalCount: number }}
 */
export function transformDomainUrlsResponse(projectResults = [], params = {}) {
  const { page, pageSize } = parsePagination(params);
  const hostname = String(params.hostname ?? '').replace(/^www\./, '').toLowerCase();
  const channel = typeof params.channel === 'string' ? params.channel.trim() : '';
  const byUrl = new Map();

  for (const { region, stats } of projectResults) {
    for (const row of (stats?.blocks?.data ?? [])) {
      if (!row || row.source == null) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const host = hostOf(row.source);
      if (!host || !hostMatches(host, hostname)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      let entry = byUrl.get(row.source);
      if (!entry) {
        entry = {
          url: row.source,
          contentType: row.domain_type || '',
          citations: 0,
          promptsCited: 0,
          regions: new Set(),
        };
        byUrl.set(row.source, entry);
      }
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      entry.citations += Number(row.citations) || 0;
      entry.promptsCited += Number(row.prompts_with_citation) || 0;
      if (region) {
        entry.regions.add(region);
      }
    }
  }

  let urls = [...byUrl.values()].map((e) => ({
    urlId: '', // no Semrush source_urls.id (gap — see LLMO-6160 / cf LLMO-6086)
    url: e.url,
    contentType: e.contentType,
    citations: e.citations,
    promptsCited: e.promptsCited,
    categories: '', // no per-URL category source on the element (Semrush gap)
    // Legacy `regions` was a comma-joined string_agg with NO space — match it for
    // exact drop-in parity. Sorted for determinism (string_agg order is arbitrary).
    regions: [...e.regions].sort().join(','),
  }));

  // `channel` = content-type filter, applied client-side (element ignores it
  // server-side), mirroring cited-domains + the legacy RPC's `p_channel`.
  if (channel) {
    const wanted = channel.toLowerCase();
    urls = urls.filter((u) => u.contentType.toLowerCase() === wanted);
  }

  urls.sort((a, b) => b.citations - a.citations);

  const totalCount = urls.length;
  const offset = page * pageSize;
  return { urls: urls.slice(offset, offset + pageSize), totalCount };
}
