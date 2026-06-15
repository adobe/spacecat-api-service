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
import sinonChai from 'sinon-chai';

import {
  mapPublishStatus,
  projectToSlice,
  listChildMarkets,
  resolveChildProject,
  buildChildSliceProjectMap,
  sliceKey,
} from '../../../src/support/serenity/child-projects.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'brand-1';
const WS = 'child-ws-1';

function project({
  id = 'p1', location = 2276, language = 'de', publishStatus = 'live',
  createdAt = '2026-06-01T00:00:00Z', updatedAt = '2026-06-02T00:00:00Z',
} = {}) {
  // Mirrors the live v1 list item shape: nested location/language objects,
  // updated_at present, created_at usually absent (passed here for mapping
  // assertions; the no-created_at path is covered separately).
  return {
    id,
    publish_status: publishStatus,
    created_at: createdAt,
    updated_at: updatedAt,
    settings: {
      ai: {
        location: location === null ? null : { id: location, name: 'X' },
        language: language === null ? null : { id: 'lang-uuid', name: language },
      },
    },
  };
}

describe('child-projects', () => {
  const log = { error: sinon.spy() };
  afterEach(() => sinon.restore());

  describe('mapPublishStatus', () => {
    it('maps the five upstream states 1:1 (initial_publish_failed → publish_failed)', () => {
      expect(mapPublishStatus('draft')).to.equal('draft');
      expect(mapPublishStatus('publishing')).to.equal('publishing');
      expect(mapPublishStatus('initial_publish_failed')).to.equal('publish_failed');
      expect(mapPublishStatus('live')).to.equal('live');
      expect(mapPublishStatus('live_with_unpublished_updates')).to.equal('live_with_unpublished_updates');
    });
    it('defaults unknown/absent to draft', () => {
      expect(mapPublishStatus(undefined)).to.equal('draft');
      expect(mapPublishStatus('weird')).to.equal('draft');
    });
  });

  describe('projectToSlice', () => {
    it('maps a project to the elmo DTO + additive status/semrushProjectId', () => {
      expect(projectToSlice(project(), BRAND)).to.deep.equal({
        brandId: BRAND,
        geoTargetId: 2276,
        languageCode: 'de',
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-02T00:00:00Z',
        status: 'live',
        semrushProjectId: 'p1',
      });
    });
    it('lowercases the language and nulls an invalid geo', () => {
      const s = projectToSlice(project({ location: 'x', language: 'EN' }), BRAND);
      expect(s.geoTargetId).to.equal(null);
      expect(s.languageCode).to.equal('en');
    });

    it('maps createdAt to null and updatedAt to published_at when the live item omits both (live shape)', () => {
      const live = {
        id: 'p9',
        publish_status: 'live',
        published_at: '2026-06-05T00:00:00Z',
        settings: { ai: { location: { id: 2840 }, language: { name: 'en' } } },
      };
      const s = projectToSlice(live, BRAND);
      expect(s.createdAt).to.equal(null);
      expect(s.updatedAt).to.equal('2026-06-05T00:00:00Z');
      expect(s.status).to.equal('live');
    });
  });

  describe('listChildMarkets', () => {
    it('maps each listed project and drops slices with no geo/lang', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [
            project({ id: 'a', location: 2276, language: 'de' }),
            project({ id: 'b', location: 2840, language: 'en' }),
            project({ id: 'bad', location: null, language: null }),
          ],
        }),
      };

      const result = await listChildMarkets(transport, WS, BRAND);

      expect(result).to.have.length(2);
      expect(result.map((m) => m.semrushProjectId)).to.deep.equal(['a', 'b']);
      expect(transport.listProjects).to.have.been.calledOnceWithExactly(WS);
    });

    it('returns an empty array for an empty/absent listing', async () => {
      const transport = { listProjects: sinon.stub().resolves(null) };
      expect(await listChildMarkets(transport, WS, BRAND)).to.deep.equal([]);
    });
  });

  describe('resolveChildProject', () => {
    it('returns the matching project for a slice', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({ items: [project({ id: 'match' })] }),
      };
      const p = await resolveChildProject(transport, WS, 2276, 'de', log);
      expect(p.id).to.equal('match');
    });

    it('returns null when no project matches the slice', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({ items: [project({ location: 2840, language: 'en' })] }),
      };
      expect(await resolveChildProject(transport, WS, 2276, 'de', log)).to.equal(null);
    });

    it('picks the oldest created_at and alerts on a duplicate slice', async () => {
      const alert = sinon.spy();
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [
            project({ id: 'newer', createdAt: '2026-06-10T00:00:00Z' }),
            project({ id: 'older', createdAt: '2026-06-01T00:00:00Z' }),
          ],
        }),
      };
      const p = await resolveChildProject(transport, WS, 2276, 'de', { error: alert });
      expect(p.id).to.equal('older');
      expect(alert).to.have.been.calledOnce;
    });

    it('orders duplicates by updated_at when created_at is absent (live shape)', async () => {
      const mk = (id, updatedAt) => ({
        id,
        publish_status: 'live',
        updated_at: updatedAt,
        settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
      });
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [mk('newer', '2026-06-10T00:00:00Z'), mk('older', '2026-06-01T00:00:00Z')],
        }),
      };
      const p = await resolveChildProject(transport, WS, 2276, 'de', { error: sinon.spy() });
      expect(p.id).to.equal('older');
    });
  });

  describe('sliceKey', () => {
    it('lowercases the language and joins on a colon', () => {
      expect(sliceKey(2840, 'EN')).to.equal('2840:en');
    });
    it('renders a missing language as an empty subkey', () => {
      expect(sliceKey(2840, null)).to.equal('2840:');
    });
  });

  describe('buildChildSliceProjectMap', () => {
    it('maps each (geo, lang) slice to its project from one listing', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [
            project({ id: 'us', location: 2840, language: 'en' }),
            project({ id: 'de', location: 2276, language: 'de' }),
          ],
        }),
      };
      const map = await buildChildSliceProjectMap(transport, WS, log);
      expect(transport.listProjects).to.have.been.calledOnce;
      expect(map.get('2840:en').id).to.equal('us');
      expect(map.get('2276:de').id).to.equal('de');
    });

    it('drops projects that do not resolve to a slice', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [project({ id: 'bad', location: null, language: null })],
        }),
      };
      const map = await buildChildSliceProjectMap(transport, WS, log);
      expect(map.size).to.equal(0);
    });

    it('keeps the oldest on a duplicate slice and alerts', async () => {
      const alert = sinon.spy();
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [
            project({
              id: 'newer', location: 2840, language: 'en', createdAt: '2026-06-05T00:00:00Z',
            }),
            project({
              id: 'older', location: 2840, language: 'en', createdAt: '2026-06-01T00:00:00Z',
            }),
          ],
        }),
      };
      const map = await buildChildSliceProjectMap(transport, WS, { error: alert });
      expect(map.get('2840:en').id).to.equal('older');
      expect(alert).to.have.been.calledOnce;
    });
  });
});
