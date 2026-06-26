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
import { PreflightDto } from '../../src/dto/preflight.js';

const CREATED_FIELDS = [
  'preflightId', 'siteId', 'status', 'url', 'createdAt', 'createdBy',
];

const LIST_FIELDS = [
  ...CREATED_FIELDS, 'updatedAt', 'endedAt',
];

const DETAIL_FIELDS = [
  ...LIST_FIELDS,
  'result', 'error',
];

function makePreflight(overrides = {}) {
  const defaults = {
    id: 'pf-1',
    siteId: 'site-1',
    status: 'IN_PROGRESS',
    url: 'https://example.com/page',
    createdAt: '2026-06-26T12:00:00Z',
    updatedAt: '2026-06-26T12:00:00Z',
    endedAt: null,
    createdBy: { email: 'alice@example.com' },
    ...overrides,
  };
  return {
    getId: () => defaults.id,
    getSiteId: () => defaults.siteId,
    getStatus: () => defaults.status,
    getUrl: () => defaults.url,
    getCreatedAt: () => defaults.createdAt,
    getUpdatedAt: () => defaults.updatedAt,
    getEndedAt: () => defaults.endedAt,
    getCreatedBy: () => defaults.createdBy,
  };
}

function makeAsyncJob(overrides = {}) {
  const defaults = {
    status: 'COMPLETED',
    startedAt: '2026-06-26T12:00:01Z',
    endedAt: '2026-06-26T12:00:30Z',
    result: { audits: [{ name: 'canonical', status: 'ok' }] },
    error: null,
    ...overrides,
  };
  return {
    getStatus: () => defaults.status,
    getStartedAt: () => defaults.startedAt,
    getEndedAt: () => defaults.endedAt,
    getResult: () => defaults.result,
    getError: () => defaults.error,
  };
}

