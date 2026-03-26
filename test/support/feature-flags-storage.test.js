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

/* eslint-env mocha */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  isValidFeatureFlagName,
  listFeatureFlagsByOrgAndProduct,
  normalizeFeatureFlagProduct,
  upsertFeatureFlag,
} from '../../src/support/feature-flags-storage.js';

use(chaiAsPromised);
use(sinonChai);

describe('feature-flags-storage', () => {
  const sandbox = sinon.createSandbox();
  const ORG = '123e4567-e89b-42d3-a456-426614174000';

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

    it('upserts and returns row', async () => {
      const row = {
        id: 'id-1',
        organization_id: ORG,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: true,
        created_at: 't0',
        updated_at: 't1',
        updated_by: 'admin',
      };
      const singleStub = sandbox.stub().resolves({ data: row, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      const fromStub = sandbox.stub().returns({ upsert: upsertStub });

      const out = await upsertFeatureFlag({
        organizationId: ORG,
        product: 'LLMO',
        flagName: 'beta',
        value: true,
        updatedBy: 'admin',
        postgrestClient: { from: fromStub },
      });

      expect(fromStub).to.have.been.calledWith('feature_flags');
      expect(upsertStub.firstCall.args[0]).to.deep.include({
        organization_id: ORG,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: true,
        updated_by: 'admin',
      });
      expect(upsertStub.firstCall.args[1]).to.deep.equal({
        onConflict: 'organization_id,product,flag_name',
      });
      expect(out).to.deep.equal(row);
    });

    it('throws on postgrest error', async () => {
      const singleStub = sandbox.stub().resolves({ data: null, error: { message: 'nope' } });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      const fromStub = sandbox.stub().returns({ upsert: upsertStub });

      await expect(
        upsertFeatureFlag({
          organizationId: ORG,
          product: 'LLMO',
          flagName: 'beta',
          value: false,
          updatedBy: 'admin',
          postgrestClient: { from: fromStub },
        }),
      ).to.be.rejectedWith('Failed to upsert feature flag');
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
      const eq2 = sandbox.stub().returns({ order: orderStub });
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
      const eq2 = sandbox.stub().returns({ order: orderStub });
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
      expect(orderStub).to.have.been.calledWith('flag_name', { ascending: true });
      expect(out).to.deep.equal(rows);
    });

    it('throws on postgrest error', async () => {
      const orderStub = sandbox.stub().resolves({ data: null, error: { message: 'fail' } });
      const eq2 = sandbox.stub().returns({ order: orderStub });
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
