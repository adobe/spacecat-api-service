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
  buildResponseSourcesPayload,
  transformResponseSourcesResponse,
} from '../../../../src/support/elements/definitions/response-sources.js';
import {
  DEFAULT_RESPONSE_PAGE_SIZE,
  MAX_RESPONSE_PAGE_SIZE,
} from '../../../../src/support/elements/definitions/prompt-responses.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

const sourceRow = (overrides = {}) => ({
  execution_id: 'proj-1|2026-08-24|chatgpt-paid|best running shoes',
  project_id: 'proj-1',
  prompt: 'best running shoes',
  date: '2026-08-24',
  model: 'chatgpt-paid',
  source: 'runnersworld.com',
  url_cbf: 'https://runnersworld.com/best-shoes',
  position: 1,
  domain_type: 'Earned',
  tags: '$abv_tags$type__branded',
  ...overrides,
});

const rawWith = (...rows) => ({ blocks: { data: rows } });

describe('response-sources definitions', () => {
  describe('buildResponseSourcesPayload', () => {
    it('falls back to the default model when no params are provided', () => {
      const payload = buildResponseSourcesPayload();
      expect(payload.filters.advanced.filters[0]).to.deep.equal({
        op: 'or', filters: [{ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' }],
      });
    });

    it('translates a UI platform code to its Semrush model name', () => {
      const payload = buildResponseSourcesPayload({ platform: 'copilot' });
      expect(payload.filters.advanced.filters[0].filters[0].val).to.equal('microsoft-copilot');
    });

    it('prefers model over platform when both are supplied', () => {
      const payload = buildResponseSourcesPayload({ model: 'perplexity', platform: 'copilot' });
      expect(payload.filters.advanced.filters[0].filters[0].val).to.equal('perplexity');
    });

    it('sends the date bounds in BOTH the simple and advanced blocks', () => {
      const payload = buildResponseSourcesPayload({ endDate: '2026-08-24' });
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
      const payload = buildResponseSourcesPayload({ endDate: '2026-08-24' });
      expect(payload).to.not.have.property('start_date');
      expect(payload).to.not.have.property('end_date');
      expect(payload.filters).to.not.have.property('start_date');
      expect(payload.filters).to.not.have.property('end_date');
    });

    it('omits the date blocks entirely when no endDate is given', () => {
      const payload = buildResponseSourcesPayload();
      expect(payload.filters).to.not.have.property('simple');
      const cols = payload.filters.advanced.filters.map((f) => f.col);
      expect(cols).to.not.include('CBF_date__end');
    });

    it('includes a top-level project_id when provided', () => {
      expect(buildResponseSourcesPayload({ projectId: 'proj-42' }).project_id).to.equal('proj-42');
    });

    it('omits project_id when not provided', () => {
      expect(buildResponseSourcesPayload()).to.not.have.property('project_id');
    });

    it('sorts by prompt then position so an answer\'s citations stay contiguous', () => {
      expect(buildResponseSourcesPayload().pagination.sort_columns)
        .to.deep.equal(['prompt asc', 'position asc']);
    });

    it('defaults the page size and offset', () => {
      const { pagination } = buildResponseSourcesPayload();
      expect(pagination.limit).to.equal(DEFAULT_RESPONSE_PAGE_SIZE);
      expect(pagination.offset).to.equal(0);
    });

    it('honours an explicit limit and offset', () => {
      const { pagination } = buildResponseSourcesPayload({ limit: 25, offset: 75 });
      expect(pagination.limit).to.equal(25);
      expect(pagination.offset).to.equal(75);
    });

    it('clamps the limit to the ceiling and floor', () => {
      expect(buildResponseSourcesPayload({ limit: 99999 }).pagination.limit)
        .to.equal(MAX_RESPONSE_PAGE_SIZE);
      expect(buildResponseSourcesPayload({ limit: 0 }).pagination.limit).to.equal(1);
    });

    it('falls back to defaults for non-numeric pagination values', () => {
      const { pagination } = buildResponseSourcesPayload({ limit: 'abc', offset: 'xyz' });
      expect(pagination.limit).to.equal(DEFAULT_RESPONSE_PAGE_SIZE);
      expect(pagination.offset).to.equal(0);
    });

    it('floors a negative offset at 0', () => {
      expect(buildResponseSourcesPayload({ offset: -10 }).pagination.offset).to.equal(0);
    });
  });

  describe('transformResponseSourcesResponse', () => {
    it('maps the element columns onto the normalised row shape', () => {
      const [row] = transformResponseSourcesResponse(rawWith(sourceRow()));
      expect(row).to.deep.equal({
        projectId: 'proj-1',
        prompt: 'best running shoes',
        model: 'chatgpt-paid',
        date: '2026-08-24',
        url: 'https://runnersworld.com/best-shoes',
        source: 'runnersworld.com',
        position: 1,
        domainType: 'Earned',
        executionId: 'proj-1|2026-08-24|chatgpt-paid|best running shoes',
        tags: '$abv_tags$type__branded',
      });
    });

    it('falls back to source when url_cbf is absent', () => {
      const [row] = transformResponseSourcesResponse(rawWith(sourceRow({ url_cbf: null })));
      expect(row.url).to.equal('runnersworld.com');
    });

    it('drops rows missing either join-key component', () => {
      const rows = transformResponseSourcesResponse(rawWith(
        sourceRow(),
        sourceRow({ prompt: null }),
        sourceRow({ date: null }),
      ));
      expect(rows).to.have.lengthOf(1);
    });

    it('drops null rows', () => {
      expect(transformResponseSourcesResponse(rawWith(null, sourceRow()))).to.have.lengthOf(1);
    });

    it('coerces a non-numeric position to 0 rather than NaN', () => {
      const [row] = transformResponseSourcesResponse(rawWith(sourceRow({ position: 'x' })));
      expect(row.position).to.equal(0);
    });

    it('defaults absent optional fields to empty strings', () => {
      const [row] = transformResponseSourcesResponse(rawWith({ prompt: 'p', date: '2026-08-24' }));
      expect(row.projectId).to.equal('');
      expect(row.model).to.equal('');
      expect(row.url).to.equal('');
      expect(row.source).to.equal('');
      expect(row.domainType).to.equal('');
      expect(row.executionId).to.equal('');
      expect(row.tags).to.equal('');
    });

    it('returns an empty array for absent, empty or malformed payloads', () => {
      expect(transformResponseSourcesResponse(undefined)).to.deep.equal([]);
      expect(transformResponseSourcesResponse({})).to.deep.equal([]);
      expect(transformResponseSourcesResponse({ blocks: {} })).to.deep.equal([]);
      expect(transformResponseSourcesResponse(rawWith())).to.deep.equal([]);
    });
  });
});
