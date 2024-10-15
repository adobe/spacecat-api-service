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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import SitesAuditsController from '../../src/controllers/sites-audits.js';
import { SiteDto } from '../../src/dto/site.js';

use(chaiAsPromised);

describe('Sites Audits Controller', () => {
  const sandbox = sinon.createSandbox();

  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
    { id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  const controllerFunctions = [
    'update',
  ];

  let mockConfiguration;
  let mockDataAccess;
  let sitesAuditsController;

  const checkBadRequestFailure = (response, error, errorMessage) => {
    expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
    expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
    expect(mockDataAccess.updateConfiguration.called).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', errorMessage);
  };

  beforeEach(() => {
    mockConfiguration = {
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub(),
      getQueues: sandbox.stub(),
    };

    mockDataAccess = {
      getConfiguration: sandbox.stub().resolves(mockConfiguration),
      getSiteByBaseURL: sandbox.stub(),
      updateConfiguration: sandbox.stub(),
    };

    sitesAuditsController = SitesAuditsController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    controllerFunctions.forEach((funcName) => {
      expect(sitesAuditsController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(sitesAuditsController).forEach((funcName) => {
      expect(controllerFunctions).to.include(funcName);
    });
  });

  it('updates multiple sites and returns their responses', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

    const requestData = [
      { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: true },
      { baseURL: 'https://site1.com', auditTypes: ['404'], enableAudits: true },
      { baseURL: 'https://site2.com', auditTypes: ['cwv'], enableAudits: false },
      { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: false },
    ];
    const response = await sitesAuditsController.update({
      data: requestData,
    });

    expect(mockDataAccess.getSiteByBaseURL.callCount).to.equal(4);
    expect(mockDataAccess.updateConfiguration.called).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.calledTwice).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[0])).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('404', sites[0])).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.calledTwice).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('404', sites[1])).to.be.true;

    expect(response.status).to.equal(207);
    const multiResponse = await response.json();

    expect(multiResponse).to.be.an('array').with.lengthOf(4);
    expect(multiResponse[0].baseURL).to.equal('https://site1.com');
    expect(multiResponse[0].response.status).to.equal(200);
    expect(multiResponse[1].baseURL).to.equal('https://site1.com');
    expect(multiResponse[1].response.status).to.equal(200);

    expect(multiResponse[2].baseURL).to.equal('https://site2.com');
    expect(multiResponse[2].response.status).to.equal(200);
    expect(multiResponse[3].baseURL).to.equal('https://site2.com');
    expect(multiResponse[3].response.status).to.equal(200);
  });

  describe('bad request errors', () => {
    it('returns bad request when baseURL is not provided', async () => {
      const requestData = [
        { auditTypes: ['cwv'], enableAudits: true },
      ];

      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'Base URL is required');
    });

    it('returns bad request when baseURL has wrong format', async () => {
      const requestData = [
        { baseURL: 'wrong_format', auditTypes: ['cwv'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      checkBadRequestFailure(response, error, 'Invalid Base URL format: wrong_format');
    });

    it('returns bad request when auditTypes is not provided', async () => {
      const requestData = [
        { baseURL: 'https://site1.com', enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      checkBadRequestFailure(response, error, 'Audit types are required');
    });

    it('returns bad request when auditTypes has wrong format', async () => {
      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: 'not_array', enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      checkBadRequestFailure(response, error, 'Audit types are required');
    });

    it('returns bad request when enableAudits is not provided', async () => {
      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'] },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      checkBadRequestFailure(response, error, 'The "enableAudits" flag is required');
    });

    it('returns bad request when enableAudits has wrong format', async () => {
      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: 'not_boolean' },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      checkBadRequestFailure(response, error, 'The "enableAudits" flag should be boolean');
    });
  });

  describe('misc errors', () => {
    it('throws an error if data access is not an object', () => {
      expect(() => SitesAuditsController()).to.throw('Data access required');
    });

    it('returns not found when site is not found', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(null);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const responses = await response.json();

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(404);
      expect(responses[0].response.message).to.equal('Site with baseURL: https://site1.com not found');
    });

    it('return 500 when site cannot be updated', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(SiteDto.fromJson({
        id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge',
      }));
      mockDataAccess.updateConfiguration.rejects(new Error('Update operation failed'));

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const error = await response.json();

      expect(response.status).to.equal(500);
      expect(error).to.have.property('message', 'Update operation failed');
    });
  });
});
