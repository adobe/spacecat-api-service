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
  normalizeDomain,
  collectCompetitorDomains,
  removedCompetitorDomains,
  mergeCiCompetitors,
  syncCiCompetitorsForProject,
  syncCiCompetitorsAcrossMarkets,
} from '../../../src/support/serenity/ci-competitors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';
const PID = 'proj-1';

describe('ci-competitors helpers', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  describe('normalizeDomain', () => {
    it('strips scheme, www., path, and lower-cases', () => {
      expect(normalizeDomain('https://WWW.Example.com/path?q=1')).to.equal('example.com');
      expect(normalizeDomain('http://example.com')).to.equal('example.com');
    });

    it('accepts a bare host', () => {
      expect(normalizeDomain('Example.COM')).to.equal('example.com');
      expect(normalizeDomain('www.sub.example.com')).to.equal('sub.example.com');
    });

    it('returns null for empty or unusable input', () => {
      expect(normalizeDomain('')).to.equal(null);
      expect(normalizeDomain(null)).to.equal(null);
      expect(normalizeDomain('   ')).to.equal(null);
    });
  });

  describe('collectCompetitorDomains', () => {
    it('region-filters, extracts domains, de-dupes, and skips url-less', () => {
      const competitors = [
        { url: 'https://a.com', regions: ['us'] },
        { url: 'https://b.com', regions: ['de'] }, // filtered out for us
        { url: 'https://a.com/other', regions: [] }, // dup of a.com
        { url: '', regions: [] }, // skipped (no url)
        { name: 'no-url', regions: [] }, // skipped (no url)
        { url: 'https://c.com' }, // region-less → included
      ];
      expect(collectCompetitorDomains(competitors, 'us')).to.deep.equal(['a.com', 'c.com']);
    });

    it('returns [] for empty / non-array input', () => {
      expect(collectCompetitorDomains(null, 'us')).to.deep.equal([]);
      expect(collectCompetitorDomains([], 'us')).to.deep.equal([]);
    });
  });

  describe('removedCompetitorDomains', () => {
    it('returns domains present in old but not new (region-agnostic)', () => {
      const oldC = [
        { url: 'https://a.com', regions: ['us'] },
        { url: 'https://b.com', regions: ['de'] },
      ];
      const newC = [{ url: 'https://a.com', regions: ['us'] }];
      expect(removedCompetitorDomains(oldC, newC)).to.deep.equal(['b.com']);
    });

    it('returns [] when nothing was removed', () => {
      const c = [{ url: 'https://a.com' }];
      expect(removedCompetitorDomains(c, c)).to.deep.equal([]);
      expect(removedCompetitorDomains([], [{ url: 'https://a.com' }])).to.deep.equal([]);
    });
  });

  describe('mergeCiCompetitors', () => {
    it('keeps existing (preserving color), adds ours, de-dupes', () => {
      const existing = [
        { id: '1', domain: 'auto.com', color: '#111' }, // Semrush-auto, kept
        { id: '2', domain: 'a.com', color: '#222' }, // ours, already there → keep color
      ];
      const merged = mergeCiCompetitors(existing, ['a.com', 'new.com'], []);
      expect(merged).to.deep.equal([
        { domain: 'auto.com', color: '#111' },
        { domain: 'a.com', color: '#222' },
        { domain: 'new.com' },
      ]);
    });

    it('drops only the domains we removed — never a Semrush-auto one', () => {
      const existing = [
        { domain: 'auto.com', color: '#111' }, // not ours, must stay
        { domain: 'gone.com', color: '#222' }, // ours, removed
      ];
      const merged = mergeCiCompetitors(existing, [], ['gone.com']);
      expect(merged).to.deep.equal([{ domain: 'auto.com', color: '#111' }]);
    });

    it('de-dupes existing entries by normalized domain', () => {
      const existing = [
        { domain: 'https://www.a.com/x', color: '#1' },
        { domain: 'a.com', color: '#2' },
      ];
      const merged = mergeCiCompetitors(existing, [], []);
      expect(merged).to.deep.equal([{ domain: 'https://www.a.com/x', color: '#1' }]);
    });
  });

  describe('syncCiCompetitorsForProject', () => {
    function makeTransport(existing) {
      return {
        getProject: sandbox.stub().resolves({ settings: { ci: { competitors: existing } } }),
        updateCiCompetitors: sandbox.stub().resolves({ ci_competitors: [] }),
      };
    }

    it('PUTs the merged list when the set changed', async () => {
      const transport = makeTransport([{ domain: 'auto.com', color: '#111' }]);
      const result = await syncCiCompetitorsForProject(transport, WS, PID, ['a.com'], [], undefined);
      expect(result).to.deep.equal({ changed: true });
      expect(transport.updateCiCompetitors).to.have.been.calledOnceWith(WS, PID, [
        { domain: 'auto.com', color: '#111' },
        { domain: 'a.com' },
      ]);
    });

    it('does NOT PUT when the merged set matches the existing set', async () => {
      const transport = makeTransport([{ domain: 'a.com', color: '#111' }]);
      const result = await syncCiCompetitorsForProject(transport, WS, PID, ['a.com'], [], undefined);
      expect(result).to.deep.equal({ changed: false });
      expect(transport.updateCiCompetitors).to.not.have.been.called;
    });

    it('PUTs (removing) when we removed a domain that exists upstream', async () => {
      const transport = makeTransport([
        { domain: 'a.com', color: '#1' },
        { domain: 'gone.com', color: '#2' },
      ]);
      await syncCiCompetitorsForProject(transport, WS, PID, ['a.com'], ['gone.com'], undefined);
      expect(transport.updateCiCompetitors).to.have.been.calledOnceWith(WS, PID, [
        { domain: 'a.com', color: '#1' },
      ]);
    });

    it('tolerates a project with no ci settings (treats as empty)', async () => {
      const transport = {
        getProject: sandbox.stub().resolves({ settings: {} }),
        updateCiCompetitors: sandbox.stub().resolves({}),
      };
      await syncCiCompetitorsForProject(transport, WS, PID, ['a.com'], [], undefined);
      expect(transport.updateCiCompetitors).to.have.been.calledOnceWith(WS, PID, [{ domain: 'a.com' }]);
    });

    it('propagates a PUT failure (hard-fail)', async () => {
      const transport = makeTransport([]);
      transport.updateCiCompetitors.rejects(new SerenityTransportError(500, 'boom'));
      await expect(syncCiCompetitorsForProject(transport, WS, PID, ['a.com'], [], undefined))
        .to.be.rejectedWith('boom');
    });
  });

  describe('syncCiCompetitorsAcrossMarkets', () => {
    function projectWith(id, country) {
      return { id, settings: { ai: { country: { code: country } } } };
    }

    it('region-filters per market, PUTs changed projects, and republishes them', async () => {
      const competitors = [
        { url: 'https://us-only.com', regions: ['us'] },
        { url: 'https://de-only.com', regions: ['de'] },
      ];
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [projectWith('p-us', 'us'), projectWith('p-de', 'de')],
        }),
        getProject: sandbox.stub().resolves({ settings: { ci: { competitors: [] } } }),
        updateCiCompetitors: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().resolves({}),
      };

      const result = await syncCiCompetitorsAcrossMarkets(
        transport,
        competitors,
        [],
        WS,
        undefined,
      );

      // us project gets us-only.com; de project gets de-only.com.
      expect(transport.updateCiCompetitors).to.have.been.calledWith(WS, 'p-us', [{ domain: 'us-only.com' }]);
      expect(transport.updateCiCompetitors).to.have.been.calledWith(WS, 'p-de', [{ domain: 'de-only.com' }]);
      expect(transport.publishProject).to.have.been.calledTwice;
      expect(result).to.deep.equal({ markets: 2, changed: 2 });
    });

    it('skips republish for an unchanged project and skips region-less projects', async () => {
      const transport = {
        listProjects: sandbox.stub().resolves({
          items: [projectWith('p-us', 'us'), { id: 'p-x', settings: { ai: {} } }],
        }),
        getProject: sandbox.stub().resolves({ settings: { ci: { competitors: [{ domain: 'a.com' }] } } }),
        updateCiCompetitors: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().resolves({}),
      };
      const result = await syncCiCompetitorsAcrossMarkets(transport, [{ url: 'https://a.com' }], [], WS, undefined);
      expect(transport.updateCiCompetitors).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
      expect(result).to.deep.equal({ markets: 1, changed: 0 });
    });

    it('tolerates a quota 405 on republish (best-effort)', async () => {
      const warn = sandbox.stub();
      const transport = {
        listProjects: sandbox.stub().resolves({ items: [projectWith('p-us', 'us')] }),
        getProject: sandbox.stub().resolves({ settings: { ci: { competitors: [] } } }),
        updateCiCompetitors: sandbox.stub().resolves({}),
        publishProject: sandbox.stub().rejects(new SerenityTransportError(405, 'quota')),
      };
      const result = await syncCiCompetitorsAcrossMarkets(transport, [{ url: 'https://a.com' }], [], WS, { warn, info: () => {} });
      expect(result).to.deep.equal({ markets: 1, changed: 1 });
      expect(warn).to.have.been.called;
    });
  });
});
