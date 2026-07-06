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
  TOTAL_EXECUTIONS: 'a4defa1a-02f7-4443-b6ed-f2ca22b23402',
  WEEKS: 'afa7458b-d34f-43d9-8cc5-e8794753551c',

  // Aggregated Stats
  // URL Inspector — Cited Domains ("Stats per Domain"). `table` envelope,
  // date + model filters only (no brand/project/category push-down per the wiki).
  CITED_DOMAINS: '98b91d00-9531-4120-b3b5-17cc27489fce',

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

  // Topic Prompts
  PROMPTS_BY_TOPIC: '78864493-90a7-449a-89ab-1ba3d09a712e',
  SOURCES: '553cd819-d507-460d-a8ff-e34486bad3e1',
  SOURCES_DATES: '404fb017-7e44-41ec-896f-7138f731da60',

  // Prompt Details
  PROMPT_AI_ANSWERS: '45d6251f-15cd-4b33-a7f6-de97925e900e',
  PROMPT_SOURCES: '7db0df5c-6679-4495-8ea8-ef2dfd7e5251',
  PROMPT_VISIBILITY: 'f5230e00-b14f-4a52-bf89-2952ef7fe39b',
});
