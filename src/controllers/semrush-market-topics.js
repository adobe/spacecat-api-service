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
 * Semrush AI-visibility Market Topics — replaces the Brand24-`topics`-sourced Market
 * Topics tab with Semrush's own `brands/topics/stats` (see `support/semrush/client.js`).
 * Fetches Lovesac's topics for the requested engine/month/country, then the same for
 * each configured competitor, and computes per-competitor shared themes (keyword
 * overlap on topic names — `findSharedThemes`, ported from the `brand24` repo's
 * "similar topics" feature) so the frontend can show which Lovesac topics have a real
 * counterpart in a competitor's own AI-visibility topics.
 *
 * `engine` is REQUIRED and NOT defaulted/merged across engines — confirmed live that
 * different engines return materially different topics and volumes for the same
 * domain/month, so the frontend re-requests per engine to let the customer filter,
 * rather than this endpoint silently picking one.
 */

import { badRequest, ok } from '@adobe/spacecat-shared-http-utils';
import { fetchSemrushTopicsStats } from '../support/semrush/client.js';
import { groupMarketThemes } from '../support/semrush/sharedThemes.js';

const ENGINES = ['chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'];
// `all` aggregates across every engine (see mergeTopicsAcrossEngines).
const VALID_ENGINE_PARAMS = [...ENGINES, 'all'];

const BRAND_NAME = 'Lovesac';
const BRAND_DOMAIN = 'lovesac.com';

// Fixed competitor set for this POC — mirrors the Brand24-based market-topics controller's
// own DEFAULT_COMPETITOR_PROJECT_NAMES, just addressed by domain instead of Brand24 project name.
const COMPETITOR_DOMAINS = [
  { domain: 'ikea.com', name: 'Ikea' },
  { domain: 'westelm.com', name: 'West Elm' },
  { domain: 'potterybarn.com', name: 'Pottery Barn' },
];

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
// How many months of history to build the per-topic volume trend from (this month + 2 prior).
const TREND_MONTHS = 3;

/** `2026-07`, n=1 → `2026-06`. */
function monthMinus(month, n) {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, (mon - 1) - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fold the same topic seen under multiple engines into one row, keyed on the stable
 * `topic_id`. A topic's numeric stats differ per engine (volume especially — confirmed
 * live), so `all` takes the PEAK (max) of each field across engines — "best demand /
 * reach this topic reached on any AI surface" — rather than summing (which would double-
 * count the same topic across engines).
 */
