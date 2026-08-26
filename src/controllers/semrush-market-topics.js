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
import { findSharedThemes } from '../support/semrush/sharedThemes.js';

const VALID_ENGINES = ['chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview'];

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

function SemrushMarketTopicsController(context, log, env) {
  const getMarketTopics = async (reqContext) => {
    const params = new URL(reqContext.request.url).searchParams;

    const engine = params.get('engine');
    if (!engine || !VALID_ENGINES.includes(engine)) {
      return badRequest(`engine is required and must be one of: ${VALID_ENGINES.join(', ')}`);
    }

    const month = params.get('month');
    if (!month || !MONTH_PATTERN.test(month)) {
      return badRequest('month is required, format YYYY-MM');
    }

    const country = params.get('country') || 'us';

    const brandResult = await fetchSemrushTopicsStats({
      domain: BRAND_DOMAIN, country, month, engine,
    }, env, log);
    if (!brandResult.ok) {
      return badRequest(`Semrush request failed for ${BRAND_DOMAIN}: ${brandResult.message}`);
    }
    const brandTopics = brandResult.topics;

    const competitors = [];
    for (const competitor of COMPETITOR_DOMAINS) {
      // Sequential; only 4 calls total, well under Semrush's rate limits.
      // eslint-disable-next-line no-await-in-loop
      const competitorResult = await fetchSemrushTopicsStats(
        {
          domain: competitor.domain, country, month, engine,
        },
        env,
        log,
      );
      // Degrade per-competitor rather than fail the whole request — one competitor's
      // Semrush call failing shouldn't hide the brand's own topics or the other competitors.
      if (!competitorResult.ok) {
        log.warn(`[semrush-market-topics] skipping ${competitor.domain}: ${competitorResult.message}`);
        competitors.push({
          domain: competitor.domain,
          name: competitor.name,
          topics: [],
          sharedThemes: [],
          unavailable: true,
        });
      } else {
        const sharedThemes = findSharedThemes([
          { brand: BRAND_NAME, topics: brandTopics },
          { brand: competitor.name, topics: competitorResult.topics },
        ]);
        competitors.push({
          domain: competitor.domain,
          name: competitor.name,
          topics: competitorResult.topics,
          sharedThemes,
          unavailable: false,
        });
      }
    }

    return ok({
      engine,
      month,
      country,
      brand: { domain: BRAND_DOMAIN, name: BRAND_NAME, topics: brandTopics },
      competitors,
    });
  };

  return { getMarketTopics };
}

export default SemrushMarketTopicsController;
