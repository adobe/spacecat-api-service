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

/* eslint-disable prefer-promise-reject-errors -- AI Visibility competitors tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  handleCompetitorsMetrics,
} from '../../../../src/support/ai-visibility/handlers/competitors.js';

describe('AI Visibility – competitors handlers', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      crMetricsClient: { stats: sandbox.stub() },
    };
  });

  afterEach(() => sandbox.restore());

  /* ------------------------------------------------------------------ */
  /*  handleCompetitorsMetrics                                           */
  /* ------------------------------------------------------------------ */
  describe('handleCompetitorsMetrics', () => {
    it('returns 400 when domain is missing', async () => {
      const sp = new URLSearchParams('');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_domain');
    });

    it('returns 400 when competitors are missing', async () => {
      const sp = new URLSearchParams('domain=example.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missing_competitors');
    });

    it('returns 200 with competitor metrics', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [
          {
            brand: { domain: 'comp.com', name: 'Comp' },
            byDate: [{
              date: '2026-03', visibility: 50, mentions: 10, audience: 100, ownedSources: 5,
            }],
          },
        ],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.have.length(1);
      expect(res.body.byBrand[0].brand.domain).to.equal('comp.com');
      expect(res.body.byBrand[0].byDate[0].visibility).to.equal(50);
    });

    it('returns empty by_brand on ConnectError NotFound', async () => {
      clients.crMetricsClient.stats.rejects(new ConnectError('not found', Code.NotFound));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('returns empty by_brand on message-pattern NotFound', async () => {
      clients.crMetricsClient.stats.rejects(new Error('Code: NotFound - no data'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('rethrows non-NotFound errors', async () => {
      clients.crMetricsClient.stats.rejects(new Error('internal'));
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsMetrics(sp, clients);
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.equal('internal');
      }
    });

    it('passes engine filter and snapshot date', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&engine=chatgpt&gapSnapshotDate=2026-03-15');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.crMetricsClient.stats.firstCall.args[0];
      expect(call).to.have.property('llm');
      expect(call).to.have.property('dateRange');
    });

    it('passes metrics_snapshot_date when gap_snapshot_date is absent', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com&metricsSnapshotDate=2026-04-01');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      const call = clients.crMetricsClient.stats.firstCall.args[0];
      expect(call).to.have.property('dateRange');
    });

    it('maps brand with missing name (falls back to domain)', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{
          brand: { domain: 'comp.com' },
          byDate: [{
            date: '2026-03', visibility: 1, mentions: 1, audience: 1, ownedSources: 0,
          }],
        }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].brand.name).to.equal('comp.com');
    });

    it('maps brand with missing brand object', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{ byDate: [] }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].brand.domain).to.equal('');
      expect(res.body.byBrand[0].brand.name).to.equal('');
    });

    it('maps brand with missing byDate', async () => {
      clients.crMetricsClient.stats.resolves({
        byBrand: [{ brand: { domain: 'd.com', name: 'D' } }],
      });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand[0].byDate).to.deep.equal([]);
    });

    it('handles error with no message property', async () => {
      const err = 'plain string error';
      clients.crMetricsClient.stats.rejects(err);
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      try {
        await handleCompetitorsMetrics(sp, clients);
        expect.fail('should throw');
      } catch { /* expected */ }
    });

    it('handles no snapshot date', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
    });

    it('handles raw.byBrand being undefined', async () => {
      clients.crMetricsClient.stats.resolves({});
      const sp = new URLSearchParams('domain=example.com&competitors=comp.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.body.byBrand).to.deep.equal([]);
    });

    it('handles repeated competitor= params', async () => {
      clients.crMetricsClient.stats.resolves({ byBrand: [] });
      const sp = new URLSearchParams('domain=example.com&competitor=a.com&competitor=b.com');
      const res = await handleCompetitorsMetrics(sp, clients);
      expect(res.status).to.equal(200);
      expect(clients.crMetricsClient.stats.firstCall.args[0].competitors).to.have.length(2);
    });
  });
});