function mergeTopicsAcrossEngines(topicLists) {
  const byId = new Map();
  for (const topics of topicLists) {
    for (const topic of topics) {
      const existing = byId.get(topic.topic_id);
      if (!existing) {
        byId.set(topic.topic_id, { ...topic });
      } else {
        existing.topic_volume = Math.max(existing.topic_volume ?? 0, topic.topic_volume ?? 0);
        existing.responses = Math.max(existing.responses ?? 0, topic.responses ?? 0);
        existing.mentions = Math.max(existing.mentions ?? 0, topic.mentions ?? 0);
        existing.cited_pages = Math.max(existing.cited_pages ?? 0, topic.cited_pages ?? 0);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (b.topic_volume ?? 0) - (a.topic_volume ?? 0));
}

function SemrushMarketTopicsController(context, log, env) {
  const getMarketTopics = async (reqContext) => {
    const params = new URL(reqContext.request.url).searchParams;

    const engine = params.get('engine');
    if (!engine || !VALID_ENGINE_PARAMS.includes(engine)) {
      return badRequest(`engine is required and must be one of: ${VALID_ENGINE_PARAMS.join(', ')}`);
    }

    const month = params.get('month');
    if (!month || !MONTH_PATTERN.test(month)) {
      return badRequest('month is required, format YYYY-MM');
    }

    const country = params.get('country') || 'us';
    const enginesToFetch = engine === 'all' ? ENGINES : [engine];
    // Descending months [primary, prior, prior-1]; reversed to ascending for the trend series.
    const trendMonths = Array.from({ length: TREND_MONTHS }, (_, i) => monthMinus(month, i));

    // Fetch every requested engine for one domain+month (in parallel) and merge. Returns
    // `{ ok, topics } | { ok:false, message }`: ok when at least one engine returned data,
    // so `all` degrades over a single engine's 404 instead of failing.
    const fetchDomainMonth = async (domain, m) => {
      const results = await Promise.all(
        enginesToFetch.map((e) => fetchSemrushTopicsStats({
          domain, country, month: m, engine: e,
        }, env, log)),
      );
      const okResults = results.filter((r) => r.ok);
      if (okResults.length === 0) {
        return { ok: false, message: results[0]?.message ?? 'Semrush request failed' };
      }
      return { ok: true, topics: mergeTopicsAcrossEngines(okResults.map((r) => r.topics)) };
    };

    // For one domain: fetch all trend months in parallel. Returns the primary month's result
    // plus a `month -> (topic_id -> topic)` lookup used to build each topic's volume trend.
    const fetchDomainTrend = async (domain) => {
      const monthResults = await Promise.all(trendMonths.map((m) => fetchDomainMonth(domain, m)));
      const byMonth = new Map();
      trendMonths.forEach((m, i) => {
        const result = monthResults[i];
        byMonth.set(m, result.ok ? new Map(result.topics.map((t) => [t.topic_id, t])) : new Map());
      });
      // Index 0 is the primary (requested) month.
      return { primary: monthResults[0], byMonth };
    };

    const brandTrend = await fetchDomainTrend(BRAND_DOMAIN);
    if (!brandTrend.primary.ok) {
      return badRequest(`Semrush request failed for ${BRAND_DOMAIN}: ${brandTrend.primary.message}`);
    }
    const brandTopics = brandTrend.primary.topics;

    // brand/competitor display name -> its month->topics lookup, for trend enrichment below.
    const monthlyByName = new Map([[BRAND_NAME, brandTrend.byMonth]]);

    const competitors = [];
    for (const competitor of COMPETITOR_DOMAINS) {
      // Sequential across domains (parallel within a domain) to stay well under rate limits.
      // eslint-disable-next-line no-await-in-loop
      const trend = await fetchDomainTrend(competitor.domain);
      monthlyByName.set(competitor.name, trend.byMonth);
      // Degrade per-competitor rather than fail the whole request.
      if (!trend.primary.ok) {
        log.warn(`[semrush-market-topics] skipping ${competitor.domain}: ${trend.primary.message}`);
        competitors.push({
          domain: competitor.domain, name: competitor.name, topics: [], unavailable: true,
        });
      } else {
        competitors.push({
          domain: competitor.domain,
          name: competitor.name,
          topics: trend.primary.topics,
          unavailable: false,
        });
      }
    }

    // Keyword-grouped themes across the brand + every available competitor (each theme carries
    // one representative topic per participating brand) — the bubble map + expandable table are
    // both keyed on these themes, not individual topics.
    const themes = groupMarketThemes(
      { name: BRAND_NAME, topics: brandTopics },
      competitors.filter((c) => !c.unavailable).map((c) => ({ name: c.name, topics: c.topics })),
    );

    // Enrich each member with its topic's volume across the trend months (ascending), looked up
    // by stable topic_id per brand. `volume` is null for a month where the topic dropped out of
    // that domain's returned set (unknown, not zero) so the UI can gap the line.
    const ascendingMonths = [...trendMonths].reverse();
    for (const theme of themes) {
      for (const member of theme.members) {
        const byMonth = monthlyByName.get(member.brand);
        member.trend = ascendingMonths.map((m) => {
          const topic = byMonth?.get(m)?.get(member.topic.topic_id);
          return {
            month: m,
            volume: topic ? (topic.topic_volume ?? null) : null,
            mentions: topic ? (topic.mentions ?? null) : null,
          };
        });
      }
    }

    return ok({
      engine,
      month,
      country,
      trendMonths: ascendingMonths,
      brand: { domain: BRAND_DOMAIN, name: BRAND_NAME, topics: brandTopics },
      competitors,
      themes,
    });
  };

  return { getMarketTopics };
}

export default SemrushMarketTopicsController;
