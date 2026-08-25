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
 * DTO for `agentic_url_category_rules` / `agentic_url_page_type_rules` PostgREST
 * rows. Both tables share the same shape, so a single DTO serves both dimensions.
 * Transforms snake_case DB columns into the camelCase API contract — never expose
 * raw database rows.
 */
export const AgenticRuleDto = {
  /**
   * @param {object} row - Snake_case row from PostgREST.
   * @returns {object} camelCase API representation.
   */
  toJSON: (row) => ({
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    regex: row.regex,
    sortOrder: row.sort_order,
    source: row.source,
    sampleUrls: row.sample_urls ?? [],
    derivationMethod: row.derivation_method ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
  }),
};

export default AgenticRuleDto;
