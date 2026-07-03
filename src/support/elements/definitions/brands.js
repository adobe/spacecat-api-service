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

import { DEFAULT_ELEMENT_MODEL, ELEMENT_MODELS } from '../constants.js';

/**
 * Builds the payload for the Brands filter-dimensions element (row 1).
 * Returns the list of all available brands in the workspace — powers the brand selector dropdown.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value. Must be one of {@link ELEMENT_MODELS};
 *   falls back to {@link DEFAULT_ELEMENT_MODEL} if omitted or unrecognised.
 */
export function buildBrandsPayload({ model } = {}) {
  const resolvedModel = ELEMENT_MODELS.includes(model) ? model : DEFAULT_ELEMENT_MODEL;
  return {
    comparison_data_formatting: 'union',
    filters: {
      advanced: {
        op: 'and',
        filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }],
      },
    },
  };
}

/**
 * Transforms the raw Semrush Brands element response into URL Inspector filter-dimension brands.
 * `id` is always null (Semrush has no stable brand ID); `spacecat_brand_id` is resolved by
 * case-insensitive name matching against the caller-supplied SpaceCat brands list.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {Array<{id: string, name: string}>} [spacecatBrands=[]] - SpaceCat brands for this org.
 * @returns {Array<{id: null, label: string, spacecat_brand_id: string|null}>}
 */
export function transformBrandsToFilterDimensions(raw, spacecatBrands = []) {
  const brandIdByName = new Map(
    spacecatBrands.map((b) => [String(b.name ?? '').toLowerCase(), b.id]),
  );
  return (raw?.blocks?.value ?? []).map((item) => {
    const label = item.value ?? '';
    return {
      id: null,
      label,
      spacecat_brand_id: brandIdByName.get(label.toLowerCase()) ?? null,
    };
  });
}
