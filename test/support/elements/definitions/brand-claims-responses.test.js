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

import { expect } from 'chai';
import {
  buildBrandClaimsResponsesPayload,
  transformBrandClaimsResponsesResponse,
} from '../../../../src/support/elements/definitions/brand-claims-responses.js';

const row = (overrides = {}) => ({
  project_id: 'project-1',
  prompt: 'Which shoes are best?',
  response: 'A complete answer',
  date: '2026-09-07',
  model: 'search-gpt',
  responses: 1,
  sources: ['https://example.com/a'],
  tags: ['$abv_tags$intent__commercial'],
  ...overrides,
});

const raw = (rows = [row()], rowCount = rows.length) => ({
  blocks: { data: rows, data_statistics: [{ rowCount }] },
});

describe('brand-claims-responses definition', () => {
  it('builds the verified exact-Monday, search-gpt, rowCount payload', () => {
    expect(buildBrandClaimsResponsesPayload({
      projectId: 'project-1', date: '2026-09-07', pageSize: 500, offset: 1000,
    })).to.deep.equal({
      project_id: 'project-1',
      statistics: { rowCount: { col: '*', func: 'count' } },
      filters: {
        simple: { CBF_date__start: '2026-09-07', CBF_date__end: '2026-09-07' },
        advanced: {
          op: 'and',
          filters: [
            { op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }] },
            { op: 'gte', val: '2026-09-07', col: 'CBF_date__start' },
            { op: 'lte', val: '2026-09-07', col: 'CBF_date__end' },
          ],
        },
      },
      pagination: {
        limit: 500,
        offset: 1000,
        sort_columns: ['project_id asc', 'prompt asc', 'model asc', 'date asc'],
      },
    });
  });

  it('normalizes the combined row, UTC-midnight date, and rowCount without changing source order', () => {
    const result = transformBrandClaimsResponsesResponse(raw([
      row({
        date: '2026-09-07T00:00:00Z',
        sources: ['https://example.com/b', 'https://example.com/a'],
      }),
    ], 7));
    expect(result).to.deep.equal({
      rowCount: 7,
      data: [{
        projectId: 'project-1',
        prompt: 'Which shoes are best?',
        response: 'A complete answer',
        date: '2026-09-07',
        model: 'search-gpt',
        responses: 1,
        sources: ['https://example.com/b', 'https://example.com/a'],
        tags: ['$abv_tags$intent__commercial'],
      }],
    });
  });

  for (const [name, value] of [
    ['missing envelope', {}],
    ['missing rowCount', { blocks: { data: [], data_statistics: [] } }],
    ['negative rowCount', raw([], -1)],
    ['blank response', raw([row({ response: '   ' })])],
    ['wrong sources type', raw([row({ sources: 'https://example.com' })])],
    ['wrong tags item type', raw([row({ tags: [7] })])],
    ['non-midnight date', raw([row({ date: '2026-09-07T12:00:00Z' })])],
    ['impossible date', raw([row({ date: '2026-02-30' })])],
    ['missing required field', raw([row({ prompt: undefined })])],
  ]) {
    it(`rejects schema drift: ${name}`, () => {
      expect(() => transformBrandClaimsResponsesResponse(value))
        .to.throw(/Malformed Brand Claims Elements response/);
    });
  }
});
