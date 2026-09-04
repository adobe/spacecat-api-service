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
  buildPromptResponsesPayload,
  transformPromptResponsesResponse,
  DEFAULT_RESPONSE_PAGE_SIZE,
  MAX_RESPONSE_PAGE_SIZE,
} from '../../../../src/support/elements/definitions/prompt-responses.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

const responseRow = (overrides = {}) => ({
  project_id: 'proj-1',
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  model_name_cbf_value: 'ChatGPT Paid',
  response: 'The best running shoes are ...',
  position: 3,
  tags: '$abv_tags$intent__Commercial',
  ...overrides,
});

const rawWith = (...rows) => ({ blocks: { data: rows } });

describe('prompt-responses definitions', () => {
  describe('buildPromptResponsesPayload', () => {
    it('falls back to the default model when no params are provided', () => {
      const payload = buildPromptResponsesPayload();
      expect(payload.filters.advanced.filters[0]).to.deep.equal({
        op: 'or', filters: [{ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' }],
      });
    });

    it('translates a UI platform code to its Semrush model name', () => {
      const payload = buildPromptResponsesPayload({ platform: 'anthropic' });
      expect(payload.filters.advanced.filters[0].filters[0].val).to.equal('claude-sonnet-4');
    });

    it('prefers model over platform when both are supplied', () => {
      const payload = buildPromptResponsesPayload({ model: 'grok-3', platform: 'anthropic' });
      expect(payload.filters.advanced.filters[0].filters[0].val).to.equal('grok-3');
    });

    it('sends the date bounds in BOTH the simple and advanced blocks', () => {
      const payload = buildPromptResponsesPayload({ endDate: '2026-08-24' });
      expect(payload.filters.simple).to.deep.equal({
        CBF_date__start: '2026-08-24', CBF_date__end: '2026-08-24',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'gte', val: '2026-08-24', col: 'CBF_date__start',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'lte', val: '2026-08-24', col: 'CBF_date__end',
      });
    });

    it('never emits the silently-ignored start_date/end_date spellings', () => {
      const payload = buildPromptResponsesPayload({ endDate: '2026-08-24' });
      expect(payload).to.not.have.property('start_date');
      expect(payload).to.not.have.property('end_date');
      expect(payload.filters).to.not.have.property('start_date');
      expect(payload.filters).to.not.have.property('end_date');
    });

    it('omits the date blocks entirely when no endDate is given', () => {
      const payload = buildPromptResponsesPayload();
      expect(payload.filters).to.not.have.property('simple');
      const cols = payload.filters.advanced.filters.map((f) => f.col);
      expect(cols).to.not.include('CBF_date__start');
      expect(cols).to.not.include('CBF_date__end');
    });

    it('includes a top-level project_id when provided', () => {
      const payload = buildPromptResponsesPayload({ projectId: 'proj-42' });
      expect(payload.project_id).to.equal('proj-42');
    });

    it('omits project_id when not provided', () => {
      expect(buildPromptResponsesPayload()).to.not.have.property('project_id');
    });

    it('always sends sort_columns for deterministic pagination', () => {
      expect(buildPromptResponsesPayload().pagination.sort_columns).to.deep.equal(['prompt asc']);
    });

    it('defaults the page size and offset', () => {
      const { pagination } = buildPromptResponsesPayload();
      expect(pagination.limit).to.equal(DEFAULT_RESPONSE_PAGE_SIZE);
      expect(pagination.offset).to.equal(0);
    });

    it('honours an explicit limit and offset', () => {
      const { pagination } = buildPromptResponsesPayload({ limit: 50, offset: 100 });
      expect(pagination.limit).to.equal(50);
      expect(pagination.offset).to.equal(100);
    });

    it('clamps a limit above the 504-inducing ceiling', () => {
      expect(buildPromptResponsesPayload({ limit: 99999 }).pagination.limit)
        .to.equal(MAX_RESPONSE_PAGE_SIZE);
    });

    it('clamps a zero or negative limit up to 1', () => {
      expect(buildPromptResponsesPayload({ limit: 0 }).pagination.limit).to.equal(1);
      expect(buildPromptResponsesPayload({ limit: -5 }).pagination.limit).to.equal(1);
    });

    it('falls back to the default limit for a non-numeric value', () => {
      expect(buildPromptResponsesPayload({ limit: 'abc' }).pagination.limit)
        .to.equal(DEFAULT_RESPONSE_PAGE_SIZE);
    });

    it('floors a negative or non-numeric offset at 0', () => {
      expect(buildPromptResponsesPayload({ offset: -10 }).pagination.offset).to.equal(0);
      expect(buildPromptResponsesPayload({ offset: 'abc' }).pagination.offset).to.equal(0);
    });
  });

  describe('transformPromptResponsesResponse', () => {
    it('maps the element columns onto the normalised row shape', () => {
      const [row] = transformPromptResponsesResponse(rawWith(responseRow()));
      expect(row).to.deep.equal({
        projectId: 'proj-1',
        prompt: 'best running shoes',
        model: 'chatgpt-paid',
        modelNameCbfValue: 'ChatGPT Paid',
        response: 'The best running shoes are ...',
        position: 3,
        tags: '$abv_tags$intent__Commercial',
      });
    });

    it('never sets a date — this element has no date column', () => {
      const [row] = transformPromptResponsesResponse(rawWith(responseRow()));
      expect(row).to.not.have.property('date');
    });

    it('drops rows without a prompt, which can never join', () => {
      const rows = transformPromptResponsesResponse(
        rawWith(responseRow(), responseRow({ prompt: null })),
      );
      expect(rows).to.have.lengthOf(1);
    });

    it('drops null rows', () => {
      expect(transformPromptResponsesResponse(rawWith(null, responseRow()))).to.have.lengthOf(1);
    });

    it('coerces a non-numeric position to 0 rather than NaN', () => {
      const [row] = transformPromptResponsesResponse(rawWith(responseRow({ position: 'x' })));
      expect(row.position).to.equal(0);
    });

    it('defaults absent optional fields to empty strings', () => {
      const [row] = transformPromptResponsesResponse(rawWith({ prompt: 'p' }));
      expect(row.projectId).to.equal('');
      expect(row.model).to.equal('');
      expect(row.modelNameCbfValue).to.equal('');
      expect(row.response).to.equal('');
      expect(row.tags).to.equal('');
    });

    it('returns an empty array for absent, empty or malformed payloads', () => {
      expect(transformPromptResponsesResponse(undefined)).to.deep.equal([]);
      expect(transformPromptResponsesResponse({})).to.deep.equal([]);
      expect(transformPromptResponsesResponse({ blocks: {} })).to.deep.equal([]);
      expect(transformPromptResponsesResponse(rawWith())).to.deep.equal([]);
    });
  });
});
