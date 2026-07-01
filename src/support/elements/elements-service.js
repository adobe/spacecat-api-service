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
  transformMarketsToFilterDimensions,
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
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters; `params.brand` scopes to a brand.
     * @param {Array<{brandId:string, semrushProjectId:string, geoTargetId:number,
     *   languageCode:string}>} [brandSemrushProjects=[]] - BrandSemrushProject rows
     *   used to enrich each market entry with SpaceCat metadata.
     * @returns {Promise<import('./definitions/markets.js').FilterDimensionRegion[]>}
     */
    async getMarkets(workspaceId, params, brandSemrushProjects = []) {
      const payload = buildMarketsPayload(params);
      const raw = await transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, payload);
      return transformMarketsToFilterDimensions(raw, brandSemrushProjects);
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
  };
}
