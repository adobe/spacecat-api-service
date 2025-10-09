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
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import OrganizationsController from '../../src/controllers/organizations.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Organizations Controller', () => {
  const sandbox = sinon.createSandbox();
  const orgId = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const sites = [
    {
      siteId: 'site1',
      organizationId: orgId,
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
    'getProjectsByOrganizationId',
    'getSitesByProjectIdAndOrganizationId',
    'getSitesByProjectNameAndOrganizationId',
    'getByImsOrgID',
    'getSlackConfigByImsOrgID',
    'removeOrganization',
    'updateOrganization',
  ];

  let mockDataAccess;
  let organizationsController;
  let context;
  let env;

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
        allByOrganizationIdAndProjectId: sinon.stub(),
        allByOrganizationIdAndProjectName: sinon.stub(),
      },
      Project: {
        allByOrganizationId: sinon.stub(),
      },
    };

    context = {
      dataAccess: mockDataAccess,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true)
        ,
      },
    };

    env = {
      SLACK_URL_WORKSPACE_EXTERNAL: 'https://example-workspace.slack.com',
    };

    organizationsController = OrganizationsController(context, env);
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

  it('throws an error if context is not an object', () => {
    expect(() => OrganizationsController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => OrganizationsController({ env })).to.throw('Data access required');
  });

  it('throws an error if env param is not an object', () => {
    expect(() => OrganizationsController({ dataAccess: mockDataAccess })).to.throw('Environment object required');
  });

  it('creates an organization', async () => {
    mockDataAccess.Organization.create.resolves(organizations[0]);
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
      ...context,
    });

    expect(mockDataAccess.Organization.create).to.have.been.calledOnce;
    expect(response.status).to.equal(201);

    const organization = await response.json();
    expect(organization).to.have.property('id', '9033554c-de8a-44ac-a356-09b51af8cc28');
    expect(organization).to.have.property('name', 'Org 1');
  });

  it('creates an organization for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Organization.create.resolves(organizations[0]);
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
      ...context,
    });
    expect(response.status).to.equal(403);

    const error = await response.json();
    expect(error).to.have.property('message', 'Only admins can create new Organizations');
  });

  it('returns bad request when creating an organization fails', async () => {
    mockDataAccess.Organization.create.rejects(new Error('Failed to create organization'));
    const response = await organizationsController.createOrganization({
      data: { name: 'Org 1' },
      ...context,
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
      ...context,
    });

    expect(organizations[0].save).to.have.been.calledOnce;
    expect(response.status).to.equal(200);
  });

  it('updates an organization for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    const response = await organizationsController.updateOrganization({
      params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' },
      data: {
        imsOrgId: '1234abcd@AdobeOrg',
        name: 'Organization 1',
        config: {},
      },
      ...context,
    });

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(403);

    const error = await response.json();
    expect(error).to.have.property('message', 'Only users belonging to the organization can update it');
  });

  it('returns bad request when updating an organization if id not provided', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.updateOrganization(
      { params: {}, ...context },
    );
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('returns not found when updating a non-existing organization', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(null);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('returns bad request when updating an organization without payload', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Request body required');
  });

  it('returns bad request when updating an organization without modifications', async () => {
    organizations[0].save = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);

    const response = await organizationsController.updateOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, data: {}, ...context });
    const error = await response.json();

    expect(organizations[0].save).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'No updates provided');
  });

  it('removes an organization', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.removeOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });

    expect(organizations[0].remove).to.have.been.calledOnce;
    expect(response.status).to.equal(204);
  });

  it('returns bad request when removing a site if id not provided', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.removeOrganization(
      { params: {}, ...context },
    );
    const error = await response.json();

    expect(organizations[0].remove).to.not.have.been.called;
    expect(response.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('returns unauthorized when removing a site for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const response = await organizationsController.removeOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await response.json();

    expect(organizations[0].remove).to.not.have.been.called;
    expect(response.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can delete Organizations');
  });

  it('returns not found when removing a non-existing organization', async () => {
    organizations[0].remove = sinon.stub().resolves(organizations[0]);
    mockDataAccess.Organization.findById.resolves(null);

    const response = await organizationsController.removeOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
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

  it('gets all organizations for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Organization.all.resolves(organizations);

    const response = await organizationsController.getAll();
    const error = await response.json();

    expect(response.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view all Organizations');
  });

  it('gets all sites of an organization', async () => {
    mockDataAccess.Site.allByOrganizationId.resolves(sites);
    mockDataAccess.Organization.findById.resolves(organizations[0]);

    const result = await organizationsController.getSitesForOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const resultSites = await result.json();

    expect(mockDataAccess.Site.allByOrganizationId).to.have.been.calledOnceWith('9033554c-de8a-44ac-a356-09b51af8cc28');
    expect(resultSites).to.be.an('array').with.lengthOf(2);
    expect(resultSites[0]).to.have.property('id', 'site1');
    expect(resultSites[1]).to.have.property('id', 'site2');
  });

  it('gets all sites of an organization for non belonging organization', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Site.allByOrganizationId.resolves(sites);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await organizationsController.getSitesForOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await result.json();
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view its sites');
  });

  it('gets all sites of an organization for non existing organization', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    mockDataAccess.Site.allByOrganizationId.resolves(sites);
    mockDataAccess.Organization.findById.resolves(null);
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    const result = await organizationsController.getSitesForOrganization({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await result.json();
    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found by IMS org ID: 9033554c-de8a-44ac-a356-09b51af8cc28');
  });

  it('returns bad request if organization id is not provided when getting sites for organization', async () => {
    const result = await organizationsController.getSitesForOrganization(
      { params: {}, ...context },
    );
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('gets an organization by id', async () => {
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const result = await organizationsController.getByID({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const organization = await result.json();

    expect(mockDataAccess.Organization.findById).to.have.been.calledOnceWith('9033554c-de8a-44ac-a356-09b51af8cc28');

    expect(organization).to.be.an('object');
    expect(result.status).to.equal(200);
    expect(organization).to.have.property('id', '9033554c-de8a-44ac-a356-09b51af8cc28');
  });

  it('gets an organization by id for non belonging organization', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    mockDataAccess.Organization.findById.resolves(organizations[0]);
    const result = await organizationsController.getByID({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await result.json();
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view it');
  });

  it('returns not found when an organization is not found by id', async () => {
    mockDataAccess.Organization.findById.resolves(null);

    const result = await organizationsController.getByID({ params: { organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28' }, ...context });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found');
  });

  it('returns bad request if organization id is not provided', async () => {
    const result = await organizationsController.getByID({ params: {}, ...context });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Organization ID required');
  });

  it('gets an organization by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getByImsOrgID(
      { params: { imsOrgId }, ...context },
    );
    const organization = await result.json();

    expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledOnceWith(imsOrgId);

    expect(organization).to.be.an('object');
    expect(result.status).to.equal(200);
    expect(organization).to.have.property('imsOrgId', imsOrgId);
  });

  it('gets an organization by IMS org ID for non belonging organization', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
    sandbox.stub(context.attributes.authInfo, 'hasOrganization').returns(false);
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getByImsOrgID(
      { params: { imsOrgId }, ...context },
    );
    const error = await result.json();

    expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledOnceWith(imsOrgId);
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only users belonging to the organization can view it');
  });

  it('returns not found when an organization is not found by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(null);

    const result = await organizationsController.getByImsOrgID({ params: { imsOrgId: 'not-found@AdobeOrg' }, ...context });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found by IMS org ID: not-found@AdobeOrg');
  });

  it('returns bad request if IMS org ID is not provided', async () => {
    const result = await organizationsController.getByImsOrgID({ params: {}, ...context });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'IMS org ID required');
  });

  it('gets the Slack config of an organization by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getSlackConfigByImsOrgID(
      { params: { imsOrgId }, ...context },
    );
    const slackConfig = await result.json();

    expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledOnceWith(imsOrgId);

    expect(slackConfig).to.be.an('object');
    expect(slackConfig).to.deep.equal({
      channel: 'C0123456789',
      workspace: SLACK_TARGETS.WORKSPACE_EXTERNAL,
      'channel-url': 'https://example-workspace.slack.com/archives/C0123456789',
    });
  });

  it('gets the Slack config of an organization by IMS org ID for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });

    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[1]);
    const imsOrgId = '1234567890ABCDEF12345678@AdobeOrg';
    const result = await organizationsController.getSlackConfigByImsOrgID(
      { params: { imsOrgId }, ...context },
    );
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view Slack configurations');
  });

  it('returns not found when an organization is not found by IMS org ID', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(null);

    const result = await organizationsController.getSlackConfigByImsOrgID({ params: { imsOrgId: 'not-found@AdobeOrg' }, ...context });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Organization not found by IMS org ID: not-found@AdobeOrg');
  });

  it('returns bad request if IMS org ID is not provided', async () => {
    const result = await organizationsController.getSlackConfigByImsOrgID(
      { params: {}, ...context },
    );
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'IMS org ID required');
  });

  it('returns not found when an organization does not have a Slack channel configuration', async () => {
    mockDataAccess.Organization.findByImsOrgId.resolves(organizations[2]);

    const result = await organizationsController.getSlackConfigByImsOrgID({ params: { imsOrgId: '9876567890ABCDEF12345678@AdobeOrg' }, ...context });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Slack config not found for IMS org ID: 9876567890ABCDEF12345678@AdobeOrg');
  });

  describe('getProjectsByOrganizationId', () => {
    it('gets all projects for an organization', async () => {
      const mockProjects = [
        { toJSON: () => ({ id: 'project1', name: 'Project 1' }) },
        { toJSON: () => ({ id: 'project2', name: 'Project 2' }) },
      ];

      mockDataAccess.Organization.findById.resolves(organizations[0]);
      mockDataAccess.Project.allByOrganizationId.resolves(mockProjects);

      const result = await organizationsController.getProjectsByOrganizationId({
        params: { organizationId: organizations[0].getId() },
        ...context,
      });
      const response = await result.json();

      expect(result.status).to.equal(200);
      expect(response).to.have.length(2);
      expect(response[0]).to.have.property('id', 'project1');
    });
  });

  describe('getSitesByProjectIdAndOrganizationId', () => {
    it('gets all sites for an organization by project ID', async () => {
      const mockSites = [
        { toJSON: () => ({ id: 'site1', baseURL: 'https://site1.com' }) },
        { toJSON: () => ({ id: 'site2', baseURL: 'https://site2.com' }) },
      ];

      mockDataAccess.Organization.findById.resolves(organizations[0]);
      mockDataAccess.Site.allByOrganizationIdAndProjectId.resolves(mockSites);

      const result = await organizationsController.getSitesByProjectIdAndOrganizationId({
        params: { organizationId: organizations[0].getId(), projectId: 'project-id-123' },
        ...context,
      });
      const response = await result.json();

      expect(result.status).to.equal(200);
      expect(response).to.have.length(2);
      expect(response[0]).to.have.property('id', 'site1');
    });

    it('returns bad request when organization ID is invalid', async () => {
      const result = await organizationsController.getSitesByProjectIdAndOrganizationId({
        params: { organizationId: 'invalid', projectId: 'project-id-123' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Organization ID required');
    });

    it('returns bad request when project ID is invalid', async () => {
      const result = await organizationsController.getSitesByProjectIdAndOrganizationId({
        params: { organizationId: organizations[0].getId(), projectId: 'invalid' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Project ID required');
    });
  });

  describe('getSitesByProjectNameAndOrganizationId', () => {
    it('gets all sites for an organization by project name', async () => {
      const mockSites = [
        { toJSON: () => ({ id: 'site1', baseURL: 'https://site1.com' }) },
        { toJSON: () => ({ id: 'site2', baseURL: 'https://site2.com' }) },
      ];

      mockDataAccess.Organization.findById.resolves(organizations[0]);
      mockDataAccess.Site.allByOrganizationIdAndProjectName.resolves(mockSites);

      const result = await organizationsController.getSitesByProjectNameAndOrganizationId({
        params: { organizationId: organizations[0].getId(), projectName: 'test-project' },
        ...context,
      });
      const response = await result.json();

      expect(result.status).to.equal(200);
      expect(response).to.have.length(2);
      expect(response[0]).to.have.property('id', 'site1');
    });

    it('returns bad request when organization ID is invalid', async () => {
      const result = await organizationsController.getSitesByProjectNameAndOrganizationId({
        params: { organizationId: 'invalid', projectName: 'test-project' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Organization ID required');
    });

    it('returns bad request when project name is missing', async () => {
      const result = await organizationsController.getSitesByProjectNameAndOrganizationId({
        params: { organizationId: organizations[0].getId(), projectName: '' },
        ...context,
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Project name required');
    });
  });
});
