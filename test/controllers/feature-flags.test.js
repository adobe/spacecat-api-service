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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import FeatureFlagsController from '../../src/controllers/feature-flags.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('FeatureFlagsController', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-42d3-a456-426614174000';
  const mockOrganization = { getId: () => organizationId };

  let mockDataAccess;
  let controller;
  let mockHasAccess;
  let mockHasAdmin;
  let baseCtx;

  beforeEach(() => {
    sandbox.restore();

    mockHasAccess = sandbox.stub().resolves(true);
    mockHasAdmin = sandbox.stub().returns(true);

    sandbox.stub(AccessControlUtil, 'fromContext').returns({
      hasAccess: mockHasAccess,
      hasAdminAccess: mockHasAdmin,
    });

    mockDataAccess = {
      Organization: {
        findById: sandbox.stub().resolves(mockOrganization),
      },
      services: {
        postgrestClient: { from: sandbox.stub() },
      },
    };

    baseCtx = {
      dataAccess: mockDataAccess,
      log: { error: sandbox.stub() },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true, user_id: 'user-1' })
          .withAuthenticated(true),
      },
    };
    controller = FeatureFlagsController(baseCtx);
  });

  afterEach(() => sandbox.restore());

  it('throws without context', () => {
    expect(() => FeatureFlagsController()).to.throw('Context required');
  });

  it('throws without dataAccess', () => {
    expect(() => FeatureFlagsController({ log: {}, attributes: {} })).to.throw('Data access required');
  });

  describe('listByOrganization', () => {
    it('returns 503 when PostgREST unavailable', async () => {
      mockDataAccess.services.postgrestClient = {};
      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO' } },
      });
      expect(res.status).to.equal(503);
    });

    it('returns 400 when organizationId invalid', async () => {
      const res = await controller.listByOrganization({
        params: { organizationId: 'bad' },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO' } },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when product query missing', async () => {
      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: {} },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when organization not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO' } },
      });
      expect(res.status).to.equal(404);
    });

    it('returns 403 when user lacks org access', async () => {
      mockHasAccess.resolves(false);
      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=ASO' } },
      });
      expect(res.status).to.equal(403);
    });

    it('returns 200 with flags', async () => {
      const rows = [{
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: true,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'x',
      }];
      const orderStub = sandbox.stub().resolves({ data: rows, error: null });
      const eq2 = sandbox.stub().returns({ order: orderStub });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ select: selectStub });

      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO' } },
      });

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.length(1);
      expect(body[0].flagName).to.equal('beta');
    });

    it('returns 500 when list throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().throws(new Error('db'));
      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO' } },
      });
      expect(res.status).to.equal(500);
    });

    it('handles query pairs without value segment', async () => {
      const orderStub = sandbox.stub().resolves({ data: [], error: null });
      const eq2 = sandbox.stub().returns({ order: orderStub });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ select: selectStub });

      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=LLMO&extra' } },
      });
      expect(res.status).to.equal(200);
    });

    it('decodes percent-encoded product query value', async () => {
      const orderStub = sandbox.stub().resolves({ data: [], error: null });
      const eq2 = sandbox.stub().returns({ order: orderStub });
      const eq1 = sandbox.stub().returns({ eq: eq2 });
      const selectStub = sandbox.stub().returns({ eq: eq1 });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ select: selectStub });

      const res = await controller.listByOrganization({
        params: { organizationId },
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        invocation: { event: { rawQueryString: 'product=%4C%4C%4D%4F' } },
      });
      expect(res.status).to.equal(200);
      expect(eq2).to.have.been.calledWith('product', 'LLMO');
    });
  });

  const writeParams = { organizationId, product: 'LLMO', flagName: 'beta' };

  describe('putByOrganizationProductAndName', () => {
    it('returns 403 for non-admin', async () => {
      mockHasAdmin.returns(false);
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });
      expect(res.status).to.equal(403);
    });

    it('returns 503 when PostgREST unavailable', async () => {
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        dataAccess: { Organization: mockDataAccess.Organization, services: {} },
        params: writeParams,
      });
      expect(res.status).to.equal(503);
    });

    it('returns 400 when path product invalid', async () => {
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { ...writeParams, product: 'ACO' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when organizationId is not a UUID', async () => {
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { ...writeParams, organizationId: 'nope' },
      });
      expect(res.status).to.equal(400);
    });

    it('falls back to raw flag name when decodeURIComponent fails', async () => {
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { ...writeParams, flagName: '%' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when flag name is invalid', async () => {
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { ...writeParams, flagName: 'InvalidFlag' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when organization not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });
      expect(res.status).to.equal(404);
    });

    it('returns 200 and sets flag_value true', async () => {
      const cleanRow = {
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: true,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'user-1',
      };
      const singleStub = sandbox.stub().resolves({ data: cleanRow, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ upsert: upsertStub });

      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { organizationId, product: 'llmo', flagName: 'beta' },
      });

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.flagValue).to.equal(true);
      expect(upsertStub.firstCall.args[0]).to.deep.include({
        flag_name: 'beta',
        flag_value: true,
        updated_by: 'user-1',
      });
    });

    it('uses profile.sub for updatedBy when user_id absent', async () => {
      sandbox.restore();
      mockHasAccess = sandbox.stub().resolves(true);
      mockHasAdmin = sandbox.stub().returns(true);
      sandbox.stub(AccessControlUtil, 'fromContext').returns({
        hasAccess: mockHasAccess,
        hasAdminAccess: mockHasAdmin,
      });
      baseCtx = {
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true, sub: 'sub-9' })
            .withAuthenticated(true),
        },
      };
      controller = FeatureFlagsController(baseCtx);

      const cleanRow = {
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'gamma',
        flag_value: true,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'sub-9',
      };
      const singleStub = sandbox.stub().resolves({ data: cleanRow, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ upsert: upsertStub });
      mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);

      await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { organizationId, product: 'LLMO', flagName: 'gamma' },
      });
      expect(upsertStub.firstCall.args[0].updated_by).to.equal('sub-9');
    });

    it('reads profile from authInfo.profile when getProfile is absent', async () => {
      sandbox.restore();
      mockHasAccess = sandbox.stub().resolves(true);
      mockHasAdmin = sandbox.stub().returns(true);
      sandbox.stub(AccessControlUtil, 'fromContext').returns({
        hasAccess: mockHasAccess,
        hasAdminAccess: mockHasAdmin,
      });
      baseCtx = {
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        attributes: {
          authInfo: { profile: { user_id: 'plain-profile' } },
        },
      };
      controller = FeatureFlagsController(baseCtx);

      const cleanRow = {
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'eta',
        flag_value: true,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'plain-profile',
      };
      const singleStub = sandbox.stub().resolves({ data: cleanRow, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ upsert: upsertStub });
      mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);

      await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { organizationId, product: 'LLMO', flagName: 'eta' },
      });
      expect(upsertStub.firstCall.args[0].updated_by).to.equal('plain-profile');
    });

    it('uses service fallback for updatedBy when profile has no ids', async () => {
      sandbox.restore();
      mockHasAccess = sandbox.stub().resolves(true);
      mockHasAdmin = sandbox.stub().returns(true);
      sandbox.stub(AccessControlUtil, 'fromContext').returns({
        hasAccess: mockHasAccess,
        hasAdminAccess: mockHasAdmin,
      });
      baseCtx = {
        dataAccess: mockDataAccess,
        log: { error: sandbox.stub() },
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      };
      controller = FeatureFlagsController(baseCtx);

      const cleanRow = {
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'delta',
        flag_value: true,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'spacecat-api-service',
      };
      const singleStub = sandbox.stub().resolves({ data: cleanRow, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ upsert: upsertStub });
      mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);

      await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: { organizationId, product: 'LLMO', flagName: 'delta' },
      });
      expect(upsertStub.firstCall.args[0].updated_by).to.equal('spacecat-api-service');
    });

    it('returns 500 when upsert throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().throws(new Error('upsert fail'));
      const res = await controller.putByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });
      expect(res.status).to.equal(500);
    });
  });

  describe('deleteByOrganizationProductAndName', () => {
    it('returns 403 for non-admin', async () => {
      mockHasAdmin.returns(false);
      const res = await controller.deleteByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });
      expect(res.status).to.equal(403);
    });

    it('returns 200 and sets flag_value false', async () => {
      const cleanRow = {
        id: 'f1',
        organization_id: organizationId,
        product: 'LLMO',
        flag_name: 'beta',
        flag_value: false,
        created_at: 'c',
        updated_at: 'u',
        updated_by: 'user-1',
      };
      const singleStub = sandbox.stub().resolves({ data: cleanRow, error: null });
      const selectStub = sandbox.stub().returns({ single: singleStub });
      const upsertStub = sandbox.stub().returns({ select: selectStub });
      mockDataAccess.services.postgrestClient.from = sandbox.stub().returns({ upsert: upsertStub });

      const res = await controller.deleteByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.flagValue).to.equal(false);
      expect(upsertStub.firstCall.args[0].flag_value).to.equal(false);
    });

    it('returns 500 when upsert throws', async () => {
      mockDataAccess.services.postgrestClient.from = sandbox.stub().throws(new Error('fail'));
      const res = await controller.deleteByOrganizationProductAndName({
        ...baseCtx,
        params: writeParams,
      });
      expect(res.status).to.equal(500);
    });
  });
});
