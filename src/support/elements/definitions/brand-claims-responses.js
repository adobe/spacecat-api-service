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

import { ElementsTransportError } from '../errors.js';
import { buildAdvancedFilters } from '../constants.js';

export const DEFAULT_BRAND_CLAIMS_PAGE_SIZE = 500;
export const MAX_BRAND_CLAIMS_PAGE_SIZE = 500;
export const BRAND_CLAIMS_MODEL = 'search-gpt';

const SORT_COLUMNS = Object.freeze([
  'project_id asc',
  'prompt asc',
  'model asc',
  'date asc',
]);

function invalidResponse(path) {
  return new ElementsTransportError(
    502,
    `Malformed Brand Claims Elements response at ${path}`,
  );
}

/**
 * Builds the verified one-project, one-Monday request for combined Brand Claims element
 * 55e89619. The transport owns the single external `render_data` wrapper.
 */
export function buildBrandClaimsResponsesPayload({
  projectId,
  date,
  pageSize = DEFAULT_BRAND_CLAIMS_PAGE_SIZE,
  offset = 0,
} = {}) {
  return {
    project_id: projectId,
    statistics: { rowCount: { col: '*', func: 'count' } },
    filters: {
      simple: {
        CBF_date__start: date,
        CBF_date__end: date,
      },
      ...buildAdvancedFilters([
        { op: 'or', filters: [{ op: 'eq', val: BRAND_CLAIMS_MODEL, col: 'CBF_model' }] },
        { op: 'gte', val: date, col: 'CBF_date__start' },
        { op: 'lte', val: date, col: 'CBF_date__end' },
      ]),
    },
    pagination: {
      limit: pageSize,
      offset,
      sort_columns: [...SORT_COLUMNS],
    },
  };
}

function requiredText(row, field, index, { allowWhitespace = false } = {}) {
  if (typeof row[field] !== 'string' || (!allowWhitespace && row[field].trim() === '')) {
    throw invalidResponse(`blocks.data[${index}].${field}`);
  }
  return row[field];
}

function stringArray(row, field, index) {
  if (!Array.isArray(row[field]) || row[field].some((value) => typeof value !== 'string')) {
    throw invalidResponse(`blocks.data[${index}].${field}`);
  }
  return [...row[field]];
}

/**
 * Strictly normalizes the combined element response. Missing fields and wrong types are
 * upstream schema drift, not an empty corpus. Raw customer data is never attached to errors.
 */
export function transformBrandClaimsResponsesResponse(raw) {
  if (!raw?.blocks || !Array.isArray(raw.blocks.data)) {
    throw invalidResponse('blocks.data');
  }
  const statistics = raw.blocks.data_statistics;
  if (!Array.isArray(statistics) || statistics.length !== 1) {
    throw invalidResponse('blocks.data_statistics');
  }
  const rowCount = statistics[0]?.rowCount;
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw invalidResponse('blocks.data_statistics[0].rowCount');
  }

  const data = raw.blocks.data.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw invalidResponse(`blocks.data[${index}]`);
    }
    if (!Number.isInteger(row.responses) || row.responses < 0) {
      throw invalidResponse(`blocks.data[${index}].responses`);
    }
    return {
      projectId: requiredText(row, 'project_id', index),
      prompt: requiredText(row, 'prompt', index),
      response: requiredText(row, 'response', index),
      date: requiredText(row, 'date', index),
      model: requiredText(row, 'model', index),
      responses: row.responses,
      sources: stringArray(row, 'sources', index),
      tags: stringArray(row, 'tags', index),
    };
  });

  return { data, rowCount };
}
