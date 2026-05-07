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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import {
  readCustomerConfigV2FromPostgres,
  writeCustomerConfigV2ToPostgres,
} from '../../src/support/customer-config-v2-storage.js';

use(chaiAsPromised);
use(sinonChai);

describe('customer-config-v2-storage', () => {
  const sandbox = sinon.createSandbox();
  const ORG_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';

  afterEach(() => {
    sandbox.restore();
  });

  describe('readCustomerConfigV2FromPostgres', () => {
    it('returns null when postgrestClient is null', async () => {
      const result = await readCustomerConfigV2FromPostgres(ORG_ID, null);
      expect(result).to.be.null;
    });

    it('returns null when postgrestClient has no from method', async () => {
      const result = await readCustomerConfigV2FromPostgres(ORG_ID, {});
      expect(result).to.be.null;
    });

    it('returns config when found', async () => {
      const mockConfig = { customer: { customerName: 'Adobe', brands: [] } };
      const maybeSingleStub = sandbox.stub().resolves({
        data: { config: mockConfig },
        error: null,
      });
      const eqStub = sandbox.stub().returnsThis();
      const selectStub = sandbox.stub().returnsThis();
      const fromStub = sandbox.stub().returns({
        select: selectStub,
        eq: eqStub,
        maybeSingle: maybeSingleStub,
      });

      const result = await readCustomerConfigV2FromPostgres(ORG_ID, { from: fromStub });

      expect(result).to.deep.equal(mockConfig);
      expect(fromStub).to.have.been.calledWith('llmo_customer_config');
      expect(eqStub).to.have.been.calledWith('organization_id', ORG_ID);
    });

    it('returns null when no row found', async () => {
      const maybeSingleStub = sandbox.stub().resolves({ data: null, error: null });
      const fromStub = sandbox.stub().returns({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        maybeSingle: maybeSingleStub,
      });

      const result = await readCustomerConfigV2FromPostgres(ORG_ID, { from: fromStub });

      expect(result).to.be.null;
    });

    it('throws when PostgREST returns error', async () => {
      const maybeSingleStub = sandbox.stub().resolves({ data: null, error: { message: 'DB error' } });
      const fromStub = sandbox.stub().returns({
        select: sandbox.stub().returnsThis(),
        eq: sandbox.stub().returnsThis(),
        maybeSingle: maybeSingleStub,
      });

      await expect(
        readCustomerConfigV2FromPostgres(ORG_ID, { from: fromStub }),
      ).to.be.rejectedWith('Failed to read customer config');
    });
  });

  describe('writeCustomerConfigV2ToPostgres', () => {
    it('throws when postgrestClient is null', async () => {
      const config = { customer: { customerName: 'Adobe' } };
      await expect(
        writeCustomerConfigV2ToPostgres(ORG_ID, config, null, 'user@example.com'),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when postgrestClient has no from method', async () => {
      const config = { customer: { customerName: 'Adobe' } };
      await expect(
        writeCustomerConfigV2ToPostgres(ORG_ID, config, {}, 'user@example.com'),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('upserts config successfully', async () => {
      const config = { customer: { customerName: 'Adobe', brands: [] } };
      const upsertStub = sandbox.stub().resolves({ error: null });
      const fromStub = sandbox.stub().returns({ upsert: upsertStub });

      await writeCustomerConfigV2ToPostgres(ORG_ID, config, { from: fromStub }, 'user@example.com');

      expect(fromStub).to.have.been.calledWith('llmo_customer_config');
      expect(upsertStub).to.have.been.calledOnce;
      expect(upsertStub.firstCall.args[0]).to.deep.include({
        organization_id: ORG_ID,
        config,
        updated_by: 'user@example.com',
      });
      expect(upsertStub.firstCall.args[1]).to.deep.equal({ onConflict: 'organization_id' });
    });

    it('throws when PostgREST upsert returns error', async () => {
      const config = { customer: { customerName: 'Adobe' } };
      const upsertStub = sandbox.stub().resolves({ error: { message: 'Constraint violation' } });
      const fromStub = sandbox.stub().returns({ upsert: upsertStub });

      await expect(
        writeCustomerConfigV2ToPostgres(ORG_ID, config, { from: fromStub }),
      ).to.be.rejectedWith('Failed to write customer config');
    });
  });
});
