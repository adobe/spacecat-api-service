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
  transformBrandsResponse,
  transformBrandsToFilterDimensions,
  buildMarketsPayload,
  transformMarketsResponse,
  buildTopicsPayload,
  transformTopicsResponse,
  transformTopicsForFilterDimensions,
  transformCategoriesToFilterDimensions,
  transformIntentsToFilterDimensions,
  transformOriginsToFilterDimensions,
} from './definitions/index.js';

/**
 * Creates the Elements service that composes transport calls with per-element
 * payload builders and response transformers.
 *
 * Each method maps to one logical SpaceCat API endpoint. When a Semrush element UUID
 * is reused for different dashboard sections, separate methods handle each case.
 *
 * @param {object} transport - Elements transport created by createElementsTransport().
 */
export function createElementsService(transport) {
  return {
    /**
     * Fetches all brands available in the workspace.
     * Powers the brand selector dropdown (filter dimensions, row 1).
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters from the SpaceCat API request.
     * @returns {Promise<import('./definitions/brands.js').Brand[]>}
     */
    async getBrands(workspaceId, params) {
      const payload = buildBrandsPayload(params);
      const raw = await transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, payload);
      return transformBrandsResponse(raw);
    },

    /**
     * Fetches available markets (location+language projects) for a brand.
     * Powers the market/region filter dropdown (filter dimensions, row 2).
     * The returned `id` values are Semrush project UUIDs — pass as `projectIds`
     * in subsequent brand-scoped element calls.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters; requires `params.brand` (brand name).
     * @returns {Promise<import('./definitions/markets.js').Market[]>}
     */
    async getMarkets(workspaceId, params) {
      const payload = buildMarketsPayload(params);
      const raw = await transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, payload);
      return transformMarketsResponse(raw);
    },

    /**
     * Fetches all topic and category tags available in the workspace.
     * Powers the Topics/Tags filter dropdown (filter dimensions, row 3).
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters from the SpaceCat API request.
     * @returns {Promise<import('./definitions/topics.js').Topic[]>}
     */
    async getTopics(workspaceId, params) {
      const payload = buildTopicsPayload(params);
      const raw = await transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, payload);
      return transformTopicsResponse(raw);
    },

    /**
     * Fetches filter dimensions for the URL Inspector dashboard.
     * Currently returns topics; future iterations will add categories, intents, and sources.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters (startDate, endDate, model, etc.).
     * @returns {Promise<{topics: import('./definitions/topics.js').FilterDimensionTopic[]}>}
     */
    async getUrlInspectorFilterDimensions(workspaceId, params) {
      const [rawTopics, rawBrands] = await Promise.all([
        transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, buildTopicsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, buildBrandsPayload(params)),
      ]);
      return {
        brands: transformBrandsToFilterDimensions(rawBrands),
        topics: transformTopicsForFilterDimensions(rawTopics),
        categories: transformCategoriesToFilterDimensions(rawTopics),
        page_intents: transformIntentsToFilterDimensions(rawTopics),
        origins: transformOriginsToFilterDimensions(rawTopics),
      };
    },
  };
}
