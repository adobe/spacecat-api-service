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
 * Brand24 Market Topics (POC — Market Topics tab, project-elmo-ui). Same contract shape as
 * `semrush-market-topics.js` (keyword-grouped `themes` + a 3-month `trend` per member) so the
 * frontend's Market Topics table can switch between the two data sources with the same
 * rendering code — see that controller's own doc comment for the shared design.
 *
 * Brand24 has no cross-project comparison, no theme/category concept, and no month-granular
 * stats endpoint of its own (`topics` takes an arbitrary `date_from`/`date_to`, max 31 days —
 * see `support/brand24/endpoints.js`), so this fetches each brand/competitor project's
 * `topics` three times (this month + 2 prior, each as a full calendar-month `date_from`/
 * `date_to` window) and reuses the SAME keyword-overlap grouping Semrush's controller uses
 * (`groupMarketThemes`, `support/sharedThemes.js`) after mapping Brand24's topic fields
 * (`topic_name`, `reach`) onto that function's generic shape (`topic`, `topic_volume`).
 *
 * "Real sources" per the ask: Brand24's `topics` schema has no per-topic mention list/URLs at
 * all (confirmed against the OpenAPI spec — see `support/brand24/endpoints.js`'s own comment
 * on `topics` and `trending-links`), so a per-topic source list isn't derivable. The closest
 * real, non-fabricated substitute the API offers is `trending-links` — real per-mention URLs
 * ranked by mention count, for the whole project (not the individual topic). Each brand/
 * competitor in the response carries its own `sources` (that project's top trending links for
 * the primary month), honestly scoped as project-wide rather than claimed as topic-specific.
 */

import {
  badRequest, ok, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { callBrand24Endpoint } from '../support/brand24/client.js';
import { groupMarketThemes } from '../support/sharedThemes.js';
import { parsePositiveInt } from '../support/brand24/validation.js';

/**
 * This account's real competitor projects for the Lovesac POC — confirmed live via
 * `projects-list`, not guessed. Overridable per-request via `?competitor_project_names=`.
 * Same default set `semrush-market-topics.js` compares against (Ikea/West Elm/Pottery Barn),
 * just addressed by Brand24 project name instead of domain.
 */
const DEFAULT_COMPETITOR_PROJECT_NAMES = ['Ikea', 'West Elm', 'Pottery Barn'];

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
// How many months of history to build the per-topic trend from (this month + 2 prior) — same
// window semrush-market-topics.js uses, so the two sources' trend charts cover the same span.
const TREND_MONTHS = 3;
// Real trending links (see the file header) shown per brand/competitor — kept small; this is
// supporting context next to the theme table, not its own paginated list.
const MAX_SOURCES_PER_PROJECT = 5;

/** `2026-07` → `2026-06`. */
function monthMinus(month, n) {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, (mon - 1) - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * `2026-07` → `{ dateFrom: '2026-07-01', dateTo: '2026-07-31' }` — a full calendar-month
 * window, capped to today when the month is still in progress (Brand24 rejects a `date_to`
 * in the future).
 */
function monthDateRange(month) {
  const [year, mon] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, mon - 1, 1));
  const lastDayOfMonth = new Date(Date.UTC(year, mon, 0));
  const todayIso = new Date().toISOString().slice(0, 10);
  const toIso = (d) => d.toISOString().slice(0, 10);
  const lastDay = toIso(lastDayOfMonth) > todayIso ? todayIso : toIso(lastDayOfMonth);
  return { dateFrom: toIso(firstDay), dateTo: lastDay };
}

/**
 * Maps a Brand24 topic onto `groupMarketThemes`' generic shape (`topic`/`topic_volume`) —
 * `reach` stands in for Semrush's demand-side `topic_volume` since Brand24 has no
 * search-volume concept of its own.
 */
function toThemeTopic(topic) {
  return {
    topic_id: topic.topic_id,
    topic: topic.topic_name,
    topic_volume: topic.reach ?? 0,
    mentions: topic.mentions ?? 0,
  };
}

