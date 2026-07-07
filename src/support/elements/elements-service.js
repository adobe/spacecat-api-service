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

import { ELEMENT_IDS } from './element-ids.js';
import {
  buildBrandsPayload,
  transformBrandsToFilterDimensions,
  buildMarketsPayload,
  transformMarketsToFilterDimensions,
  buildTopicsPayload,
  transformTopicsForFilterDimensions,
  transformCategoriesToFilterDimensions,
  transformIntentsToFilterDimensions,
  transformOriginsToFilterDimensions,
  buildWeeksPayload,
  transformWeeksResponse,
  buildPromptsPayload,
  transformPromptsResponse,
} from './definitions/index.js';

/**
 * Creates the Elements service that composes transport calls with per-element
 * payload builders and response transformers.
 *
 * @param {object} transport - Elements transport created by createElementsTransport().
 */
export function createElementsService(transport) {
  return {
    /**
     * Fetches filter dimensions for the URL Inspector dashboard.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters (startDate, endDate, model, etc.).
     * @param {Array<{id: string, name: string}>} [spacecatBrands=[]] - SpaceCat brands for the org,
     *   used to resolve `spacecat_brand_id` on each brand entry by name match.
     * @returns {Promise<object>}
     */
    async getUrlInspectorFilterDimensions(
      workspaceId,
      params,
      spacecatBrands = [],
      brandSemrushProjects = [],
    ) {
      const [rawTopics, rawBrands, rawMarkets] = await Promise.all([
        transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, buildTopicsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, buildBrandsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, buildMarketsPayload({})),
      ]);
      return {
        brands: transformBrandsToFilterDimensions(rawBrands, spacecatBrands),
        regions: transformMarketsToFilterDimensions(rawMarkets, brandSemrushProjects),
        topics: transformTopicsForFilterDimensions(rawTopics),
        categories: transformCategoriesToFilterDimensions(rawTopics),
        page_intents: transformIntentsToFilterDimensions(rawTopics),
        origins: transformOriginsToFilterDimensions(rawTopics),
      };
    },

    /**
     * Fetches the list of weeks that have Brand Presence data (week filter dropdown).
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters (model, etc.).
     * @returns {Promise<object>} `{ weeks: [{ week, startDate, endDate }] }`.
     */
    /* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
    async getWeeks(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.WEEKS,
        buildWeeksPayload(params),
      );
      return { weeks: transformWeeksResponse(raw) };
    },
    /* c8 ignore stop */

    /**
     * Fetches the prompts matching the given filters, plus their count.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Filter parameters (model/platform, topics, projectIds).
     * @returns {Promise<{count: number, prompts: object[]}>} `{ count, prompts }`.
     */
    async getPrompts(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.PROMPTS,
        buildPromptsPayload(params),
      );
      return transformPromptsResponse(raw);
    },
  };
}
