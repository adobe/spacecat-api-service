/* eslint-disable header/header */
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use it except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import { syncBrandConfig } from '../../src/support/brand-presence-sync.js';

use(sinonChai);
use(chaiAsPromised);

describe('brand-presence-sync', () => {
  const ORG_ID = '11111111-1111-4111-8111-111111111111';

  describe('syncBrandConfig', () => {
    it('returns early when postgrestClient is missing', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      await syncBrandConfig({
        customerConfig: { customer: { brands: [{ name: 'Adobe' }] } },
        organizationId: ORG_ID,
        postgrestClient: null,
        log,
      });
      expect(log.info).to.not.have.been.called;
    });

    it('returns early when postgrestClient has no from method', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      await syncBrandConfig({
        customerConfig: { customer: { brands: [{ name: 'Adobe' }] } },
        organizationId: ORG_ID,
        postgrestClient: {},
        log,
      });
      expect(log.info).to.not.have.been.called;
    });

    it('returns early when no brands in config', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: { customer: { brands: [] } },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
      });

      expect(fromStub).to.not.have.been.called;
    });

    it('returns early when all brands have no name', async () => {
      const log = {
        debug: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: {
          customer: {
            brands: [{ name: '' }, { name: null }, {}],
          },
        },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
      });

      expect(log.error).to.have.been.called;
      expect(upsertStub).to.not.have.been.called;
    });

    it('upserts brands when postgrestClient is available', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: {
          customer: {
            brands: [
              {
                name: 'Adobe',
                status: 'active',
                origin: 'human',
                region: ['US', 'WW'],
                brandAliases: [{ name: 'ADBE' }],
                competitors: [{ name: 'Rival', url: 'https://rival.com' }],
                urls: [{ value: 'https://adobe.com' }],
              },
            ],
          },
        },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
        updatedBy: 'user@example.com',
      });

      expect(fromStub).to.have.been.calledWith('brands');
      expect(upsertStub).to.have.been.calledOnce;
      const [rows, options] = upsertStub.firstCall.args;
      expect(rows).to.have.lengthOf(1);
      expect(rows[0]).to.deep.include({
        organization_id: ORG_ID,
        name: 'Adobe',
        status: 'active',
        origin: 'human',
        regions: ['US', 'WW'],
        aliases: ['ADBE'],
        competitors: ['Rival'],
        owned_urls: ['https://adobe.com'],
        updated_by: 'user@example.com',
      });
      expect(options).to.deep.equal({ onConflict: 'organization_id,name' });
      expect(log.info).to.have.been.calledWith(`Synced 1 brand(s) to Postgres for organization: ${ORG_ID}`);
    });

    it('maps string values in arrays (brandAliases, competitors, urls, etc. as strings)', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: {
          customer: {
            brands: [
              {
                name: 'Adobe',
                brandAliases: ['ADBE', 'Adobe Inc'],
                competitors: ['Salesforce', 'Microsoft'],
                region: ['US', 'WW'],
                urls: ['https://adobe.com'],
                socialAccounts: [{ handle: '@adobe' }, { url: 'https://twitter.com/adobe' }],
                earnedContent: [{ url: 'https://techcrunch.com' }, { name: 'Forbes' }],
              },
            ],
          },
        },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
      });

      const [rows] = upsertStub.firstCall.args;
      expect(rows[0].aliases).to.deep.equal(['ADBE', 'Adobe Inc']);
      expect(rows[0].competitors).to.deep.equal(['Salesforce', 'Microsoft']);
      expect(rows[0].regions).to.deep.equal(['US', 'WW']);
      expect(rows[0].owned_urls).to.deep.equal(['https://adobe.com']);
      expect(rows[0].social).to.deep.equal(['@adobe', 'https://twitter.com/adobe']);
      expect(rows[0].earned_sources).to.deep.equal(['https://techcrunch.com', 'Forbes']);
    });

    it('maps region with non-string values via String()', async () => {
      const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: {
          customer: {
            brands: [{ name: 'Adobe', region: [123, 'US'] }],
          },
        },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
      });

      const [rows] = upsertStub.firstCall.args;
      expect(rows[0].regions).to.deep.equal(['123', 'US']);
    });

    it('skips brands without name and logs error', async () => {
      const log = {
        debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      };
      const upsertStub = sinon.stub().resolves({ data: null, error: null });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await syncBrandConfig({
        customerConfig: {
          customer: {
            brands: [
              { name: 'Valid' },
              { id: 'brand-2', name: '' },
              { name: null },
            ],
          },
        },
        organizationId: ORG_ID,
        postgrestClient: { from: fromStub },
        log,
      });

      expect(log.error).to.have.been.calledWith(
        `Brand(s) without name skipped for organization ${ORG_ID}:`,
        ['brand-2', '(no id)'],
      );
      const [rows] = upsertStub.firstCall.args;
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].name).to.equal('Valid');
    });

    it('throws and logs request on PostgREST error', async () => {
      const log = {
        debug: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      };
      const customerConfig = { customer: { brands: [{ name: 'Adobe' }] } };
      const upsertStub = sinon.stub().resolves({ data: null, error: { message: 'Conflict' } });
      const fromStub = sinon.stub().returns({ upsert: upsertStub });

      await expect(
        syncBrandConfig({
          customerConfig,
          organizationId: ORG_ID,
          postgrestClient: { from: fromStub },
          log,
        }),
      ).to.be.rejectedWith('Brand sync failed: Conflict');

      expect(log.error).to.have.been.calledWith(
        `Brand presence sync failed for organization ${ORG_ID}`,
        { error: { message: 'Conflict' }, organizationId: ORG_ID, customerConfig },
      );
    });
  });
});
