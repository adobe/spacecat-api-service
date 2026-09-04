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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { createElementsService } from '../../../src/support/elements/elements-service.js';
import { ELEMENT_IDS } from '../../../src/support/elements/element-ids.js';

use(sinonChai);

const WS = 'ws-1';
const PROJECT = 'proj-1';

/** Builds a raw answer-element page (141adc88 — no date column). */
const answerPage = (rows) => ({ blocks: { data: rows } });

/** Builds one answer row. */
const answer = (over = {}) => ({
  project_id: PROJECT,
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  response: 'Some answer text',
  position: 1,
  tags: '',
  ...over,
});

/** Builds one source row. The live element returns a full timestamp for `date`. */
const source = (over = {}) => ({
  project_id: PROJECT,
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  date: '2026-08-24T00:00:00Z',
  url_cbf: 'https://runnersworld.com/best',
  source: 'runnersworld.com',
  position: 1,
  domain_type: 'Earned',
  execution_id: 'exec-1',
  tags: '',
  ...over,
});

describe('createElementsService#getResponseFeed', () => {
  let transport;
  let service;

  beforeEach(() => {
    transport = { fetchElement: sinon.stub() };
    transport.fetchElement.resolves(answerPage([]));
    service = createElementsService(transport);
  });

  afterEach(() => {
    sinon.restore();
  });

  /** All `endDate` values the answer element was called with, in call order. */
  const answerBoundaries = () => transport.fetchElement
    .getCalls()
    .filter((c) => c.args[1] === ELEMENT_IDS.CITATIONS_SOURCES)
    .map((c) => c.args[2].filters.simple.CBF_date__end);

  describe('boundary amortisation', () => {
    // The reason this endpoint is range-based rather than per-day. Recovering N days needs
    // N+1 boundaries because consecutive days SHARE one: executions(D) = end(D) - end(D-1),
    // so end(D) is also the subtrahend for day D+1. Fetching per-day would cost 2N.
    it('costs N+1 boundary pulls per element for an N-day range, not 2N', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-20',
        endDate: '2026-08-24',
      });

      // 5 days -> 6 boundaries per element. Naive per-day would be 10.
      expect(answerBoundaries()).to.have.lengthOf(6);
      // Two elements, one call each per boundary.
      expect(transport.fetchElement.callCount).to.equal(12);
    });

    it('fetches each boundary exactly once, never re-pulling a shared one', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-20',
        endDate: '2026-08-24',
      });

      const boundaries = answerBoundaries();
      expect(new Set(boundaries).size).to.equal(boundaries.length);
    });

    it('includes the D-1 boundary before the first requested day', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-20',
        endDate: '2026-08-22',
      });

      expect(answerBoundaries()).to.deep.equal([
        '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22',
      ]);
    });

    it('costs 2 pulls per element for a single-day range (the degenerate case)', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(answerBoundaries()).to.deep.equal(['2026-08-23', '2026-08-24']);
    });
  });

  describe('the join', () => {
    it('pairs an answer with the sources cited in the same execution', async () => {
      transport.fetchElement.callsFake((ws, elementId, payload) => {
        const end = payload.filters.simple.CBF_date__end;
        if (elementId === ELEMENT_IDS.CITATIONS_SOURCES) {
          // Present on day D, absent on D-1 -> a genuine day-D execution.
          return Promise.resolve(answerPage(end === '2026-08-24' ? [answer()] : []));
        }
        return Promise.resolve(answerPage(end === '2026-08-24' ? [source()] : []));
      });

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.records).to.have.lengthOf(1);
      expect(result.records[0].sources).to.have.lengthOf(1);
      expect(result.records[0].date).to.equal('2026-08-24');
      expect(result.records[0].model).to.equal('chatgpt-paid');
    });

    // ABSENCE IS MEANINGFUL: a tuple runs on a median 61 of 74 days, so a model that did
    // not run is routine and must never read as an error or as lost data.
    it('returns an answer with an empty source list rather than dropping it', async () => {
      transport.fetchElement.callsFake((ws, elementId, payload) => {
        const end = payload.filters.simple.CBF_date__end;
        if (elementId === ELEMENT_IDS.CITATIONS_SOURCES) {
          return Promise.resolve(answerPage(end === '2026-08-24' ? [answer()] : []));
        }
        return Promise.resolve(answerPage([]));
      });

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.records).to.have.lengthOf(1);
      expect(result.records[0].sources).to.deep.equal([]);
    });

    it('reports no records for a day on which nothing ran, without erroring', async () => {
      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.records).to.deep.equal([]);
      expect(result.unmatchedSourceKeyCount).to.equal(0);
    });

    // Guards the `?? []` fallbacks: an element answering with no `blocks.data` at all is a
    // legitimate empty read, not a malformed response, and must not throw mid-join.
    it('tolerates an element page with no data block', async () => {
      transport.fetchElement.resolves({});

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-23',
        endDate: '2026-08-24',
      });

      expect(result.records).to.deep.equal([]);
      expect(result.days).to.deep.equal(['2026-08-23', '2026-08-24']);
    });

    // A row present on BOTH boundaries is carried-over history, not a day-D execution.
    it('excludes an answer already present on the previous boundary', async () => {
      transport.fetchElement.resolves(answerPage([answer()]));

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.records).to.deep.equal([]);
    });

    it('selects source rows by their own date rather than by difference', async () => {
      transport.fetchElement.callsFake((ws, elementId, payload) => {
        const end = payload.filters.simple.CBF_date__end;
        if (elementId === ELEMENT_IDS.CITATIONS_SOURCES) {
          return Promise.resolve(answerPage(end === '2026-08-24' ? [answer()] : []));
        }
        // The page holds the whole rolling window; only the day's own rows must join.
        return Promise.resolve(answerPage([
          source({ date: '2026-08-23T00:00:00Z', url_cbf: 'https://old.example' }),
          source(),
        ]));
      });

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.records[0].sources).to.have.lengthOf(1);
      expect(result.records[0].sources[0].url).to.equal('https://runnersworld.com/best');
    });

    it('counts source rows whose answer was not in the page', async () => {
      transport.fetchElement.callsFake((ws, elementId) => {
        if (elementId === ELEMENT_IDS.CITATIONS_SOURCES) {
          return Promise.resolve(answerPage([]));
        }
        return Promise.resolve(answerPage([source()]));
      });

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.unmatchedSourceKeyCount).to.equal(1);
    });
  });

  describe('project (market) fan-out', () => {
    it('issues an independent boundary walk per project', async () => {
      await service.getResponseFeed(WS, {
        projectIds: ['p1', 'p2'],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      // 2 projects x 2 boundaries x 2 elements.
      expect(transport.fetchElement.callCount).to.equal(8);
      const scoped = transport.fetchElement.getCalls().map((c) => c.args[2].project_id);
      expect(new Set(scoped)).to.deep.equal(new Set(['p1', 'p2']));
    });

    it('deduplicates repeated project ids so a market is not walked twice', async () => {
      await service.getResponseFeed(WS, {
        projectIds: ['p1', 'p1'],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(transport.fetchElement.callCount).to.equal(4);
    });

    it('omits project_id entirely when no project is supplied', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(transport.fetchElement.callCount).to.equal(4);
      expect(transport.fetchElement.firstCall.args[2]).to.not.have.property('project_id');
    });

    it('treats a missing projectIds as workspace-wide rather than throwing', async () => {
      const result = await service.getResponseFeed(WS, {
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.projectIds).to.deep.equal([]);
    });

    it('ignores blank project ids', async () => {
      const result = await service.getResponseFeed(WS, {
        projectIds: ['', '  '],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.projectIds).to.deep.equal([]);
    });

    it('ignores a null project id without throwing', async () => {
      const result = await service.getResponseFeed(WS, {
        projectIds: [null, undefined],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      expect(result.projectIds).to.deep.equal([]);
    });
  });

  describe('envelope', () => {
    it('reports the days covered and the resolved page size', async () => {
      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-23',
        endDate: '2026-08-24',
      });

      expect(result.days).to.deep.equal(['2026-08-23', '2026-08-24']);
      expect(result.pageSize).to.equal(5000);
      expect(result.truncated).to.equal(false);
    });

    it('honours a caller-supplied limit in the resolved page size', async () => {
      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        limit: 10,
      });

      expect(result.pageSize).to.equal(10);
    });

    // A full page means the window was clipped, so the difference may be incomplete. That
    // must be visible: silently serving a partial day as whole is the data-loss shape.
    it('flags truncation when an upstream page comes back full', async () => {
      transport.fetchElement.resolves(answerPage([answer(), answer()]));

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        limit: 2,
      });

      expect(result.truncated).to.equal(true);
    });

    it('does not flag truncation on a partial page', async () => {
      transport.fetchElement.resolves(answerPage([answer()]));

      const result = await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        limit: 500,
      });

      expect(result.truncated).to.equal(false);
    });
  });

  describe('upstream payloads', () => {
    it('reads both halves of the record from their own elements', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      const ids = new Set(transport.fetchElement.getCalls().map((c) => c.args[1]));
      expect(ids).to.deep.equal(new Set([
        ELEMENT_IDS.CITATIONS_SOURCES,
        ELEMENT_IDS.SOURCES_DATES,
      ]));
    });

    it('passes the model filter through to both elements', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        model: 'perplexity',
      });

      for (const call of transport.fetchElement.getCalls()) {
        const modelFilter = call.args[2].filters.advanced.filters
          .find((f) => f.op === 'or');
        expect(modelFilter.filters[0].val).to.equal('perplexity');
      }
    });

    it('targets the resolved workspace, which the caller never supplies', async () => {
      await service.getResponseFeed(WS, {
        projectIds: [PROJECT],
        startDate: '2026-08-24',
        endDate: '2026-08-24',
      });

      for (const call of transport.fetchElement.getCalls()) {
        expect(call.args[0]).to.equal(WS);
      }
    });
  });
});
