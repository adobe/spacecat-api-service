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

import SitesAuditsToggleController from '../../src/controllers/sites-audits-toggle.js';

use(chaiAsPromised);

describe('Sites Audits Controller', () => {
  const sandbox = sinon.createSandbox();

  const publicInternalErrorMessage = 'An error occurred while trying to enable or disable audits.';

  const sites = [
    { getId: () => 'site0', getBaseURL: () => 'https://site0.com', getDeliveryType: () => 'aem_edge' },
    { getId: () => 'site1', getBaseURL: () => 'https://site1.com', getDeliveryType: () => 'aem_edge' },
  ];
  const handlers = { 404: {}, cwv: {} };

  let configurationMock;
  let dataAccessMock;
  let logMock;
  let sitesAuditsToggleController;

  const checkRequestFailure = (response, responseErrorCode, error, errorMessage) => {
    expect(configurationMock.enableHandlerForSite.called, 'Expected configuration.enableHandlerForSite to not be called').to.be.false;
    expect(configurationMock.disableHandlerForSite.called, 'Expected configuration.disableHandlerForSite to not be called').to.be.false;

    expect(configurationMock.save.called, 'Expected updateConfiguration to not be called').to.be.false;

    expect(response.status).to.equal(
      responseErrorCode,
      `Expected response status to be ${responseErrorCode}, but got ${response.status}`,
    );
    expect(error).to.have.property(
      'message',
      errorMessage,
      `Expected error message to be "${errorMessage}", but got "${error.message}"`,
    );
  };

  beforeEach(() => {
    configurationMock = {
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub().returns(handlers),
      getQueues: sandbox.stub(),
      getSlackRoles: sandbox.stub(),
      save: sandbox.stub(),
    };

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configurationMock),
      },
      Site: {
        findByBaseURL: sandbox.stub(),
      },
    };

    logMock = {
      error: sandbox.stub(),
    };

    sitesAuditsToggleController = SitesAuditsToggleController(dataAccessMock);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('updates the audit configuration for multiple sites', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(sites[0]);
    dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

    const requestData = [
      { baseURL: 'https://site0.com', auditType: 'cwv', enable: true },
      { baseURL: 'https://site0.com', auditType: '404', enable: true },
      { baseURL: 'https://site1.com', auditType: 'cwv', enable: false },
      { baseURL: 'https://site1.com', auditType: '404', enable: false },
    ];
    const response = await sitesAuditsToggleController.execute({
      data: requestData,
      log: logMock,
    });
    const patchResponse = await response.json();

    expect(
      dataAccessMock.Site.findByBaseURL.callCount,
      'Expected dataAccess.getSiteByBaseURL to be called 4 times, but it was not',
    ).to.equal(4);
    expect(
      configurationMock.save.called,
      'Expected dataAccess.updateConfiguration to be called, but it was not',
    ).to.be.true;

    expect(
      configurationMock.enableHandlerForSite.calledTwice,
      'Expected configuration.enableHandlerForSite to be called twice, but it was not',
    ).to.be.true;
    expect(
      configurationMock.enableHandlerForSite.calledWith('cwv', sites[0]),
      'Expected configuration.enableHandlerForSite to be called with "cwv" and "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      configurationMock.enableHandlerForSite.calledWith('404', sites[0]),
      'Expected configuration.enableHandlerForSite to be called with "404" and "https://site0.com", but it was not',
    ).to.be.true;

    expect(
      configurationMock.disableHandlerForSite.calledTwice,
      'Expected configuration.disableHandlerForSite to be called twice, but it was not',
    ).to.be.true;
    expect(
      configurationMock.disableHandlerForSite.calledWith('cwv', sites[1]),
      'Expected configuration.disableHandlerForSite to be called with "cwv" and "https://site1.com", but it was not',
    ).to.be.true;
    expect(
      configurationMock.disableHandlerForSite.calledWith('404', sites[1]),
      'Expected configuration.disableHandlerForSite to be called with "404" and "https://site1.com", but it was not',
    ).to.be.true;

    expect(
      response.status,
      'Expected response status to be 207, but it was not',
    ).to.equal(207);
    expect(
      patchResponse,
      'Expected patchResponse to be an array with length of 4, but it was not',
    ).to.be.an('array').with.lengthOf(4);

    expect(
      patchResponse[0],
      'Expected the status of patchResponse[0] to be 200 and message indicating "cwv" has been enabled for '
        + '"https://site0.com", but it was not',
    ).to.deep.equal({
      status: 200,
      message: 'The audit "cwv" has been enabled for the "https://site0.com".',
    });
    expect(
      patchResponse[1],
      'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
        + '"https://site0.com", but it was not',
    ).to.deep.equal({
      status: 200,
      message: 'The audit "404" has been enabled for the "https://site0.com".',
    });
    expect(
      patchResponse[2],
      'Expected the status of patchResponse[2] to be 200 and message indicating "cwv" has been disabled for '
        + '"https://site.com", but it was not',
    ).to.deep.equal({
      status: 200,
      message: 'The audit "cwv" has been disabled for the "https://site1.com".',
    });
    expect(
      patchResponse[3],
      'Expected the status of patchResponse[3] to be 200 and message indicating "404" has been disabled for '
        + '"https://site.com", but it was not',
    ).to.deep.equal({
      status: 200,
      message: 'The audit "404" has been disabled for the "https://site1.com".',
    });
  });

  describe('500 Internal Server Error', () => {
    it('if the context object is not provided', async () => {
      const response = await sitesAuditsToggleController.execute();
      const error = await response.json();

      checkRequestFailure(response, 500, error, publicInternalErrorMessage);
    });

    it('if the context object is empty', async () => {
      const response = await sitesAuditsToggleController.execute({});
      const error = await response.json();

      checkRequestFailure(response, 500, error, publicInternalErrorMessage);
    });

    it('if an error occurred while saving the configuration', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves({
        getId: () => 'site0', getBaseURL: () => 'https://site0.com', getDeliveryType: () => 'aem_edge',
      });

      const privateInternalServerError = 'Some internal private error';
      configurationMock.save.rejects(new Error(privateInternalServerError));

      const requestData = [
        { baseURL: 'https://site0.com', auditType: 'cwv', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({
        data: requestData,
        log: logMock,
      });
      const error = await response.json();

      expect(
        logMock.error.calledWith(privateInternalServerError),
        'Expected log.error to be called with the privateInternalServerError message',
      ).to.be.true;

      expect(response.status).to.equal(500, `Expected response status to be 500, but got ${response.status}`);
      expect(error).to.have.property(
        'message',
        publicInternalErrorMessage,
        `Expected error message to be "${publicInternalErrorMessage}", but got "${error.message}"`,
      );
    });
  });

  describe('400 Bad Request Errors', () => {
    it('if request body is not provided', async () => {
      const response = await sitesAuditsToggleController.execute({ context: {} });
      const error = await response.json();

      checkRequestFailure(response, 400, error, 'Request body is required.');
    });

    it('if request body is empty', async () => {
      const response = await sitesAuditsToggleController.execute({ context: { data: {} } });
      const error = await response.json();

      checkRequestFailure(response, 400, error, 'Request body is required.');
    });
  });

  describe('Error during partial update of sites audits configuration (an operation in the bulk response 400/404)', () => {
    it('if Site URL is not provided', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { auditType: 'cwv', enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];

      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and message indicating that the site URL is required, but it was not.',
      ).to.deep.equal({
        status: 400,
        message: 'Site URL is required.',
      });
      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if Site URL is empty', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: '', auditType: 'cwv', enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and message indicating that the site URL is required, but it was not.',
      ).to.deep.equal({
        status: 400,
        message: 'Site URL is required.',
      });
      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if Site URL has wrong format', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'wrong_format', auditType: 'cwv', enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and a message indicating that the site URL is in the wrong format, but it did not.',
      ).to.deep.equal({
        status: 400,
        message: 'Invalid Site URL format: "wrong_format".',
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if the audit types parameter is missing', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(sites[0]);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site0.com', auditType: [], enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and a message indicating that at least one audit type is required, but it did not.',
      ).to.deep.equal({
        status: 400,
        message: 'Audit type is required.',
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if "enable" parameter is missed', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(sites[0]);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site0.com', auditType: 'cwv' },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and a message indicating that the "enable" parameter is required and must be set to a boolean value (true or false), but it did not match the expected output.',
      ).to.deep.equal({
        status: 400,
        message: 'The "enable" parameter is required and must be set to a boolean value: true or false.',
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if "enable" parameter is not a boolean value', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(sites[0]);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site0.com', auditType: 'cwv', enable: 'not_boolean' },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 400 and a message indicating that the "enable" parameter is required and must be set to a boolean value (true or false), but it did not match the expected output.',
      ).to.deep.equal({
        status: 400,
        message: 'The "enable" parameter is required and must be set to a boolean value: true or false.',
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if the site is not found', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const requestData = [
        { baseURL: 'https://site0.com', auditType: 'cwv', enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 404 and a message indicating that the site with '
          + 'the baseURL "https://site0.com" was not found, but it did not match the expected output.',
      ).to.deep.equal({
        status: 404,
        message: 'Site with baseURL: https://site0.com not found.',
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });

    it('if an audit type is not present in the configuration', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(sites[0]);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(sites[1]);

      const auditType = 'not_present_in_configuration_audit';
      const requestData = [
        { baseURL: 'https://site0.com', auditType, enable: true },
        { baseURL: 'https://site1.com', auditType: '404', enable: true },
      ];
      const response = await sitesAuditsToggleController.execute({ data: requestData });
      const patchResponse = await response.json();

      expect(
        configurationMock.enableHandlerForSite.calledOnceWith('404', sites[1]),
        'Expected configuration.enableHandlerForSite to be called once with arguments "404" and sites[1], but it was not.',
      ).to.be.true;
      expect(
        configurationMock.save.called,
        'Expected dataAccess.updateConfiguration to be called, but it was not.',
      ).to.be.true;

      expect(
        patchResponse[0],
        'Expected patchResponse[0] to have a status of 404 and a message indicating that the audit '
          + 'is not present in the configuration, but it did not match the expected output.',
      ).to.deep.equal({
        status: 404,
        message: `The "${auditType}" is not present in the configuration. List of allowed audits:`
          + ` ${Object.keys(handlers).join(', ')}.`,
      });

      expect(
        patchResponse[1],
        'Expected the status of patchResponse[1] to be 200 and message indicating "404" has been enabled for '
          + '"https://site0.com", but it was not',
      ).to.deep.equal({
        status: 200,
        message: 'The audit "404" has been enabled for the "https://site1.com".',
      });
    });
  });

  describe('misc errors', () => {
    it('throws an error if data access is not an object', () => {
      expect(() => SitesAuditsToggleController()).to.throw('Data access required');
    });
  });
});
