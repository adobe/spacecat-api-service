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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  isValidFeatureFlagName,
  listFeatureFlagsByOrgAndProduct,
  normalizeFeatureFlagProduct,
  readFeatureFlag,
  upsertFeatureFlag,
} from '../../src/support/feature-flags-storage.js';

use(chaiAsPromised);
use(sinonChai);

describe('feature-flags-storage', () => {
  const sandbox = sinon.createSandbox();
  const ORG = '123e4567-e89b-42d3-a456-426614174000';
  const BRAND = '223e4567-e89b-42d3-a456-426614174001';

  /**
   * Builds a `from('feature_flags').select().eq().eq().eq()` chain that resolves
   * to the given PostgREST result — the shape every org-row lookup uses.
   */
  function makeSelectChain(result) {
    const eq3 = sandbox.stub().resolves(result);
    const eq2 = sandbox.stub().returns({ eq: eq3 });
    const eq1 = sandbox.stub().returns({ eq: eq2 });
    const select = sandbox.stub().returns({ eq: eq1 });
    return {
      select, eq1, eq2, eq3,
    };
  }

  afterEach(() => sandbox.restore());

  describe('normalizeFeatureFlagProduct', () => {
    it('accepts uppercase ASO and LLMO', () => {
      expect(normalizeFeatureFlagProduct('ASO')).to.equal('ASO');
      expect(normalizeFeatureFlagProduct('LLMO')).to.equal('LLMO');
    });

    it('normalizes case', () => {
      expect(normalizeFeatureFlagProduct('llmo')).to.equal('LLMO');
    });

    it('returns null for invalid values', () => {
      expect(normalizeFeatureFlagProduct('ACO')).to.be.null;
      expect(normalizeFeatureFlagProduct('')).to.be.null;
      expect(normalizeFeatureFlagProduct(null)).to.be.null;
    });
  });

  describe('isValidFeatureFlagName', () => {
    it('accepts snake_case keys', () => {
      expect(isValidFeatureFlagName('enable_beta')).to.be.true;
      expect(isValidFeatureFlagName('a')).to.be.true;
    });

    it('rejects invalid shapes', () => {
      expect(isValidFeatureFlagName('EnableBeta')).to.be.false;
      expect(isValidFeatureFlagName('')).to.be.false;
      expect(isValidFeatureFlagName('_x')).to.be.false;
      expect(isValidFeatureFlagName('x'.repeat(256))).to.be.false;
      expect(isValidFeatureFlagName(1)).to.be.false;
    });
  });

  describe('upsertFeatureFlag', () => {
    const WRITTEN_ROW = {
      id: 'id-1',
      organization_id: ORG,
      product: 'LLMO',
      flag_name: 'beta',
      flag_value: true,
      created_at: 't0',
      updated_at: 't1',
      updated_by: 'admin',
    };

    /**
     * Wires the read-then-write chain: the org-row lookup resolves to
     * `existingRows`, and whichever write branch runs resolves to `WRITTEN_ROW`.
     */
    function makeClient(existingRows, { readError = null, writeError = null } = {}) {
      const read = makeSelectChain({
        data: readError ? null : existingRows,
        error: readError,
      });
      const single = sandbox.stub().resolves({
        data: writeError ? null : WRITTEN_ROW,
        error: writeError,
      });
      const writeSelect = sandbox.stub().returns({ single });
      const updateEq = sandbox.stub().returns({ select: writeSelect });
      const update = sandbox.stub().returns({ eq: updateEq });
      const insert = sandbox.stub().returns({ select: writeSelect });
      const from = sandbox.stub().returns({ select: read.select, update, insert });
      return {
        client: { from }, from, read, update, updateEq, insert,
      };
    }

    it('throws when postgrest client missing', async () => {
      await expect(
        upsertFeatureFlag({
          organizationId: ORG,
          product: 'LLMO',
          flagName: 'x',
          value: true,
          updatedBy: 'u',
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('inserts and returns the row when the org has no row yet', async () => {
      const {
        client, from, read, insert, update,
      } = makeClient([]);

      const out = await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: client,
      });

      expect(from).to.have.been.calledWith('feature_flags');
      expect(read.select).to.have.been.calledWith('*');
      expect(read.eq1).to.have.been.calledWith('organization_id', ORG);
      expect(read.eq2).to.have.been.calledWith('product', 'LLMO');
      expect(read.eq3).to.have.been.calledWith('flag_name', 'beta');
      expect(insert.firstCall.args[0]).to.deep.equal({
        organization_id: ORG,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: true,
        updated_by: 'admin',
      });
      expect(update).to.not.have.been.called;
      expect(out).to.deep.equal(WRITTEN_ROW);
    });

    it('treats a null read payload as no existing row', async () => {
      const { client, insert } = makeClient(null);

      await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: client,
      });

      expect(insert).to.have.been.calledOnce;
    });

    it('updates the existing org row in place, keyed on its id', async () => {
      const {
        client, update, updateEq, insert,
      } = makeClient([{ id: 'row-org', flag_value: false }]);

      const out = await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: client,
      });

      expect(update).to.have.been.calledOnceWith({
        flag_value: true,
        updated_by: 'admin',
      });
      expect(updateEq).to.have.been.calledOnceWith('id', 'row-org');
      expect(insert).to.not.have.been.called;
      expect(out).to.deep.equal(WRITTEN_ROW);
    });

    // A brand's override is a separate row for the same (org, product,
    // flag_name). Writing the org's value must never retarget it.
    it('inserts the org row when only a brand override exists', async () => {
      const { client, insert, update } = makeClient([
        { id: 'row-brand', brand_id: BRAND, flag_value: true },
      ]);

      await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: client,
      });

      expect(insert).to.have.been.calledOnce;
      expect(update).to.not.have.been.called;
    });

    it('updates the org row and not the brand override when both exist', async () => {
      const { client, updateEq } = makeClient([
        { id: 'row-brand', brand_id: BRAND, flag_value: true },
        { id: 'row-org', brand_id: null, flag_value: false },
      ]);

      await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: client,
      });

      expect(updateEq).to.have.been.calledOnceWith('id', 'row-org');
    });

    it('throws when the org-row lookup fails', async () => {
      const { client } = makeClient([], { readError: { message: 'read boom' } });

      await expect(
        upsertFeatureFlag({
          organizationId: ORG,
          product: 'LLMO',
          flagName: 'beta',
          value: true,
          updatedBy: 'admin',
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to upsert feature flag: read boom');
    });

    it('throws on postgrest error', async () => {
      const { client } = makeClient([], { writeError: { message: 'nope' } });

      await expect(
        upsertFeatureFlag({
          organizationId: ORG,
          product: 'LLMO',
          flagName: 'beta',
          value: false,
          updatedBy: 'admin',
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to upsert feature flag: nope');
    });
  });

  describe('readFeatureFlag', () => {
    /**
     * @param {object} result - PostgREST result the org-row lookup resolves to.
     * @returns {object} `{ client, read }` for assertions on the query chain.
     */
    function makeClient(result) {
      const read = makeSelectChain(result);
      const from = sandbox.stub().returns({ select: read.select });
      return { client: { from }, from, read };
    }

    const read = (postgrestClient) => readFeatureFlag({
      organizationId: ORG,
      product: 'LLMO',
      flagName: 'brandalf',
      postgrestClient,
    });

    it('throws when client missing', async () => {
      await expect(read(null)).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns boolean true when flag is true', async () => {
      const { client, from, read: chain } = makeClient({
        data: [{ flag_value: true }],
        error: null,
      });

      expect(await read(client)).to.equal(true);
      expect(from).to.have.been.calledWith('feature_flags');
      expect(chain.select).to.have.been.calledWith('*');
      expect(chain.eq1).to.have.been.calledWith('organization_id', ORG);
      expect(chain.eq2).to.have.been.calledWith('product', 'LLMO');
      expect(chain.eq3).to.have.been.calledWith('flag_name', 'brandalf');
    });

    it('returns boolean false when flag is false', async () => {
      const { client } = makeClient({ data: [{ flag_value: false }], error: null });
      expect(await read(client)).to.equal(false);
    });

    it('returns null when no row found', async () => {
      const { client } = makeClient({ data: [], error: null });
      expect(await read(client)).to.be.null;
    });

    it('returns null when the payload is null', async () => {
      const { client } = makeClient({ data: null, error: null });
      expect(await read(client)).to.be.null;
    });

    it('returns null when flag value is not a boolean', async () => {
      const { client } = makeClient({ data: [{ flag_value: 'true' }], error: null });
      expect(await read(client)).to.be.null;
    });

    // The org's value is the row with no brand, whichever order PostgREST
    // returns the rows in; a brand's override must not answer for the org.
    it('returns the org row and ignores a brand override', async () => {
      const { client } = makeClient({
        data: [
          { flag_value: true, brand_id: BRAND },
          { flag_value: false, brand_id: null },
        ],
        error: null,
      });
      expect(await read(client)).to.equal(false);
    });

    it('returns null when only a brand override exists', async () => {
      const { client } = makeClient({
        data: [{ flag_value: true, brand_id: BRAND }],
        error: null,
      });
      expect(await read(client)).to.be.null;
    });

    it('throws on postgrest error', async () => {
      const { client } = makeClient({ data: null, error: { message: 'boom' } });
      await expect(read(client)).to.be.rejectedWith('Failed to read feature flag brandalf: boom');
    });
  });

  describe('listFeatureFlagsByOrgAndProduct', () => {
    it('throws when client missing', async () => {
      await expect(
        listFeatureFlagsByOrgAndProduct({
          organizationId: ORG,
          product: 'LLMO',
          postgrestClient: {},
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns empty array when data is null', async () => {
      const orderStub = sandbox.stub().resolves({ data: null, error: null });
      const eq3 = sandbox.stub().returns({ order: orderStub });
      const eq2 = sandbox.stub().returns({ eq: eq3 });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      const fromStub = sandbox.stub().returns({ select: selectStub });

      const out = await listFeatureFlagsByOrgAndProduct({
        organizationId: ORG,
        product: 'LLMO',
        postgrestClient: { from: fromStub },
      });
      expect(out).to.deep.equal([]);
    });

    it('returns rows', async () => {
      const rows = [{ id: '1', flag_name: 'a' }];
      const orderStub = sandbox.stub().resolves({ data: rows, error: null });
      const eq3 = sandbox.stub().returns({ order: orderStub });
      const eq2 = sandbox.stub().returns({ eq: eq3 });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      const fromStub = sandbox.stub().returns({ select: selectStub });

      const out = await listFeatureFlagsByOrgAndProduct({
        organizationId: ORG,
        product: 'ASO',
        postgrestClient: { from: fromStub },
      });

      expect(fromStub).to.have.been.calledWith('feature_flags');
      expect(eq1).to.have.been.calledWith('organization_id', ORG);
      expect(eq2).to.have.been.calledWith('product', 'ASO');
      expect(eq3).to.have.been.calledWith('flag_value', true);
      expect(orderStub).to.have.been.calledWith('flag_name', { ascending: true });
      expect(out).to.deep.equal(rows);
    });

    // The endpoint built on this describes the ORGANIZATION's flags, so a
    // brand's override must not surface as an extra entry for the same flag.
    it('omits brand overrides', async () => {
      const orgRow = { id: '1', flag_name: 'serenity', brand_id: null };
      const orderStub = sandbox.stub().resolves({
        data: [orgRow, { id: '2', flag_name: 'serenity', brand_id: BRAND }],
        error: null,
      });
      const eq3 = sandbox.stub().returns({ order: orderStub });
      const eq2 = sandbox.stub().returns({ eq: eq3 });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      const fromStub = sandbox.stub().returns({ select: selectStub });

      const out = await listFeatureFlagsByOrgAndProduct({
        organizationId: ORG,
        product: 'LLMO',
        postgrestClient: { from: fromStub },
      });

      expect(out).to.deep.equal([orgRow]);
    });

    it('throws on postgrest error', async () => {
      const orderStub = sandbox.stub().resolves({ data: null, error: { message: 'fail' } });
      const eq3 = sandbox.stub().returns({ order: orderStub });
      const eq2 = sandbox.stub().returns({ eq: eq3 });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      const fromStub = sandbox.stub().returns({ select: selectStub });

      await expect(
        listFeatureFlagsByOrgAndProduct({
          organizationId: ORG,
          product: 'LLMO',
          postgrestClient: { from: fromStub },
        }),
      ).to.be.rejectedWith('Failed to list feature flags');
    });
  });
});
