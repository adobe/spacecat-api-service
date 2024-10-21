/*
 * Copyright 2024 Adobe. All rights reserved.
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

  const publicInternalErrorMessage = 'An error occurred while trying to enable or disable audits.';

  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
    { id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  const controllerFunctions = [
    'update',
  ];

  let mockConfiguration;
  let mockDataAccess;
  let mockLog;
  let sitesAuditsController;

  const checkRequestFailure = (response, responseErrorCode, error, errorMessage) => {
    expect(mockConfiguration.enableHandlerForSite.called, 'Expected enableHandlerForSite to not be called').to.be.false;
    expect(mockConfiguration.disableHandlerForSite.called, 'Expected disableHandlerForSite to not be called').to.be.false;

    expect(mockDataAccess.updateConfiguration.called, 'Expected updateConfiguration to not be called').to.be.false;

    expect(response.status).to.equal(responseErrorCode, `Expected response status to be ${responseErrorCode}, but got ${response.status}`);
    expect(error).to.have.property('message', errorMessage, `Expected error message to be "${errorMessage}", but got "${error.message}"`);
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

    mockLog = {
      error: sandbox.stub(),
    };

    sitesAuditsController = SitesAuditsController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('updates the audit configuration for multiple sites with a single audit toggle', async () => {
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

    expect(mockConfiguration.disableHandlerForSite.calledTwice).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('404', sites[1])).to.be.true;

    expect(response.status).to.equal(207);
    const patchResponse = await response.json();

    expect(patchResponse).to.be.an('array').with.lengthOf(4);
    expect(patchResponse[0].baseURL).to.equal('https://site1.com');
    expect(patchResponse[0].response.status).to.equal(200);
    expect(patchResponse[1].baseURL).to.equal('https://site1.com');
    expect(patchResponse[1].response.status).to.equal(200);

    expect(patchResponse[2].baseURL).to.equal('https://site2.com');
    expect(patchResponse[2].response.status).to.equal(200);
    expect(patchResponse[3].baseURL).to.equal('https://site2.com');
    expect(patchResponse[3].response.status).to.equal(200);
  });

  it('updates the audit configuration for multiple sites with multiple audit toggles', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

    const requestData = [
      { baseURL: 'https://site1.com', auditTypes: ['cwv', '404'], enableAudits: true },
      { baseURL: 'https://site2.com', auditTypes: ['cwv', '404'], enableAudits: false },
    ];
    const response = await sitesAuditsController.update({
      data: requestData,
    });

    expect(mockDataAccess.getSiteByBaseURL.callCount).to.equal(2);
    expect(mockDataAccess.updateConfiguration.called).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.calledTwice).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[0])).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('404', sites[0])).to.be.true;

    expect(mockConfiguration.disableHandlerForSite.calledTwice).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('404', sites[1])).to.be.true;

    expect(response.status).to.equal(207);
    const patchResponse = await response.json();

    expect(patchResponse).to.be.an('array').with.lengthOf(2);
    expect(patchResponse[0].baseURL).to.equal('https://site1.com');
    expect(patchResponse[0].response.status).to.equal(200);
    expect(patchResponse[1].baseURL).to.equal('https://site2.com');
    expect(patchResponse[1].response.status).to.equal(200);
  });

  describe('500 Internal Server Error', () => {
    it('if the context object is not provided', async () => {
      const response = await sitesAuditsController.update();
      const error = await response.json();

      checkRequestFailure(response, 500, error, publicInternalErrorMessage);
    });

    it('if the context object is empty', async () => {
      const response = await sitesAuditsController.update({});
      const error = await response.json();

      checkRequestFailure(response, 500, error, publicInternalErrorMessage);
    });

    it('if an error occurred while saving the configuration', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(SiteDto.fromJson({
        id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge',
      }));

      const privateInternalServerError = 'Some internal private error';
      mockDataAccess.updateConfiguration.rejects(new Error(privateInternalServerError));

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData, log: mockLog });
      const error = await response.json();

      expect(mockLog.error.calledWith(privateInternalServerError), 'Expected log.error to be called with the privateInternalServerError message').to.be.true;

      expect(response.status).to.equal(500, `Expected response status to be 500, but got ${response.status}`);
      expect(error).to.have.property('message', publicInternalErrorMessage, `Expected error message to be "${publicInternalErrorMessage}", but got "${error.message}"`);
    });
  });

  describe('400 Bad Request Errors', () => {
    it('if request body is not provided', async () => {
      const response = await sitesAuditsController.update({ context: {} });
      const error = await response.json();

      checkRequestFailure(response, 400, error, 'Request body is required.');
    });

    it('if request body is empty', async () => {
      const response = await sitesAuditsController.update({ context: { data: {} } });
      const error = await response.json();

      checkRequestFailure(response, 400, error, 'Request body is required.');
    });
  });

  describe('Error during partial update of site configuration', () => {
    it('if Site URL is not provided', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { auditTypes: ['cwv'], enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];

      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('Site URL is required.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if Site URL is empty', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: '', auditTypes: ['cwv'], enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('Site URL is required.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if Site URL has wrong format', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'wrong_format', auditTypes: ['cwv'], enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('Invalid Site URL format: "wrong_format".');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if the audit types parameter is in the wrong format', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: 'not_array', enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].baseURL).to.equal('https://site1.com');
      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('The audit types parameter must be a list (array) of valid audits.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if the audit types parameter is missing', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: [], enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].baseURL).to.equal('https://site1.com');
      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('At least one audit type must be provided.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if "enableAudits" parameter is missed', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'] },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].baseURL).to.equal('https://site1.com');
      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('The "enableAudits" parameter is required and must be set to a boolean value: true or false.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if "enableAudits" parameter is not a boolean value', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: 'not_boolean' },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].baseURL).to.equal('https://site1.com');
      expect(patchResponse[0].response.status).to.equal(400);
      expect(patchResponse[0].response.message).to.equal('The "enableAudits" parameter is required and must be set to a boolean value: true or false.');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });

    it('if the site is not found.', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(null);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site1.com', auditTypes: ['cwv'], enableAudits: true },
        { baseURL: 'https://site2.com', auditTypes: ['404'], enableAudits: true },
      ];
      const response = await sitesAuditsController.update({ data: requestData });
      const patchResponse = await response.json();

      expect(mockConfiguration.enableHandlerForSite.calledOnceWith('404', sites[1])).to.be.true;
      expect(mockDataAccess.updateConfiguration.called).to.be.true;

      expect(patchResponse[0].baseURL).to.equal('https://site1.com');
      expect(patchResponse[0].response.status).to.equal(404);
      expect(patchResponse[0].response.message).to.equal('Site with baseURL: https://site1.com not found');

      expect(patchResponse[1].baseURL).to.equal('https://site2.com');
      expect(patchResponse[1].response.status).to.equal(200);
    });
  });

  describe('misc errors', () => {
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
  });
});
