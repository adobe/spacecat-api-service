/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { expect } from 'chai';
import sinon from 'sinon';

import getRouteHandlers from '../../src/routes/index.js';

describe('getRouteHandlers', () => {
  const mockSitesController = {
    getAll: sinon.stub(),
    getAllAsCsv: sinon.stub(),
    getAllAsExcel: sinon.stub(),
    getSiteById: sinon.stub(),
  };
  const mockTrigger = sinon.stub();

  it('segregates static and dynamic routes', () => {
    const { staticRoutes, dynamicRoutes } = getRouteHandlers(mockSitesController, mockTrigger);

    expect(staticRoutes).to.have.all.keys('sites', 'sites.csv', 'sites.xlsx', 'trigger');
    expect(staticRoutes.sites).to.equal(mockSitesController.getAll);
    expect(staticRoutes['sites.csv']).to.equal(mockSitesController.getAllAsCsv);
    expect(staticRoutes['sites.xlsx']).to.equal(mockSitesController.getAllAsExcel);

    expect(dynamicRoutes).to.have.key('sites/:siteId');
    expect(dynamicRoutes['sites/:siteId'].handler).to.equal(mockSitesController.getSiteById);
    expect(dynamicRoutes['sites/:siteId'].paramNames).to.deep.equal(['siteId']);
  });
});
