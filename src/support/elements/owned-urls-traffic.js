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
 * Owned-URLs traffic hybrid: agentic + referral metrics come from the Adobe
 * Postgres pipeline (NOT Semrush), joined onto the Semrush-derived owned URLs by
 * (site_id, url_path). This is the ONLY non-Semrush data in owned-urls.
 *
 * Pure support helper — no controller imports (support/elements must not depend
 * on controllers). The RPC (rpc_url_inspector_owned_urls_traffic, LLMO-6086)
 * receives the full Semrush URLs and normalizes them to url_path itself, so
 * there is no JS/SQL normalization drift.
 */

/* c8 ignore start -- LLMO-6086 POC endpoint; unit tests intentionally deferred */

/**
 * Maps an RPC weekly-trend array ([{ week_start, value }]) to the legacy JS shape
 * ([{ weekStart, value }]), mirroring the legacy owned-urls handler.
 */
function mapTrend(trend) {
  if (!Array.isArray(trend)) {
    return [];
  }
  return trend.map((p) => ({
    weekStart: p?.week_start ?? null,
    value: Number(p?.value) || 0,
  }));
}

/**
 * Fetches agentic/referral traffic for the given URLs via the traffic RPC and
 * returns a Map keyed by URL. Best-effort: a missing client, missing siteId,
 * empty URL list, or RPC error all yield an empty Map so citations still render
 * (traffic degrades to 0/[]). Call with the page's URLs only — keeps `p_urls`
 * small and the join cheap.
 *
 * @param {object} postgrestService - RPC-capable client (`dataAccess.Site.postgrestService`).
 * @param {object} opts
 * @param {string} [opts.siteId] - SpaceCat site UUID (traffic tables are site-scoped).
 * @param {string} opts.startDate / opts.endDate - YYYY-MM-DD.
 * @param {string[]} opts.urls - Full Semrush URLs for the current page.
 * @param {string} [opts.region] - Region code; passed only when a single region filter is active.
 * @param {string[]} [opts.agentTypes] - Optional agentic agent-type filter.
 * @param {string} [opts.referralSource] - optel|cdn|ga4|adobe_analytics|cja
 *   (RPC defaults to optel).
 * @param {object} [opts.log] - Logger.
 * @returns {Promise<Map<string, object>>} url → { agenticHits, agenticHitsTrend,
 *   referralHits, referralHitsTrend }
 */
export async function fetchOwnedUrlsTraffic(postgrestService, {
  siteId, startDate, endDate, urls, region, agentTypes, referralSource, log,
} = {}) {
  if (typeof postgrestService?.rpc !== 'function'
    || !siteId
    || !Array.isArray(urls)
    || urls.length === 0) {
    return new Map();
  }

  const rpcParams = {
    p_site_id: siteId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_urls: urls,
  };
  // Only scope by region when a single region filter is active — a page can span
  // multiple regions, and the RPC aggregates across all of them when p_region is null.
  if (region) {
    rpcParams.p_region = region;
  }
  if (agentTypes) {
    rpcParams.p_agent_types = agentTypes;
  }
  if (referralSource) {
    rpcParams.p_referral_source = referralSource;
  }

  const { data, error } = await postgrestService.rpc(
    'rpc_url_inspector_owned_urls_traffic',
    rpcParams,
  );
  if (error) {
    // Traffic is best-effort; never fail the whole endpoint on a traffic-side error.
    log?.error?.(`owned-urls traffic RPC error: ${error.message}`);
    return new Map();
  }

  const map = new Map();
  for (const row of (data ?? [])) {
    map.set(row.url, {
      agenticHits: Number(row.agentic_hits) || 0,
      agenticHitsTrend: mapTrend(row.agentic_hits_trend),
      referralHits: Number(row.referral_hits) || 0,
      referralHitsTrend: mapTrend(row.referral_hits_trend),
    });
  }
  return map;
}

/**
 * Overlays the traffic Map onto the owned-URL rows (matched by `url`). Rows with
 * no traffic keep their 0/[] defaults from the transform.
 */
export function mergeOwnedUrlsTraffic(urls, trafficMap) {
  if (!(trafficMap instanceof Map) || trafficMap.size === 0) {
    return urls;
  }
  return urls.map((u) => {
    const t = trafficMap.get(u.url);
    return t ? { ...u, ...t } : u;
  });
}
/* c8 ignore stop */
