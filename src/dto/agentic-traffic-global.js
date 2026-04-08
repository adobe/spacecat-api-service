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
 * DTO for mysticat `agentic_traffic_global` PostgREST rows.
 */
export const AgenticTrafficGlobalDto = {
  /**
   * @param {object} row - Snake_case row from PostgREST
   * @returns {object}
   */
  toJSON: (row) => ({
    id: row.id,
    year: row.year,
    week: row.week,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  }),
};
