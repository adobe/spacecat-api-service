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

import { Organization, Site } from '@adobe/spacecat-shared-data-access';
import { SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon, { stub } from 'sinon';

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import OrganizationSchema from '@adobe/spacecat-shared-data-access/src/models/organization/organization.schema.js';
import SiteSchema from '@adobe/spacecat-shared-data-access/src/models/site/site.schema.js';

import OrganizationsController from '../../src/controllers/organizations.js';

use(chaiAsPromised);
use(sinonChai);

describe('Organizations Controller', () => {
  const sandbox = sinon.createSandbox();
  const sites = [
    {
      siteId: 'site1',
      organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28',
      baseURL: 'https://site1.com',
      deliveryType: 'aem_edge',
      config: Config({}),
    },
    {
      siteId: 'site2',
      organizationId: '5f3b3626-029c-476e-924b-0c1bba2e871f',
      baseURL: 'https://site2.com',
      deliveryType: 'aem_edge',
      config: Config({}),
    },
  ].map((site) => new Site(
    { entities: { site: { model: {} } } },
    {
      log: console,
      getCollection: stub().returns({
        schema: SiteSchema,
        findById: stub(),
      }),
    },
    SiteSchema,
    site,
    console,
  ));

  const sampleConfig1 = Config({
    slack: {
      channel: 'C0123456789',
      workspace: SLACK_TARGETS.WORKSPACE_EXTERNAL,
    },
    handlers: {},
    imports: [],
  });

  const sampleConfig2 = Config({
    slack: { workspace: SLACK_TARGETS.WORKSPACE_EXTERNAL },
    handlers: {},
    imports: [],
  });

  const organizations = [
    { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28', name: 'Org 1' },
    {
      organizationId: '5f3b3626-029c-476e-924b-0c1bba2e871f',
      name: 'Org 2',
      imsOrgId: '1234567890ABCDEF12345678@AdobeOrg',
    },
    {
      organizationId: 'org3',
      name: 'Org 3',
      imsOrgId: '9876567890ABCDEF12345678@AdobeOrg',
    },
  ].map((org) => new Organization(
    {
      entities: {
        organization: {
          model: {
            indexes: {},
            schema: {
              attributes: {
                organizationId: { type: 'string', get: (value) => value },
                config: { type: 'any', get: (value) => Config(value) },
                name: { type: 'string', get: (value) => value },
                imsOrgId: { type: 'string', get: (value) => value },
              },
            },
          },
          patch: sinon.stub().returns({
            composite: () => ({ go: () => {} }),
            set: () => {},
          }),
        },
      },
    },
    {
      log: console,
      getCollection: stub().returns({
        schema: OrganizationSchema,
        findById: stub(),
      }),
    },
    OrganizationSchema,
    org,
    console,
  ));

  organizations[0].getConfig = sinon.stub().returns(sampleConfig1);
  organizations[1].getConfig = sinon.stub().returns(sampleConfig1);
  organizations[2].getConfig = sinon.stub().returns(sampleConfig2);

  const organizationFunctions = [
    'createOrganization',
    'getAll',
    'getByID',
    'getSitesForOrganization',
    'getByImsOrgID',
    'getSlackConfigByImsOrgID',
    'removeOrganization',
    'updateOrganization',
  ];

  let mockDataAccess;
  let organizationsController;

  beforeEach(() => {
    mockDataAccess = {
      Organization: {
        all: sinon.stub(),
        create: sinon.stub(),
        findById: sinon.stub(),
        findByImsOrgId: sinon.stub(),
      },
      Site: {
        allByOrganizationId: sinon.stub(),
      },
    };

    const env = {
      SLACK_URL_WORKSPACE_EXTERNAL: 'https://example-workspace.slack.com',
    };

    organizationsController = OrganizationsController(mockDataAccess, env);
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

  it('throws an error if env param is not an object', () => {
    expect(() => OrganizationsController(mockDataAccess)).to.throw('Environment object required');
  });

  it('creates an organization', async () => {
    mockDataAccess.Organization.create.resolves(organizations[0]);
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
    });

    expect(mockDataAccess.Organization.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);

    const organization = await response.json();
    expect(organization).to.have.property('id', '9033554c-de8a-44ac-a356-09b51af8cc28');
    expect(organization).to.have.property('name', 'Org 1');
  });

  it('returns bad request when creating an organization fails', async () => {
    mockDataAccess.Organization.create.rejects(new Error('Failed to create organization'));
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
    });

    expect(mockDataAccess.Organization.create).to.have.been.calledOnce;
    expect(response.status).to.equal(400);

    const error = await response.json();
    expect(error).to.have.property('message', 'Failed to create organization');
  });

  it('updates an organization', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.updateOrganization({
      params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' },
      data: {
        imsOrgId: '1234abcd@AdobeOrg',
        name: 'Organization 1',
        config: {},
      },
    });

    expect(organizations[0].save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);
  });

  it('returns bad request when updating an organization if id not provided', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.updateOrganization({ params: {} });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('returns not found when updating a non-existing organization', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(null);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('returns bad request when updating an organization without payload', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Request body required');
  });

  it('returns bad request when updating an organization without modifications', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, data: {} });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes an organization', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.removeOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });

    expect(organizations[0].remove).to.have.been.calledOnce;
    expect(response.status).to.equal(204);
  });

  it('returns bad request when removing a site if id not provided', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.removeOrganization({ params: {} });
    const error = await response.json();

    expect(organizations[0].remove).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('returns not found when removing a non-existing organization', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(null);

    const response = await organizationsController.removeOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
    const error = await response.json();

    expect(organizations[0].remove).to.not.have.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('gets all organizations', async () => {
    mockDataAccess.Organization.all.resolves(organizations);

    const result = await organizationsController.getAll();
    const resultOrganizations = await result.json();

    expect(mockDataAccess.Organization.all).to.have.been.calledOnce;
    expect(resultOrganizations).to.be.an('array').with.lengthOf(3);
    expect(resultOrganizations[0]).to.have.property('id', '9033554c-de8a-44ac-a356-09b51af8cc28');
    expect(resultOrganizations[1]).to.have.property('id', '5f3b3626-029c-476e-924b-0c1bba2e871f');
  });

  it('gets all sites of an organization', async () => {
    mockDataAccess.Site.allByOrganizationId.resolves(sites);

    const result = await organizationsController.getSitesForOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allByOrganizationId).to.have.been.calledOnceWith('9033554c-de8a-44ac-a356-09b51af8cc28');
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
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const result = await organizationsController.getByID({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
    const organization = await result.json();

    expect(mockDataAccess.Organization.findById).to.have.been.calledOnceWith('9033554c-de8a-44ac-a356-09b51af8cc28');

    expect(organization).to.be.an('object');
    expect(result.status).to.equal(200);
    expect(organization).to.have.property('id', '9033554c-de8a-44ac-a356-09b51af8cc28');
  });

  it('returns not found when an organization is not found by id', async () => {
    mockDataAccess.Organization.findById.resolves(null);

    const result = await organizationsController.getByID({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' } });
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

  it('gets an organization by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getByImsOrgID({ params: { imsOrgId } });
    const organization = await result.json();

    expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledOnceWith(imsOrgId);

    expect(organization).to.be.an('object');
    expect(result.status).to.equal(200);
    expect(organization).to.have.property('imsOrgId', imsOrgId);
  });

  it('returns not found when an organization is not found by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(null);

    const result = await organizationsController.getByImsOrgID({ params: { imsOrgId: 'not-found@AdobeOrg' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found by IMS org ID: not-found@AdobeOrg');
  });

  it('returns bad request if IMS org ID is not provided', async () => {
    const result = await organizationsController.getByImsOrgID({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'IMS org ID required');
  });

  it('gets the Slack config of an organization by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getSlackConfigByImsOrgID({ params: { imsOrgId } });
    const slackConfig = await result.json();

    expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledOnceWith(imsOrgId);

    expect(slackConfig).to.be.an('object');
    expect(slackConfig).to.deep.equal({
      channel: 'C0123456789',
      workspace: SLACK_TARGETS.WORKSPACE_EXTERNAL,
      'channel-url': 'https://example-workspace.slack.com/archives/C0123456789',
    });
  });

  it('returns not found when an organization is not found by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(null);

    const result = await organizationsController.getSlackConfigByImsOrgID({ params: { imsOrgId: 'not-found@AdobeOrg' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found by IMS org ID: not-found@AdobeOrg');
  });

  it('returns bad request if IMS org ID is not provided', async () => {
    const result = await organizationsController.getSlackConfigByImsOrgID({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'IMS org ID required');
  });

  it('returns not found when an organization does not have a Slack channel configuration', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[2]);

    const result = await organizationsController.getSlackConfigByImsOrgID({ params: { imsOrgId: '9876567890ABCDEF12345678@AdobeOrg' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Slack config not found for IMS org ID: 9876567890ABCDEF12345678@AdobeOrg');
  });
});