function Brand24MarketTopicsController(context, log, env) {
  const getMarketTopics = async (reqContext) => {
    const params = new URL(reqContext.request.url).searchParams;

    const month = params.get('month');
    if (!month || !MONTH_PATTERN.test(month)) {
      return badRequest('month is required, format YYYY-MM');
    }

    const brandProjectId = parsePositiveInt(params.get('project_id'));
    if (!brandProjectId) {
      return badRequest('Missing or invalid project_id');
    }

    const competitorNamesParam = params.get('competitor_project_names');
    const competitorProjectNames = competitorNamesParam
      ? competitorNamesParam.split(',').map((name) => name.trim()).filter(Boolean)
      : DEFAULT_COMPETITOR_PROJECT_NAMES;

    let projects;
    try {
      const projectsList = await callBrand24Endpoint({ endpointKey: 'projects-list', env });
      projects = projectsList.projects_list ?? projectsList;
    } catch (error) {
      log.error('[brand24-market-topics] failed to resolve projects list', error);
      return internalServerError('Failed to reach Brand24');
    }

    const brandProjectName = projects[String(brandProjectId)];
    if (!brandProjectName) {
      return badRequest(`No Brand24 project found for project_id "${brandProjectId}"`);
    }

    const competitorProjects = competitorProjectNames
      .map((wantedName) => {
        const match = Object.entries(projects)
          .find(([, projectName]) => projectName.toLowerCase() === wantedName.toLowerCase());
        return match ? { projectId: match[0], projectName: match[1] } : null;
      })
      .filter((project) => project !== null);

    // Descending months [primary, prior, prior-1]; reversed to ascending for the trend series.
    const trendMonths = Array.from({ length: TREND_MONTHS }, (_, i) => monthMinus(month, i));

    const fetchTopics = async (projectId, forMonth) => {
      const { dateFrom, dateTo } = monthDateRange(forMonth);
      const response = await callBrand24Endpoint({
        endpointKey: 'topics',
        pathValues: { project_id: projectId },
        query: { date_from: dateFrom, date_to: dateTo },
        env,
      });
      return response?.topics ?? [];
    };

    const fetchSources = async (projectId) => {
      const { dateFrom, dateTo } = monthDateRange(month);
      try {
        const response = await callBrand24Endpoint({
          endpointKey: 'trending-links',
          pathValues: { project_id: projectId },
          query: { date_from: dateFrom, date_to: dateTo },
          env,
        });
        return (response?.trending_links ?? [])
          .slice(0, MAX_SOURCES_PER_PROJECT)
          .map((link) => ({ url: link.url, mentionsCount: link.mentions_count ?? 0 }));
      } catch (error) {
        // Real sources are supporting context, not core to the theme table — degrade quietly.
        log.warn(
          `[brand24-market-topics] failed to fetch trending-links for project ${projectId}`,
          error,
        );
        return [];
      }
    };

    // All trend months for one project, in parallel; returns `{ primaryTopics, byMonth }` where
    // `byMonth` is `month -> (topic_id -> topic)` for trend enrichment below.
    const fetchProjectTrend = async (projectId) => {
      const monthTopics = await Promise.all(trendMonths.map((m) => fetchTopics(projectId, m)));
      const byMonth = new Map();
      trendMonths.forEach((m, i) => {
        byMonth.set(m, new Map(monthTopics[i].map((t) => [t.topic_id, t])));
      });
      return { primaryTopics: monthTopics[0], byMonth };
    };

    let brandTrend;
    let brandSources;
    try {
      [brandTrend, brandSources] = await Promise.all([
        fetchProjectTrend(brandProjectId),
        fetchSources(brandProjectId),
      ]);
    } catch (error) {
      log.error('[brand24-market-topics] failed to fetch topics for brand project', error);
      return internalServerError('Failed to fetch topics from Brand24');
    }
    const brandTopics = brandTrend.primaryTopics;

    // Project name -> its month->topics lookup, for trend enrichment below.
    const monthlyByName = new Map([[brandProjectName, brandTrend.byMonth]]);

    const competitors = [];
    for (const competitor of competitorProjects) {
      // Sequential across projects (parallel within a project) to stay well under rate limits —
      // same pattern semrush-market-topics.js uses across its competitor domains.
      // eslint-disable-next-line no-await-in-loop
      const [trend, sources] = await Promise.all([
        fetchProjectTrend(competitor.projectId).catch((error) => {
          log.warn(`[brand24-market-topics] skipping ${competitor.projectName}: ${error.message}`);
          return null;
        }),
        // eslint-disable-next-line no-await-in-loop
        fetchSources(competitor.projectId),
      ]);
      monthlyByName.set(competitor.projectName, trend?.byMonth ?? new Map());
      competitors.push({
        project_id: competitor.projectId,
        name: competitor.projectName,
        topics: trend?.primaryTopics ?? [],
        sources,
        unavailable: trend === null,
      });
    }

    // Keyword-grouped themes across the brand + every available competitor — same function
    // (and same output shape) semrush-market-topics.js uses.
    const themes = groupMarketThemes(
      { name: brandProjectName, topics: brandTopics.map(toThemeTopic) },
      competitors
        .filter((c) => !c.unavailable)
        .map((c) => ({ name: c.name, topics: c.topics.map(toThemeTopic) })),
    );

    // Enrich each member with its topic's reach/mentions across the trend months (ascending),
    // looked up by stable topic_id per project. `volume` (reach) is `null` for a month where the
    // topic dropped out of that project's returned set (unknown, not zero) so the UI can gap the
    // line — same convention semrush-market-topics.js uses.
    const ascendingMonths = [...trendMonths].reverse();
    for (const theme of themes) {
      for (const member of theme.members) {
        const byMonth = monthlyByName.get(member.brand);
        member.trend = ascendingMonths.map((m) => {
          const topic = byMonth?.get(m)?.get(member.topic.topic_id);
          return {
            month: m,
            volume: topic ? (topic.reach ?? null) : null,
            mentions: topic ? (topic.mentions ?? null) : null,
          };
        });
      }
    }

    return ok({
      month,
      trendMonths: ascendingMonths,
      brand: {
        project_id: String(brandProjectId),
        name: brandProjectName,
        topics: brandTopics,
        sources: brandSources,
      },
      competitors: competitors.map((c) => ({
        competitor_project_id: c.project_id,
        competitor_project_name: c.name,
        topics: c.topics,
        sources: c.sources,
        unavailable: c.unavailable,
      })),
      themes,
    });
  };

  return { getMarketTopics };
}

export default Brand24MarketTopicsController;
