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

/**
 * Aggregates per-project Stats-per-URL (9af5ed83) responses into the URL
 * Inspector stats KPIs — `uniqueUrls`, `totalCitations`, `totalPromptsCited`.
 * Same per-URL dedup-across-regions shape as {@link transformOwnedUrlsResponse}
 * (owned-urls.js) but WITHOUT the URL_TRENDS merge — the stats endpoint has no
 * need for per-URL weekly trend rows, only the aggregate counts, so it fetches
 * only Stats-per-URL (half the upstream calls of `getOwnedUrls`).
 *
 * **Known gap (totalPromptsCited): approximation, not a true distinct count.**
 * The element only exposes `prompts_with_citation`, a PER-URL count of prompts
 * citing that URL — not the prompt IDs themselves. Summing it across owned URLs
 * (as done here) double-counts any prompt that cites more than one owned URL, so
 * this is an upper bound on the true distinct-prompt count, not an exact match
 * for the Aurora/Postgres `rpc_url_inspector_total_prompts_cited` semantics (see
 * `docs/llmo-brandalf-apis/url-inspector-stats-api.md`). No Semrush element
 * currently exposes a distinct per-brand prompts-cited count.
 *
 * @param {Array<{stats: object}>} projectResults - One entry per queried project
 *   (region), each `stats` the raw Stats-per-URL response for that project.
 * @returns {{uniqueUrls: number, totalCitations: number, totalPromptsCited: number}}
 */
export function aggregateUrlInspectorStats(projectResults = []) {
  const byUrl = new Map();

  for (const { stats } of projectResults) {
    for (const row of (stats?.blocks?.data ?? [])) {
      if (!row || row.source == null) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // Owned filter is client-side: the element ignores a server-side
      // content-type filter (verified on cited-domains/owned-urls).
      if (String(row.domain_type ?? '').toLowerCase() !== 'owned') {
        // eslint-disable-next-line no-continue
        continue;
      }
      const entry = byUrl.get(row.source) ?? { citations: 0, promptsCited: 0 };
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      entry.citations += Number(row.citations) || 0;
      entry.promptsCited += Number(row.prompts_with_citation) || 0;
      byUrl.set(row.source, entry);
    }
  }

  let totalCitations = 0;
  let totalPromptsCited = 0;
  for (const entry of byUrl.values()) {
    totalCitations += entry.citations;
    totalPromptsCited += entry.promptsCited;
  }

  return { uniqueUrls: byUrl.size, totalCitations, totalPromptsCited };
}
