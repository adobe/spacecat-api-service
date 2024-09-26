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

  const mockDataAccess = {
    getAuditsForSite: sandbox.stub(),
    getLatestAudits: sandbox.stub(),
    getLatestAuditsForSite: sandbox.stub(),
    getLatestAuditForSite: sandbox.stub(),
    patchAuditForSite: sandbox.stub(),
    getSiteByID: sandbox.stub(),
    updateSite: sandbox.stub(),
  };

  let sitesAuditsController;

  beforeEach(() => {
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

  it('throws an error if data access is not an object', () => {
    expect(() => SitesAuditsController()).to.throw('Data access required');
  });

  it('updateSitesAudits', () => {
    let mockDataAccess;
    let sitesAuditsController;

    beforeEach(() => {
      mockDataAccess = {
        addSite: sandbox.stub().resolves(sites[0]),
        updateSite: sandbox.stub().resolves(sites[0]),
        removeSite: sandbox.stub().resolves(),
        getSites: sandbox.stub().resolves(sites),
        getSitesByDeliveryType: sandbox.stub().resolves(sites),
        getSiteByBaseURL: sandbox.stub().resolves(sites[0]),
        getSiteByID: sandbox.stub().resolves(sites[0]),
        createKeyEvent: sandbox.stub(),
        getKeyEventsForSite: sandbox.stub(),
        removeKeyEvent: sandbox.stub(),
      };

      sitesAuditsController = SitesAuditsController(mockDataAccess);
    });

    it('updates multiple sites and returns their responses', async () => {
      const baseURLs = ['https://site1.com', 'https://site2.com'];
      const enableAudits = true;
      const auditTypes = ['type1', 'type2'];

      const site1 = SiteDto.fromJson({ id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' });
      const site2 = SiteDto.fromJson({ id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' });

      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(site1);
      mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(site2);

      const response = await sitesAuditsController.update({
        data: { baseURLs, enableAudits, auditTypes },
      });

      expect(mockDataAccess.getSiteByBaseURL.calledTwice).to.be.true;
      expect(mockDataAccess.updateSite.calledTwice).to.be.true;
      expect(response.status).to.equal(207);
      const multiResponse = await response.json();
      expect(multiResponse).to.be.an('array').with.lengthOf(2);
      expect(multiResponse[0].baseURL).to.equal('https://site1.com');
      expect(multiResponse[0].response.status).to.equal(200);
      expect(multiResponse[1].baseURL).to.equal('https://site2.com');
      expect(multiResponse[1].response.status).to.equal(200);
    });

    it('returns bad request when baseURLs is not provided', async () => {
      const response = await sitesAuditsController.update({ data: {} });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'Base URLs are required');
    });

    it('returns bad request when auditTypes is not provided', async () => {
      const response = await sitesAuditsController.update({ data: { baseURLs: ['https://site1.com'] } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'Audit types are required');
    });

    it('returns bad request when enableAudits is not provided', async () => {
      const response = await sitesAuditsController.update({ data: { baseURLs: ['https://site1.com'], auditTypes: ['type1'] } });
      const error = await response.json();

      expect(response.status).to.equal(400);
      expect(error).to.have.property('message', 'enableAudits is required');
    });

    it('returns not found when site is not found', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(null);

      const response = await sitesAuditsController.update({
        data: { baseURLs: ['https://site1.com'], enableAudits: true, auditTypes: ['type1'] },
      });
      const responses = await response.json();

      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(404);
      expect(responses[0].response.message).to.equal('Site with baseURL: https://site1.com not found');
    });

    it('returns 500 when org is not found', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(SiteDto.fromJson({
        id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge', organizationId: '12345678',
      }));
      mockDataAccess.getOrganizationByID.resolves(null);

      const response = await sitesAuditsController.update({
        data: { baseURLs: ['https://site1.com'], enableAudits: true, auditTypes: ['type1'] },
      });
      const responses = await response.json();

      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(500);
      expect(responses[0].response.message).to.equal('Error updating site  with baseURL: https://site1.com, organization with id: 12345678 organization not found');
    });

    it('return 500 when site cannot be updated', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(SiteDto.fromJson({
        id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge',
      }));
      mockDataAccess.updateSite.rejects(new Error('Update site operation failed'));
      const response = await sitesController.updateSitesAudits({
        data: { baseURLs: ['https://site1.com'], enableAudits: true, auditTypes: ['type1'] },
      });

      const responses = await response.json();

      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(500);
      expect(responses[0].response.message).to.equal('Error updating site with with baseURL: https://site1.com, update site operation failed');
    });

    it('return 500 when site organization cannot be updated', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(SiteDto.fromJson({
        id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge', organizationId: '12345678',
      }));
      mockDataAccess.getOrganizationByID.resolves(OrganizationDto.fromJson({ name: 'Org1' }));
      mockDataAccess.updateOrganization.rejects(new Error('Update organization operation failed'));
      const response = await sitesController.update({
        data: { baseURLs: ['https://site1.com'], enableAudits: true, auditTypes: ['type1'] },
      });

      const responses = await response.json();

      expect(responses).to.be.an('array').with.lengthOf(1);
      expect(responses[0].baseURL).to.equal('https://site1.com');
      expect(responses[0].response.status).to.equal(500);
      expect(responses[0].response.message).to.equal('Error updating site with baseURL: https://site1.com, update site organization with id: 12345678 failed');
    });
  });
});
