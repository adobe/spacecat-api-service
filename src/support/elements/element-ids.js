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
 * Semrush Elements API element UUIDs.
 * These are Semrush-assigned constants that never change regardless of workspace or org.
 * Reference: https://wiki.corp.adobe.com/spaces/AEMSites/pages/3928196548/
 */
export const ELEMENT_IDS = Object.freeze({
  // Filter Dimensions
  BRANDS: 'b178ce4e-6471-4430-9a32-8228ce72b2e6',
  MARKETS: '478968a7-8851-4daf-83f7-2e8fb6185ddc',
  TOPICS: 'ba3b19c1-22d4-460a-8dc3-1ff05c360852',
  // Superseded by a new element with the same semantics but a shape aligned to
  // Mentions/Visibility/Citations (CBF_ws_brand + CBF_model + optional
  // CBF_project OR-list, all wrapped in their own `or` blocks) — see
  // brand-presence-stats-plan.md §2. Old value (row 4, filter-dimensions
  // "Total Executions", top-level `project_id` param): a4defa1a-02f7-4443-b6ed-f2ca22b23402.
  TOTAL_EXECUTIONS: '601590e0-a4a1-462a-96a7-5ddae8993140',
  WEEKS: 'afa7458b-d34f-43d9-8cc5-e8794753551c',

  // Aggregated Stats
  // URL Inspector — Cited Domains ("Stats per Domain"). `table` envelope. Honors: date +
  // `CBF_model` + `CBF_tags` (category) filters, and a top-level `project_id` (region/market).
  // Brand scoping is via the request's sub-workspace, not a filter (`CBF_ws_brand` is a no-op).
  CITED_DOMAINS: '98b91d00-9531-4120-b3b5-17cc27489fce',

  // URL Inspector — Owned URLs ("Your cited URLs" table). Two elements, both
  // scoped by a top-level `project_id` (region/market) + date + `CBF_model`;
  // neither honors a server-side content-type filter, so `domain_type='Owned'`
  // is applied client-side (verified). Brand scoping is via the sub-workspace.
  //  - STATS_PER_URL (`table`): one row per cited URL —
  //    { source(=url), citations, prompts_with_citation, domain_type, avg_position,
  //      project_id, url_cbf }. Shared with domain-urls.
  //  - URL_TRENDS (`line`): weekly per-URL trend — one row per (url, week):
  //    { legend(=url), project_id, x(=ISO week), y__mentions, y__positions }.
  //    Verified: returns ALL URLs in ONE call when scoped by project only (no
  //    per-URL filter needed — the wiki's "one call per URL" claim is wrong).
  STATS_PER_URL: '9af5ed83-049b-493a-85d7-99c7d4deddba',
  URL_TRENDS: 'afb2e5d3-3955-4e0d-aeb1-7e28cdecd9f9',

  MENTIONS: 'e1a6811b-d0c9-4d6f-8a29-290a32db863f',
  VISIBILITY: '2724878e-e0e9-4217-ad21-d6bcb7887a09',
  CITATIONS_KPI: '588054fe-b987-40f6-9360-b5673738bdfa',
  // Shared UUID: powers rows 9 (Aggregated Trends) and 11 (Market Tracking Trends).
  // Service methods differentiate by payload.
  TRENDS_MV: 'b5281393-ee98-4c38-9ed5-3437b0c450c3',
  // Shared UUID: powers both rows 10 and 12 (Citation Trends).
  TRENDS_CITATIONS: 'b81af644-a8db-462b-a001-ecc1eedc0552',
  // Shared UUID: powers rows 13 (daily) and 14 (weekly) Sentiment.
  SENTIMENT: 'f4153af8-6ce9-4058-8872-8a3cf11b9907',

  // Sentiment Movers
  SENTIMENT_MOVERS: 'ba62a018-03bc-40d8-8602-be24975dd4f0',

  // Competitor Summary
  COMPETITOR_SUMMARY: '6b0dc2ca-7c06-4c8d-b169-c49a2894eac8',

  // Share of Voice
  SOV_PER_TOPIC: 'e4d7dc35-856b-4a69-8a32-2cfc7d2ef2b0',
  SOV_BRAND_TOPIC: '03e0dedd-ea2f-4e19-a0fa-d35cd9e3ee9f',

  // Topics
  TOPIC_SENTIMENTS: '324c9c6a-2f30-426c-9bce-d692b5a5e52b',
  TOPIC_MV_PROMPTS: '0564b061-0985-4d1e-a3d9-0fc6f37b7ed9',
  // Shared UUID: powers rows 21 (Citations+Source Count), 23 (AI Answers), 30 (Executions).
  CITATIONS_SOURCES: '141adc88-830c-4801-a67d-f8a86d0a21f7',

  // Prompts (filtered list + count). Returns a `table` of prompts — one row per
  // prompt with `{ prompt, prompt_topic, primary_intent, volume }` — filtered by
  // topic tag, AI model, and Semrush project(s). Backs the Prompts (count)
  // endpoint that feeds the prompt healthcheck metrics (intent %, and — via a
  // filtered count ratio — branded %).
  PROMPTS: '406ba6e0-0de2-475e-80d9-42fab8616032',

  // Topic Prompts
  PROMPTS_BY_TOPIC: '78864493-90a7-449a-89ab-1ba3d09a712e',
  SOURCES: '553cd819-d507-460d-a8ff-e34486bad3e1',
  SOURCES_DATES: '404fb017-7e44-41ec-896f-7138f731da60',

  // Prompt Details
  PROMPT_AI_ANSWERS: '45d6251f-15cd-4b33-a7f6-de97925e900e',
  PROMPT_SOURCES: '7db0df5c-6679-4495-8ea8-ef2dfd7e5251',
  PROMPT_VISIBILITY: 'f5230e00-b14f-4a52-bf89-2952ef7fe39b',
});
