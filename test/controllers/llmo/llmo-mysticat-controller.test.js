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

use(sinonChai);

describe('LlmoMysticatController', () => {
  let sandbox;
  let mockContext;
  let LlmoMysticatController;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    const mockOrganization = { getId: sandbox.stub().returns('org-123') };

    const chainableMock = () => {
      const c = {};
      c.from = sandbox.stub().returns(c);
      c.select = sandbox.stub().returns(c);
      c.eq = sandbox.stub().returns(c);
      c.gte = sandbox.stub().returns(c);
      c.lte = sandbox.stub().returns(c);
      c.limit = sandbox.stub().resolves({ data: [], error: null });
      c.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve);
      return c;
    };

    mockContext = {
      params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
      dataAccess: {
        Site: {
          postgrestService: chainableMock(),
        },
        Organization: {
          findById: sandbox.stub().resolves(mockOrganization),
        },
      },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
    };

    LlmoMysticatController = await esmock('../../../src/controllers/llmo/llmo-mysticat-controller.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({
            hasAccess: sandbox.stub().resolves(true),
          }),
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
  });

  it('getFilterDimensions validates org and returns data', async () => {
    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(mockContext.dataAccess.Organization.findById)
      .to.have.been.calledWith(mockContext.params.spaceCatId);
    expect(result.status).to.equal(200);
  });

  it('getFilterDimensions returns 403 when user has no org access', async () => {
    LlmoMysticatController = await esmock('../../../src/controllers/llmo/llmo-mysticat-controller.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({
            hasAccess: sandbox.stub().resolves(false),
          }),
        },
      },
    });

    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(result.status).to.equal(403);
  });

  it('getFilterDimensions returns 400 when organization not found', async () => {
    mockContext.dataAccess.Organization.findById.resolves(null);

    const controller = LlmoMysticatController(mockContext);
    const result = await controller.getFilterDimensions(mockContext);

    expect(result.status).to.equal(400);
  });
});