describe('PreflightDto', () => {
  describe('toCreatedJSON (POST 202 body)', () => {
    it('returns just-created shape: identity + state, no updatedAt/endedAt', () => {
      const out = PreflightDto.toCreatedJSON(makePreflight());
      expect(out).to.deep.equal({
        preflightId: 'pf-1',
        siteId: 'site-1',
        status: 'IN_PROGRESS',
        url: 'https://example.com/page',
        createdAt: '2026-06-26T12:00:00Z',
        createdBy: { email: 'alice@example.com' },
      });
    });

    it('omits updatedAt and endedAt — they carry no info at creation time', () => {
      const out = PreflightDto.toCreatedJSON(makePreflight());
      expect(out).to.not.have.property('updatedAt');
      expect(out).to.not.have.property('endedAt');
    });

    it('returns exactly the documented just-created keys — no leakage, no drift', () => {
      const out = PreflightDto.toCreatedJSON(makePreflight());
      expect(Object.keys(out).sort()).to.deep.equal([...CREATED_FIELDS].sort());
    });
  });

  describe('toJSON (list)', () => {
    it('maps an in-progress Preflight entity to the wire contract', () => {
      const out = PreflightDto.toJSON(makePreflight());
      expect(out).to.deep.equal({
        preflightId: 'pf-1',
        siteId: 'site-1',
        status: 'IN_PROGRESS',
        url: 'https://example.com/page',
        createdAt: '2026-06-26T12:00:00Z',
        updatedAt: '2026-06-26T12:00:00Z',
        endedAt: null,
        createdBy: { email: 'alice@example.com' },
      });
    });

    it('surfaces endedAt when the row is terminal', () => {
      const out = PreflightDto.toJSON(makePreflight({
        status: 'COMPLETED',
        endedAt: '2026-06-26T12:00:30Z',
      }));
      expect(out.status).to.equal('COMPLETED');
      expect(out.endedAt).to.equal('2026-06-26T12:00:30Z');
    });

    it('returns exactly the documented list keys — no leakage, no drift', () => {
      const out = PreflightDto.toJSON(makePreflight());
      expect(Object.keys(out).sort()).to.deep.equal([...LIST_FIELDS].sort());
    });
  });

  describe('toDetailJSON (detail)', () => {
    it('merges Preflight + AsyncJob into the detail contract; lifecycle from AsyncJob (truth)', () => {
      const out = PreflightDto.toDetailJSON(
        makePreflight({ status: 'COMPLETED', endedAt: '2026-06-26T12:00:30Z' }),
        makeAsyncJob({ endedAt: '2026-06-26T12:00:30Z' }),
      );
      expect(out).to.deep.equal({
        preflightId: 'pf-1',
        siteId: 'site-1',
        status: 'COMPLETED',
        url: 'https://example.com/page',
        createdAt: '2026-06-26T12:00:00Z',
        updatedAt: '2026-06-26T12:00:00Z',
        endedAt: '2026-06-26T12:00:30Z',
        createdBy: { email: 'alice@example.com' },
        result: { audits: [{ name: 'canonical', status: 'ok' }] },
        error: null,
      });
    });

    it('AsyncJob.status wins over Preflight.status when they disagree (projector two-write window)', () => {
      // Projector writes async_jobs first (terminal), then preflights cache.
      // During the gap, AsyncJob = COMPLETED + Preflight = IN_PROGRESS.
      // Detail must report COMPLETED so polling clients can stop on terminal
      // state — otherwise they'd spin indefinitely on a scan that's done.
      const out = PreflightDto.toDetailJSON(
        makePreflight({ status: 'IN_PROGRESS', endedAt: null }),
        makeAsyncJob({ endedAt: '2026-06-26T12:00:30Z' }),
      );
      expect(out.status).to.equal('COMPLETED');
      expect(out.endedAt).to.equal('2026-06-26T12:00:30Z');
      expect(out.result).to.not.equal(null);
    });

    it('surfaces error structure when the AsyncJob reports FAILED', () => {
      const errorPayload = { code: 'DA_FETCH_ERROR', message: 'Document Authoring 502', details: { url: 'x' } };
      const out = PreflightDto.toDetailJSON(
        makePreflight({ status: 'FAILED', endedAt: '2026-06-26T12:00:30Z' }),
        makeAsyncJob({ status: 'FAILED', result: null, error: errorPayload }),
      );
      expect(out.status).to.equal('FAILED');
      expect(out.error).to.deep.equal(errorPayload);
      expect(out.result).to.equal(null);
    });

    it('degrades result/error to null when AsyncJob is missing', () => {
      const out = PreflightDto.toDetailJSON(makePreflight(), null);
      expect(out.result).to.equal(null);
      expect(out.error).to.equal(null);
      // Preflight-sourced fields remain populated
      expect(out.preflightId).to.equal('pf-1');
      expect(out.siteId).to.equal('site-1');
      expect(out.status).to.equal('IN_PROGRESS');
    });

    it('returns exactly the documented detail keys — no leakage, no drift', () => {
      const out = PreflightDto.toDetailJSON(makePreflight(), makeAsyncJob());
      expect(Object.keys(out).sort()).to.deep.equal([...DETAIL_FIELDS].sort());
    });

    it('does not surface asyncJobId, scanId, or startedAt on the wire', () => {
      const out = PreflightDto.toDetailJSON(makePreflight(), makeAsyncJob());
      expect(out).to.not.have.property('asyncJobId');
      expect(out).to.not.have.property('scanId');
      // startedAt is an AsyncJob concern, not a Preflight attribute — consumers
      // that need timing internals read them from `result`.
      expect(out).to.not.have.property('startedAt');
    });

    it('coerces DB-NULL (returned as undefined) to JSON null on result/error/endedAt', () => {
      // spacecat-shared's normalizeModelValue maps DB NULL to JS undefined.
      // `JSON.stringify({ k: undefined })` drops the key — without the
      // `?? null` coercion, an IN_PROGRESS preflight's detail response would
      // be missing `result`/`error`/`endedAt` entirely, violating the
      // documented `... | null` wire contract.
      const inProgressJob = {
        getStatus: () => 'IN_PROGRESS',
        getEndedAt: () => undefined,
        getResult: () => undefined,
        getError: () => undefined,
      };
      const out = PreflightDto.toDetailJSON(makePreflight(), inProgressJob);
      // Object-literal level: keys present, value is null (not undefined).
      expect(out).to.have.property('endedAt');
      expect(out.endedAt).to.equal(null);
      expect(out).to.have.property('result');
      expect(out.result).to.equal(null);
      expect(out).to.have.property('error');
      expect(out.error).to.equal(null);
      // Serialised level: keys SURVIVE JSON.stringify (regression on the
      // exact failure mode — `{ k: undefined }` would have dropped them).
      const round = JSON.parse(JSON.stringify(out));
      expect(round).to.have.property('endedAt', null);
      expect(round).to.have.property('result', null);
      expect(round).to.have.property('error', null);
    });

    it('list: coerces DB-NULL endedAt to JSON null (in-progress preflight)', () => {
      // Same regression on the list shape — Preflight.getEndedAt() returns
      // undefined for an in-progress row (NULL column); the wire shape
      // promises `string | null`.
      const inProgress = makePreflight({ endedAt: undefined });
      const out = PreflightDto.toJSON(inProgress);
      expect(out).to.have.property('endedAt', null);
      const round = JSON.parse(JSON.stringify(out));
      expect(round).to.have.property('endedAt', null);
    });
  });
});
