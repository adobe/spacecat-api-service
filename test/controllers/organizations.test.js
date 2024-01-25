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

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import OrganizationsController from '../../src/controllers/organizations.js';
import { OrganizationDto } from '../../src/dto/organization.js';
import { SiteDto } from '../../src/dto/site.js';

chai.use(chaiAsPromised);

const { expect } = chai;

describe('Organizations Controller', () => {
  const sandbox = sinon.createSandbox();
  const sites = [
    {
      id: 'site1', organizationId: 'org1', baseURL: 'https://site1.com', deliveryType: 'aem_edge',
    },
    {
      id: 'site2', organizationId: 'org2', baseURL: 'https://site2.com', deliveryType: 'aem_edge',
    },
  ].map((site) => SiteDto.fromJson(site));

  const organizations = [
    { id: 'org1', name: 'Org 1' },
    { id: 'org2', name: 'Org 2' },
  ].map((org) => OrganizationDto.fromJson(org));

  const organizationFunctions = [
    'createOrganization',
    'getAll',
    'getByID',
    'getSitesForOrganization',
    'removeOrganization',
    'updateOrganization',
  ];

  let mockDataAccess;
  let organizationsController;

  beforeEach(() => {
    mockDataAccess = {
      addOrganization: sandbox.stub().resolves(organizations[0]),
      updateOrganization: sandbox.stub().resolves(organizations[0]),
      removeOrganization: sandbox.stub().resolves(),
      getOrganizations: sandbox.stub().resolves(organizations),
      getOrganizationByID: sandbox.stub().resolves(organizations[0]),
      getSitesByOrganizationID: sandbox.stub().resolves([sites[0]]),
    };

    organizationsController = OrganizationsController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    organizationFunctions.forEach((funcName) => {
      expect(organizationsController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(organizationsController).forEach((funcName) => {
      expect(organizationFunctions).to.include(funcName);
    });
  });

  it('throws an error if data access is not an object', () => {
    expect(() => OrganizationsController()).to.throw('Data access required');
  });

  it('creates an organization', async () => {
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
    });

    expect(mockDataAccess.addOrganization.calledOnce).to.be.true;
    expect(response.status).to.equal(201);

    const organization = await response.json();
    expect(organization).to.have.property('id', 'org1');
    expect(organization).to.have.property('name', 'Org 1');
  });

  it('returns bad request when creating an organization with invalid data', async () => {
    const response = await organizationsController.createOrganization({ params: {} });
    const error = await response.json();

    expect(mockDataAccess.addOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Org name must be provided');
  });

  it('updates an organization', async () => {
    const response = await organizationsController.updateOrganization({
      params: { organizationId: 'org1' },
      data: {
        imsOrgId: '1234abcd@AdobeOrg',
        name: 'Organization 1',
        config: {},
      },
    });

    expect(mockDataAccess.updateOrganization.calledOnce).to.be.true;
    expect(response.status).to.equal(200);

    const organization = await response.json();
    expect(organization).to.have.property('id', 'org1');
    expect(organization).to.have.property('name', 'Organization 1');
  });

  it('returns bad request when updating an organization if id not provided', async () => {
    const response = await organizationsController.updateOrganization({ params: {} });
    const error = await response.json();

    expect(mockDataAccess.updateOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('returns not found when updating a non-existing organization', async () => {
    mockDataAccess.getOrganizationByID.resolves(null);

    const response = await organizationsController.updateOrganization({ params: { organizationId: 'org1' } });
    const error = await response.json();

    expect(mockDataAccess.updateOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('returns bad request when updating an organization without payload', async () => {
    const response = await organizationsController.updateOrganization({ params: { organizationId: 'org1' } });
    const error = await response.json();

    expect(mockDataAccess.updateOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Request body required');
  });

  it('returns bad request when updating an organization without modifications', async () => {
    const response = await organizationsController.updateOrganization({ params: { organizationId: 'org1' }, data: {} });
    const error = await response.json();

    expect(mockDataAccess.updateOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes an organization', async () => {
    const response = await organizationsController.removeOrganization({ params: { organizationId: 'org1' } });

    expect(mockDataAccess.removeOrganization.calledOnce).to.be.true;
    expect(response.status).to.equal(204);
  });

  it('returns bad request when removing a site if id not provided', async () => {
    const response = await organizationsController.removeOrganization({ params: {} });
    const error = await response.json();

    expect(mockDataAccess.removeOrganization.calledOnce).to.be.false;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('gets all organizations', async () => {
    mockDataAccess.getOrganizations.resolves(organizations);

    const result = await organizationsController.getAll();
    const resultOrganizations = await result.json();

    expect(mockDataAccess.getOrganizations.calledOnce).to.be.true;
    expect(resultOrganizations).to.be.an('array').with.lengthOf(2);
    expect(resultOrganizations[0]).to.have.property('id', 'org1');
    expect(resultOrganizations[1]).to.have.property('id', 'org2');
  });

  it('gets all sites of an organization', async () => {
    mockDataAccess.getSitesByOrganizationID.resolves(sites);

    const result = await organizationsController.getSitesForOrganization({ params: { organizationId: 'org1' } });
    const resultSites = await result.json();

    expect(mockDataAccess.getSitesByOrganizationID.calledOnce).to.be.true;
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', 'site1');
    expect(resultSites[1]).to.have.property('id', 'site2');
  });

  it('returns bad request if organization id is not provided when getting sites for organization', async () => {
    const result = await organizationsController.getSitesForOrganization({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('gets an organization by id', async () => {
    const result = await organizationsController.getByID({ params: { organizationId: 'org1' } });
    const organization = await result.json();

    expect(mockDataAccess.getOrganizationByID.calledOnce).to.be.true;

    expect(organization).to.be.an('object');
    expect(organization).to.have.property('id', 'org1');
  });

  it('returns not found when an organization is not found by id', async () => {
    mockDataAccess.getOrganizationByID.resolves(null);

    const result = await organizationsController.getByID({ params: { organizationId: 'org1' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('returns bad request if organization id is not provided', async () => {
    const result = await organizationsController.getByID({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });
});
