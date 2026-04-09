/*
 * Copyright 2025 Adobe. All rights reserved.
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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

use(sinonChai);

describe('LlmoMysticatController', () => {
  let sandbox;
  let mockContext;
  let mockAccessControlUtil;
  let mockOrganization;
  let LlmoMysticatController;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrganization = { getId: sandbox.stub().returns('org-123') };

    const chainableMock = () => {
      const c = {};
      c.from = sandbox.stub().returns(c);
      c.select = sandbox.stub().returns(c);
      c.order = sandbox.stub().returns(c);
      c.eq = sandbox.stub().returns(c);
      c.gte = sandbox.stub().returns(c);
      c.lte = sandbox.stub().returns(c);
      c.in = sandbox.stub().returns(c);
      c.ilike = sandbox.stub().returns(c);
      c.limit = sandbox.stub().resolves({ data: [], error: null });
      c.rpc = sandbox.stub().resolves({
        data: {
          brands: [],
          categories: [],
          topics: [],
          origins: [],
          regions: [],
        },
        error: null,
      });
      c.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve);
      return c;
    };

    mockContext = {
      params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
      attributes: {
        authInfo: new AuthInfo()
          .withType('ims')
          .withProfile({ tenants: [{ id: 'tenant-1' }] })
          .withAuthenticated(true),
      },
      dataAccess: {
        Site: {
          postgrestService: chainableMock(),
        },
        Organization: {
          findById: sandbox.stub().resolves(mockOrganization),
          findByImsOrgId: sandbox.stub().resolves(mockOrganization),
        },
        services: {
          postgrestClient: chainableMock(),
        },
      },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(false),
    };

    LlmoMysticatController = await esmock('../../../src/controllers/llmo/llmo-mysticat-controller.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns getFilterDimensions handler', () => {
    const controller = LlmoMysticatController(mockContext);

    expect(controller.getFilterDimensions).to.be.a('function');
    expect(controller.getFilterDimensionsFromConfig).to.be.a('function');
    expect(controller.getAgenticTrafficGlobal).to.be.a('function');
    expect(controller.postAgenticTrafficGlobal).to.be.a('function');
  });

  it('getFilterDimensions validates org and returns data', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(mockContext.dataAccess.Organization.findById)
      .to.have.been.calledWith(mockContext.params.spaceCatId);
    expect(result.status).to.equal(200);
  });

  it('getFilterDimensionsFromConfig validates org and returns data', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensionsFromConfig(mockContext);

    expect(mockContext.dataAccess.Organization.findById)
      .to.have.been.calledWith(mockContext.params.spaceCatId);
    expect(result.status).to.equal(200);
  });

  it('getFilterDimensions returns 403 when user has no org access', async () => {
    mockAccessControlUtil.hasAccess.resolves(false);

    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(result.status).to.equal(403);
  });

  it('getAgenticTrafficGlobal allows UI users with LLMO org access', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getAgenticTrafficGlobal(mockContext);

    expect(result.status).to.equal(200);
    expect(mockContext.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('tenant-1@AdobeOrg');
    expect(mockAccessControlUtil.hasAccess).to.have.been.calledWith(mockOrganization, '', 'LLMO');
  });

  it('getAgenticTrafficGlobal allows S2S consumers without org lookup', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getAgenticTrafficGlobal({
      ...mockContext,
      s2sConsumer: { getCapabilities: () => ['report:read'] },
    });

    expect(result.status).to.equal(200);
    expect(mockContext.dataAccess.Organization.findByImsOrgId).not.to.have.been.called;
  });

  it('getAgenticTrafficGlobal returns 403 when user has no global org access', async () => {
    mockAccessControlUtil.hasAccess.resolves(false);

    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getAgenticTrafficGlobal(mockContext);

    expect(result.status).to.equal(403);
  });

  it('getAgenticTrafficGlobal supports authInfo.profile tenant fallback without getProfile/getTenantIds', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getAgenticTrafficGlobal({
      ...mockContext,
      attributes: {
        authInfo: {
          profile: { tenants: [{ id: 'tenant-2@AdobeOrg' }] },
        },
      },
    });

    expect(result.status).to.equal(200);
    expect(mockContext.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('tenant-2@AdobeOrg');
  });

  it('getAgenticTrafficGlobal returns 403 when authInfo has no tenants', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getAgenticTrafficGlobal({
      ...mockContext,
      attributes: {
        authInfo: {
          profile: {},
        },
      },
    });

    expect(result.status).to.equal(403);
    expect(mockContext.dataAccess.Organization.findByImsOrgId).not.to.have.been.called;
  });

  it('getFilterDimensions returns 400 when organization not found', async () => {
    mockContext.dataAccess.Organization.findById.resolves(null);

    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(result.status).to.equal(400);
  });
});
