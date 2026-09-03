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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';
import { canonicalizeUrl } from '@adobe/spacecat-shared-utils';

use(chaiAsPromised);

const SITE = 'site-1';

describe('lookup-by-url support', () => {
  const sandbox = sinon.createSandbox();
  let mod;
  let lookupStub;

  beforeEach(async () => {
    lookupStub = sandbox.stub().resolves([]);
    mod = await esmock('../../src/support/lookup-by-url.js', {
      '@adobe/spacecat-shared-data-access': { lookupEntityIdsByUrl: lookupStub },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  // ---- fixtures -------------------------------------------------------------

  const opp = (id, status = 'NEW') => ({
    id,
    status,
    opportunityId: null,
    dto: {
      id, type: 'cited-analysis', status, title: `t-${id}`, updatedAt: '2026-01-01', data: { big: id },
    },
  });

  const sugg = (id, opportunityId, status = 'NEW') => ({
    id,
    status,
    opportunityId,
    dto: {
      id, opportunityId, type: 'CONTENT_UPDATE', status, rank: 1, updatedAt: '2026-01-01', data: { big: id },
    },
  });

  const fetchFrom = (list) => {
    const byId = new Map(list.map((e) => [e.id, e]));
    return async (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  };

  const rowsFor = (map) => {
    const rows = [];
    for (const [url, ids] of Object.entries(map)) {
      const canonical = canonicalizeUrl(url);
      ids.forEach((id) => rows.push({ entity_id: id, entity_type: 'cited-analysis', url: canonical }));
    }
    return rows;
  };

  const oppCfg = (over = {}) => ({
    table: 'opportunity_urls',
    siteId: SITE,
    rawUrls: over.rawUrls,
    params: over.params ?? {},
    validStatuses: ['NEW', 'IN_PROGRESS', 'IGNORED', 'RESOLVED'],
    defaultExcludedStatuses: ['IGNORED'],
    fetchEntities: over.fetchEntities ?? fetchFrom([]),
    filterEntities: over.filterEntities,
    getId: (e) => e.id,
    getStatus: (e) => e.status,
    getSortKey: (e) => e.id,
    toFullDto: (e) => e.dto,
    lightweightFields: ['id', 'type', 'status', 'title', 'updatedAt'],
    forceFields: ['id'],
    idListKey: 'opportunityIds',
    mapKey: 'opportunities',
    includeNoMatchInResults: true,
    includeUnmatchedUrls: false,
  });

  const suggCfg = (over = {}) => ({
    table: 'suggestion_urls',
    siteId: SITE,
    rawUrls: over.rawUrls,
    params: over.params ?? {},
    validStatuses: ['NEW', 'APPROVED', 'IN_PROGRESS', 'SKIPPED', 'FIXED', 'ERROR', 'OUTDATED', 'PENDING_VALIDATION', 'REJECTED'],
    defaultExcludedStatuses: ['SKIPPED', 'REJECTED', 'OUTDATED'],
    fetchEntities: over.fetchEntities ?? fetchFrom([]),
    filterEntities: over.filterEntities,
    getId: (e) => e.id,
    getStatus: (e) => e.status,
    getSortKey: (e) => `${e.opportunityId}|${e.id}`,
    toFullDto: (e) => e.dto,
    lightweightFields: ['id', 'opportunityId', 'type', 'status', 'rank', 'updatedAt'],
    forceFields: ['id', 'opportunityId'],
    idListKey: 'suggestionIds',
    mapKey: 'suggestions',
    includeNoMatchInResults: false,
    includeUnmatchedUrls: true,
  });

  // ---- parse helpers --------------------------------------------------------

  describe('parseLookupUrls', () => {
    it('rejects a non-array', () => {
      expect(mod.parseLookupUrls('x')).to.deep.equal({ error: 'urls must be an array' });
      expect(mod.parseLookupUrls(undefined).error).to.match(/must be an array/);
    });

    it('rejects more than 100 entries', () => {
      const many = Array.from({ length: 101 }, (_, i) => `https://e.com/${i}`);
      expect(mod.parseLookupUrls(many).error).to.match(/at most 100/);
    });

    it('drops non-string/empty entries', () => {
      expect(mod.parseLookupUrls(['a', '', '  ', 3, null, 'b'])).to.deep.equal({ urls: ['a', 'b'] });
    });
  });

  describe('parseLookupStatus', () => {
    const valid = ['NEW', 'IGNORED'];
    it('returns [] when absent', () => {
      expect(mod.parseLookupStatus(undefined, valid)).to.deep.equal({ statuses: [] });
    });
    it('rejects unknown values', () => {
      expect(mod.parseLookupStatus('NEW,BOGUS', valid).error).to.match(/Invalid status/);
    });
    it('parses comma-separated values', () => {
      expect(mod.parseLookupStatus('NEW, IGNORED', valid)).to.deep.equal({ statuses: ['NEW', 'IGNORED'] });
    });
  });

  describe('parseLookupPagination', () => {
    it('defaults the limit', () => {
      expect(mod.parseLookupPagination({})).to.deep.equal({ limit: 100, cursorKey: null });
    });
    it('rejects out-of-range / non-integer limits', () => {
      expect(mod.parseLookupPagination({ limit: '0' }).error).to.match(/between 1 and 100/);
      expect(mod.parseLookupPagination({ limit: '101' }).error).to.match(/between 1 and 100/);
      expect(mod.parseLookupPagination({ limit: 'abc' }).error).to.match(/between 1 and 100/);
    });
    it('accepts a valid limit', () => {
      expect(mod.parseLookupPagination({ limit: '25' })).to.deep.equal({ limit: 25, cursorKey: null });
    });
    it('rejects a malformed cursor', () => {
      expect(mod.parseLookupPagination({ cursor: '!!!not-base64!!!' }).error).to.equal('Invalid cursor');
    });
    it('rejects a well-formed cursor with the wrong shape', () => {
      const bad = Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64url');
      expect(mod.parseLookupPagination({ cursor: bad }).error).to.equal('Invalid cursor');
    });
    it('accepts a valid cursor', () => {
      const good = Buffer.from(JSON.stringify({ k: 'abc' }), 'utf8').toString('base64url');
      expect(mod.parseLookupPagination({ cursor: good })).to.deep.equal({ limit: 100, cursorKey: { k: 'abc' } });
    });
  });

  // ---- lookupByUrl: opportunities ------------------------------------------

  describe('lookupByUrl (opportunities)', () => {
    it('returns a normalized page with no-match URLs kept and the data blob omitted', async () => {
      lookupStub.resolves(rowsFor({ 'https://example.com/a': ['o1'] }));
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://example.com/a', 'https://example.com/miss'],
        fetchEntities: fetchFrom([opp('o1')]),
      }));

      expect(response.results).to.deep.equal([
        { url: 'https://example.com/a', opportunityIds: ['o1'] },
        { url: 'https://example.com/miss', opportunityIds: [] },
      ]);
      expect(response.opportunities.o1).to.deep.equal({
        id: 'o1', type: 'cited-analysis', status: 'NEW', title: 't-o1', updatedAt: '2026-01-01',
      });
      expect(response.opportunities.o1).to.not.have.property('data');
      expect(response.pagination).to.deep.equal({ limit: 100, cursor: null, hasMore: false });
      expect(response).to.not.have.property('unmatchedUrls');
    });

    it('hides IGNORED opportunities by default and can request them explicitly', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o1', 'o2'] }));
      const entities = fetchFrom([opp('o1', 'NEW'), opp('o2', 'IGNORED')]);

      const def = await mod.lookupByUrl({}, oppCfg({ rawUrls: ['https://e.com/a'], fetchEntities: entities }));
      expect(Object.keys(def.response.opportunities)).to.deep.equal(['o1']);
      expect(def.response.results[0].opportunityIds).to.deep.equal(['o1']);

      const ignored = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], params: { status: 'IGNORED' }, fetchEntities: entities,
      }));
      expect(Object.keys(ignored.response.opportunities)).to.deep.equal(['o2']);
    });

    it('surfaces validation errors (urls / status / limit)', async () => {
      expect((await mod.lookupByUrl({}, oppCfg({ rawUrls: 'nope' }))).error).to.match(/must be an array/);
      expect((await mod.lookupByUrl({}, oppCfg({ rawUrls: ['a'], params: { status: 'BOGUS' } }))).error).to.match(/Invalid status/);
      expect((await mod.lookupByUrl({}, oppCfg({ rawUrls: ['a'], params: { limit: '0' } }))).error).to.match(/between 1 and 100/);
    });

    it('applies an explicit fields projection including the data blob', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o1'] }));
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], params: { fields: 'id,type,data' }, fetchEntities: fetchFrom([opp('o1')]),
      }));
      expect(response.opportunities.o1).to.deep.equal({ id: 'o1', type: 'cited-analysis', data: { big: 'o1' } });
    });

    it('returns an error for an unknown fields value', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o1'] }));
      const { error } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], params: { fields: 'nope' }, fetchEntities: fetchFrom([opp('o1')]),
      }));
      expect(error).to.match(/Invalid fields: nope/);
    });

    it('paginates over the immutable id key', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o3', 'o1', 'o2'] }));
      const entities = fetchFrom([opp('o1'), opp('o2'), opp('o3')]);

      const page1 = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], params: { limit: '2' }, fetchEntities: entities,
      }));
      expect(Object.keys(page1.response.opportunities)).to.deep.equal(['o1', 'o2']);
      expect(page1.response.pagination.hasMore).to.equal(true);
      expect(page1.response.pagination.cursor).to.be.a('string');
      // results reference only the current page
      expect(page1.response.results[0].opportunityIds).to.deep.equal(['o1', 'o2']);

      const page2 = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], params: { limit: '2', cursor: page1.response.pagination.cursor }, fetchEntities: entities,
      }));
      expect(Object.keys(page2.response.opportunities)).to.deep.equal(['o3']);
      expect(page2.response.pagination.hasMore).to.equal(false);
      expect(page2.response.pagination.cursor).to.equal(null);
    });

    it('returns an empty response for an empty / all-invalid url list without querying', async () => {
      const { response } = await mod.lookupByUrl({}, oppCfg({ rawUrls: ['', null, 7] }));
      expect(response).to.deep.equal({
        results: [], opportunities: {}, pagination: { limit: 100, cursor: null, hasMore: false },
      });
      expect(lookupStub).to.not.have.been.called;
    });

    it('returns all no-match results when the index has no rows for the URLs', async () => {
      lookupStub.resolves([]);
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a', 'https://e.com/b'], fetchEntities: fetchFrom([opp('o1')]),
      }));
      expect(response.results).to.deep.equal([
        { url: 'https://e.com/a', opportunityIds: [] },
        { url: 'https://e.com/b', opportunityIds: [] },
      ]);
      expect(response.opportunities).to.deep.equal({});
    });

    it('treats a matched-but-unhydratable id as a no-match', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['ghost'] }));
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'], fetchEntities: fetchFrom([]),
      }));
      expect(response.results[0].opportunityIds).to.deep.equal([]);
      expect(response.opportunities).to.deep.equal({});
    });

    it('keeps duplicate input URLs as separate result entries', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o1'] }));
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a', 'https://e.com/a'], fetchEntities: fetchFrom([opp('o1')]),
      }));
      expect(response.results).to.have.length(2);
      expect(response.results[0]).to.deep.equal(response.results[1]);
    });
  });

  // ---- lookupByUrl: suggestions --------------------------------------------

  describe('lookupByUrl (suggestions)', () => {
    it('adds unmatchedUrls on the first page, force-includes opportunityId, and drops no-match URLs from results', async () => {
      lookupStub.resolves(rowsFor({
        'https://e.com/a': ['s1'],
        'https://e.com/b': ['skip1'],
      }));
      const entities = fetchFrom([sugg('s1', 'op1'), sugg('skip1', 'op1', 'SKIPPED')]);
      const { response } = await mod.lookupByUrl({}, suggCfg({
        rawUrls: ['https://e.com/a', 'https://e.com/b', 'https://e.com/miss'],
        fetchEntities: entities,
      }));

      expect(response.results).to.deep.equal([{ url: 'https://e.com/a', suggestionIds: ['s1'] }]);
      expect(response.suggestions.s1).to.deep.equal({
        id: 's1', opportunityId: 'op1', type: 'CONTENT_UPDATE', status: 'NEW', rank: 1, updatedAt: '2026-01-01',
      });
      // b matched only a SKIPPED (hidden) suggestion, miss matched nothing -> both unmatched
      expect(response.unmatchedUrls).to.deep.equal(['https://e.com/b', 'https://e.com/miss']);
    });

    it('force-includes opportunityId even under a fields projection that omits it', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['s1'] }));
      const { response } = await mod.lookupByUrl({}, suggCfg({
        rawUrls: ['https://e.com/a'], params: { fields: 'id,type' }, fetchEntities: fetchFrom([sugg('s1', 'op1')]),
      }));
      expect(response.suggestions.s1).to.deep.equal({ id: 's1', type: 'CONTENT_UPDATE', opportunityId: 'op1' });
    });

    it('paginates over (opportunityId, id) and omits unmatchedUrls on later pages', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['s2', 's1', 's3'] }));
      // sort key is `${opportunityId}|${id}`: op1|s1, op1|s2, op2|s3
      const entities = fetchFrom([sugg('s1', 'op1'), sugg('s2', 'op1'), sugg('s3', 'op2')]);

      const page1 = await mod.lookupByUrl({}, suggCfg({
        rawUrls: ['https://e.com/a'], params: { limit: '2' }, fetchEntities: entities,
      }));
      expect(Object.keys(page1.response.suggestions)).to.deep.equal(['s1', 's2']);
      expect(page1.response.pagination.hasMore).to.equal(true);
      expect(page1.response).to.have.property('unmatchedUrls');

      const page2 = await mod.lookupByUrl({}, suggCfg({
        rawUrls: ['https://e.com/a'], params: { limit: '2', cursor: page1.response.pagination.cursor }, fetchEntities: entities,
      }));
      expect(Object.keys(page2.response.suggestions)).to.deep.equal(['s3']);
      expect(page2.response.pagination.hasMore).to.equal(false);
      expect(page2.response).to.not.have.property('unmatchedUrls');
    });

    it('returns an empty first-page response (with empty unmatchedUrls) for an empty url list', async () => {
      const { response } = await mod.lookupByUrl({}, suggCfg({ rawUrls: [] }));
      expect(response).to.deep.equal({
        results: [],
        suggestions: {},
        pagination: { limit: 100, cursor: null, hasMore: false },
        unmatchedUrls: [],
      });
    });
  });

  // ---- lookupByUrl: filterEntities hook ------------------------------------

  describe('lookupByUrl filterEntities hook', () => {
    it('narrows the hydrated set before status-filter and pagination (opportunities)', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['o1', 'o2'] }));
      const { response } = await mod.lookupByUrl({}, oppCfg({
        rawUrls: ['https://e.com/a'],
        fetchEntities: fetchFrom([opp('o1'), opp('o2')]),
        filterEntities: (list) => list.filter((e) => e.id !== 'o2'),
      }));
      expect(Object.keys(response.opportunities)).to.deep.equal(['o1']);
      expect(response.results[0].opportunityIds).to.deep.equal(['o1']);
    });

    it('awaits an async hook and counts a filtered-out suggestion as unmatched', async () => {
      lookupStub.resolves(rowsFor({ 'https://e.com/a': ['s1'] }));
      const { response } = await mod.lookupByUrl({}, suggCfg({
        rawUrls: ['https://e.com/a'],
        fetchEntities: fetchFrom([sugg('s1', 'op1')]),
        filterEntities: async (list) => list.filter((e) => e.opportunityId !== 'op1'),
      }));
      expect(response.suggestions).to.deep.equal({});
      expect(response.results).to.deep.equal([]);
      expect(response.unmatchedUrls).to.deep.equal(['https://e.com/a']);
    });
  });
});
