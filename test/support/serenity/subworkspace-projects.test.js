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
  listMarkets,
  resolveProject,
  buildSliceProjectMap,
  sliceKey,
} from '../../../src/support/serenity/subworkspace-projects.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'brand-1';
const WS = 'subworkspace-ws-1';

function project({
  id = 'p1', location = 2276, language = 'de', country = null, publishStatus = 'live',
  createdAt = '2026-06-01T00:00:00Z', updatedAt = '2026-06-02T00:00:00Z',
  domain = 'example.com',
} = {}) {
  // Mirrors the live v1 list item shape: nested location/language objects,
  // updated_at present, created_at usually absent (passed here for mapping
  // assertions; the no-created_at path is covered separately). `country` mirrors
  // the Semrush-UI shape where settings.ai.location.id is null but a country is
  // set (settings.ai.country.code); omitted by default. `domain` is the project's
  // top-level primary host (null to mirror a project that carries none).
  return {
    id,
    publish_status: publishStatus,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(domain === null ? {} : { domain }),
    settings: {
      ai: {
        location: location === null ? null : { id: location, name: 'X' },
        language: language === null ? null : { id: 'lang-uuid', name: language },
        ...(country === null ? {} : { country: { code: country, name: 'X' } }),
      },
    },
  };
}

describe('subworkspace-projects', () => {
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
        domain: 'example.com',
      });
    });
    it('surfaces the project domain, and nulls it when the project carries none', () => {
      expect(projectToSlice(project({ domain: 'acme.com' }), BRAND).domain).to.equal('acme.com');
      expect(projectToSlice(project({ domain: null }), BRAND).domain).to.equal(null);
    });
    it('lowercases the language and nulls an invalid geo', () => {
      const s = projectToSlice(project({ location: 'x', language: 'EN' }), BRAND);
      expect(s.geoTargetId).to.equal(null);
      expect(s.languageCode).to.equal('en');
    });

    it('derives geoTargetId from the country code when location.id is null (Semrush-UI projects)', () => {
      // CH → 2000 + ISO numeric 756 = 2756.
      const s = projectToSlice(project({ location: null, country: 'ch', language: 'de' }), BRAND);
      expect(s.geoTargetId).to.equal(2756);
      expect(s.languageCode).to.equal('de');
    });

    it('prefers an explicit location.id over the country fallback', () => {
      const s = projectToSlice(project({ location: 2840, country: 'ch', language: 'en' }), BRAND);
      expect(s.geoTargetId).to.equal(2840);
    });

    it('nulls the geo when location.id is null and the country is unknown or absent', () => {
      expect(projectToSlice(project({ location: null, country: 'zz', language: 'de' }), BRAND).geoTargetId)
        .to.equal(null);
      expect(projectToSlice(project({ location: null, country: null, language: 'de' }), BRAND).geoTargetId)
        .to.equal(null);
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

  describe('listMarkets', () => {
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

      const result = await listMarkets(transport, WS, BRAND);

      expect(result).to.have.length(2);
      expect(result.map((m) => m.semrushProjectId)).to.deep.equal(['a', 'b']);
      expect(transport.listProjects).to.have.been.calledOnceWithExactly(WS);
    });

    it('keeps country-only projects (location.id null, country set) as markets', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [project({
            id: 'co', location: null, country: 'us', language: 'en',
          })],
        }),
      };
      const result = await listMarkets(transport, WS, BRAND);
      expect(result).to.have.length(1);
      expect(result[0].geoTargetId).to.equal(2840); // US → 2000 + 840
    });

    it('returns an empty array for an empty/absent listing', async () => {
      const transport = { listProjects: sinon.stub().resolves(null) };
      expect(await listMarkets(transport, WS, BRAND)).to.deep.equal([]);
    });
  });

  describe('resolveProject', () => {
    it('returns the matching project for a slice', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({ items: [project({ id: 'match' })] }),
      };
      const p = await resolveProject(transport, WS, 2276, 'de', log);
      expect(p.id).to.equal('match');
    });

    it('returns null when no project matches the slice', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({ items: [project({ location: 2840, language: 'en' })] }),
      };
      expect(await resolveProject(transport, WS, 2276, 'de', log)).to.equal(null);
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
      const p = await resolveProject(transport, WS, 2276, 'de', { error: alert });
      expect(p.id).to.equal('older');
      expect(alert).to.have.been.calledOnce;
    });

    it('ignores updated_at for ordering when created_at is absent (stable id tie-break)', async () => {
      // The live list view omits created_at. Ordering must NOT fall back to the
      // mutable updated_at — a write that bumps the canonical project's
      // updated_at would otherwise flip which duplicate is "oldest". With
      // created_at absent the immutable id is the sole tie-break, so the same
      // project wins regardless of updated_at. Here 'aaa' (lexically lowest id)
      // is given the NEWEST updated_at: the buggy updated_at fallback would have
      // picked 'zzz', the id-stable rule picks 'aaa'.
      const mk = (id, updatedAt) => ({
        id,
        publish_status: 'live',
        updated_at: updatedAt,
        settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
      });
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [mk('zzz', '2026-06-01T00:00:00Z'), mk('aaa', '2026-06-10T00:00:00Z')],
        }),
      };
      const p = await resolveProject(transport, WS, 2276, 'de', { error: sinon.spy() });
      expect(p.id).to.equal('aaa');
    });

    it('breaks ties deterministically by id when no timestamps are present', async () => {
      // Both timestamps absent: the id tie-break makes resolution deterministic
      // (lexically-lowest id wins) instead of listing-order-dependent.
      const mk = (id) => ({
        id,
        publish_status: 'draft',
        settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
      });
      const items = [mk('proj-b'), mk('proj-a')];
      const t1 = { listProjects: sinon.stub().resolves({ items }) };
      const t2 = { listProjects: sinon.stub().resolves({ items: [...items].reverse() }) };
      const a = await resolveProject(t1, WS, 2276, 'de', { error: sinon.spy() });
      const b = await resolveProject(t2, WS, 2276, 'de', { error: sinon.spy() });
      expect(a.id).to.equal('proj-a');
      expect(b.id).to.equal('proj-a');
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

  describe('buildSliceProjectMap', () => {
    it('maps each (geo, lang) slice to its project from one listing', async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [
            project({ id: 'us', location: 2840, language: 'en' }),
            project({ id: 'de', location: 2276, language: 'de' }),
          ],
        }),
      };
      const map = await buildSliceProjectMap(transport, WS, log);
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
      const map = await buildSliceProjectMap(transport, WS, log);
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
      const map = await buildSliceProjectMap(transport, WS, { error: alert });
      expect(map.get('2840:en').id).to.equal('older');
      expect(alert).to.have.been.calledOnce;
    });
  });
  describe('defensive branch coverage', () => {
    describe('orderKey via resolveProject duplicate sort', () => {
      it('fires both nullish fallbacks when projects have no created_at and no id', async () => {
        // Both created_at and id absent: String(undefined ?? '') = '' for both fields.
        // The duplicate-slice sort in resolveProject exercises orderKey on each project.
        const mkNoId = () => ({
          publish_status: 'draft',
          settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
        });
        const transport = {
          listProjects: sinon.stub().resolves({ items: [mkNoId(), mkNoId()] }),
        };
        const alert = sinon.spy();
        // Two identical sort keys => tie; either element is valid, must not throw.
        const p = await resolveProject(transport, WS, 2276, 'de', { error: alert });
        expect(p).to.be.an('object');
        expect(alert).to.have.been.calledOnce;
      });

      it('fires both nullish fallbacks in buildSliceProjectMap duplicate sort', async () => {
        const mkNoId = () => ({
          publish_status: 'draft',
          settings: { ai: { location: { id: 2840 }, language: { name: 'en' } } },
        });
        const transport = {
          listProjects: sinon.stub().resolves({ items: [mkNoId(), mkNoId()] }),
        };
        const alert = sinon.spy();
        const map = await buildSliceProjectMap(transport, WS, { error: alert });
        expect(map.size).to.equal(1);
        expect(alert).to.have.been.calledOnce;
      });
    });

    describe('projectToSlice defensive branches', () => {
      it('updatedAt picks published_at when updated_at is absent (middle ?? branch)', () => {
        // No updated_at but has published_at -> hits the middle ?? operand on line 103.
        const p = {
          id: 'p2',
          publish_status: 'draft',
          published_at: '2026-06-10T00:00:00Z',
          settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
        };
        const s = projectToSlice(p, BRAND);
        expect(s.updatedAt).to.equal('2026-06-10T00:00:00Z');
      });

      it('updatedAt is null when both updated_at and published_at are absent (null branch)', () => {
        // Neither updated_at nor published_at -> hits the trailing ?? null on line 103.
        const p = {
          id: 'p3',
          publish_status: 'draft',
          settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
        };
        const s = projectToSlice(p, BRAND);
        expect(s.updatedAt).to.equal(null);
      });

      it('semrushProjectId is null when id is absent or blank (else branch)', () => {
        // hasText(undefined) and hasText('') are both false -> null else on line 105.
        const noId = {
          publish_status: 'draft',
          settings: { ai: { location: { id: 2276 }, language: { name: 'de' } } },
        };
        expect(projectToSlice(noId, BRAND).semrushProjectId).to.equal(null);
        const blankId = { ...noId, id: '' };
        expect(projectToSlice(blankId, BRAND).semrushProjectId).to.equal(null);
      });
    });

    describe('buildSliceProjectMap with non-array listing', () => {
      it('treats listing {} (no items array) as empty and returns an empty Map', async () => {
        // Exercises the Array.isArray false branch on line 138.
        const transport = { listProjects: sinon.stub().resolves({}) };
        const map = await buildSliceProjectMap(transport, WS, log);
        expect(map.size).to.equal(0);
      });
    });

    describe('resolveProject with non-array listing and falsy languageCode', () => {
      it('returns null when listing has no items array', async () => {
        // Exercises the Array.isArray false branch on line 176.
        const transport = { listProjects: sinon.stub().resolves({}) };
        const result = await resolveProject(transport, WS, 2276, 'de', log);
        expect(result).to.equal(null);
      });

      it('uses null as wantLang when languageCode is undefined (falsy else branch)', async () => {
        // hasText(undefined) is false -> wantLang = null on line 177; a project
        // with no language (langOf returns null) then matches.
        const transport = {
          listProjects: sinon.stub().resolves({
            items: [project({ location: 2276, language: null })],
          }),
        };
        const result = await resolveProject(transport, WS, 2276, undefined, log);
        expect(result).to.not.equal(null);
        expect(result.settings.ai.language).to.equal(null);
      });

      it('uses null as wantLang when languageCode is empty string (falsy else branch)', async () => {
        // hasText('') is false -> wantLang = null on line 177.
        const transport = {
          listProjects: sinon.stub().resolves({
            items: [project({ location: 2276, language: null })],
          }),
        };
        const result = await resolveProject(transport, WS, 2276, '', log);
        expect(result).to.not.equal(null);
      });
    });
  });
});
