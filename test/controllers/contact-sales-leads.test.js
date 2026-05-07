/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import ContactSalesLeadsController from '../../src/controllers/contact-sales-leads.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('ContactSalesLeads Controller', () => {
  const sandbox = sinon.createSandbox();
  const organizationId = '123e4567-e89b-12d3-a456-426614174000';
  const siteId = '223e4567-e89b-12d3-a456-426614174099';
  const imsOrgId = 'test-ims-org-id@AdobeOrg';

  const mockOrganization = {
    getId: () => organizationId,
    getImsOrgId: () => imsOrgId,
  };

  const mockLead = {
    getId: () => 'lead-123',
    getOrganizationId: () => organizationId,
    getSiteId: () => siteId,
    getName: () => 'Test User',
    getEmail: () => 'test@example.com',
    getDomain: () => 'https://example.com',
    getNotes: () => null,
    getStatus: () => 'NEW',
    getCreatedAt: () => '2026-01-01T00:00:00Z',
    getUpdatedAt: () => '2026-01-01T00:00:00Z',
  };

  let mockAccessControlUtil;

  const mockDataAccess = {
    ContactSalesLead: {
      findById: sandbox.stub(),
      findByAll: sandbox.stub(),
      create: sandbox.stub(),
      allByOrganizationId: sandbox.stub(),
    },
    Organization: {
      findById: sandbox.stub(),
    },
    Entitlement: {},
    SiteEnrollment: {},
    TrialUser: {},
    OrganizationIdentityProvider: {},
  };

  const mockLogger = {
    error: sandbox.stub(),
    info: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  let contactSalesLeadsController;

  beforeEach(() => {
    sandbox.restore();

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(true),
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    mockDataAccess.ContactSalesLead.findByAll = sandbox.stub().resolves(null);
    mockDataAccess.ContactSalesLead.findById = sandbox.stub();
    mockDataAccess.ContactSalesLead.create = sandbox.stub().resolves(mockLead);
    mockDataAccess.ContactSalesLead.allByOrganizationId = sandbox.stub().resolves([]);
    mockDataAccess.Organization.findById = sandbox.stub().resolves(mockOrganization);

    contactSalesLeadsController = ContactSalesLeadsController({
      dataAccess: mockDataAccess,
      log: mockLogger,
      pathInfo: { method: 'POST', suffix: '/contact-sales-leads', headers: {} },
      attributes: {
        authInfo: new AuthInfo()
          .withAuthenticated(true)
          .withProfile({
            email: 'test@example.com',
            name: 'Test User',
            tenants: [{ id: 'test-ims-org-id' }],
          })
          .withType('ims'),
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('throws when context is missing', () => {
      expect(() => ContactSalesLeadsController())
        .to.throw('Context required');
    });

    it('throws when data access is missing', () => {
      expect(() => ContactSalesLeadsController({ log: mockLogger }))
        .to.throw('Data access required');
    });
  });

  describe('create', () => {
    const createContext = (data = {}) => ({
      params: { organizationId, siteId },
      data,
      log: mockLogger,
      attributes: {
        authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
      },
    });

    it('creates a new contact sales lead successfully', async () => {
      const context = createContext({
        name: 'Test User',
        email: 'test@example.com',
        domain: 'https://example.com',
        notes: 'Some notes',
      });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(201);

      const body = await response.json();
      expect(body.name).to.equal('Test User');
      expect(body.email).to.equal('test@example.com');
      expect(body.domain).to.equal('https://example.com');
      expect(body.siteId).to.equal(siteId);
      expect(body.status).to.equal('NEW');
    });

    it('creates a lead without optional domain and notes', async () => {
      const context = createContext({
        name: 'Test User',
        email: 'test@example.com',
      });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(201);
    });

    it('returns 400 when name is missing', async () => {
      const context = createContext({ email: 'test@example.com' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when context data is missing', async () => {
      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: { authInfo: new AuthInfo().withAuthenticated(true).withType('ims') },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when email is missing', async () => {
      const context = createContext({ name: 'Test User' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when email is invalid', async () => {
      const context = createContext({ name: 'Test User', email: 'not-an-email' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = createContext({ name: 'Test User', email: 'test@example.com' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to the organization', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = createContext({ name: 'Test User', email: 'test@example.com' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(403);
    });

    it('returns 409 when a lead already exists for the same org and site', async () => {
      mockDataAccess.ContactSalesLead.findByAll.resolves(mockLead);

      const context = createContext({ name: 'Test User', email: 'test@example.com' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(409);
    });

    it('returns 500 on unexpected error with generic message', async () => {
      mockDataAccess.Organization.findById.rejects(new Error('DB connection refused'));

      const context = createContext({ name: 'Test User', email: 'test@example.com' });

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to create contact sales lead');
    });
  });

  describe('getByOrganizationId', () => {
    beforeEach(() => {
      mockDataAccess.ContactSalesLead.allByOrganizationId.resolves([mockLead]);
    });

    it('returns leads for a valid organization', async () => {
      const context = {
        params: { organizationId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body).to.be.an('array').with.length(1);
      expect(body[0].name).to.equal('Test User');
    });

    it('returns 400 for invalid organization ID', async () => {
      const context = {
        params: { organizationId: 'invalid' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to the organization', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(403);
    });

    it('returns 500 on unexpected error with generic message', async () => {
      mockDataAccess.Organization.findById.rejects(new Error('DB error'));

      const context = {
        params: { organizationId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to retrieve contact sales leads');
    });
  });

  describe('checkBySite', () => {
    it('returns exists=true when a lead matches the org and site', async () => {
      mockDataAccess.ContactSalesLead.findByAll.resolves(mockLead);

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.exists).to.be.true;
      expect(body.lead).to.have.property('id', 'lead-123');
    });

    it('returns exists=false when no lead matches the site', async () => {
      mockDataAccess.ContactSalesLead.findByAll.resolves(null);

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.exists).to.be.false;
    });

    it('returns 400 for invalid organization ID', async () => {
      const context = {
        params: { organizationId: 'invalid', siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 for invalid site ID', async () => {
      const context = {
        params: { organizationId, siteId: 'invalid' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(400);
    });

    it('returns 404 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to the organization', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(403);
    });

    it('returns 500 on unexpected error with generic message', async () => {
      mockDataAccess.Organization.findById.rejects(new Error('DB error'));

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to check contact sales lead');
    });
  });

  describe('update', () => {
    const contactSalesLeadId = '123e4567-e89b-12d3-a456-426614174001';

    const mockUpdatableLead = {
      getId: () => contactSalesLeadId,
      getOrganizationId: () => organizationId,
      getSiteId: () => siteId,
      getName: () => 'Test User',
      getEmail: () => 'test@example.com',
      getDomain: () => 'https://example.com',
      getNotes: () => 'Updated notes',
      getStatus: () => 'CONTACTED',
      getCreatedAt: () => '2026-01-01T00:00:00Z',
      getUpdatedAt: () => '2026-01-15T00:00:00Z',
      setStatus: sandbox.stub(),
      setNotes: sandbox.stub(),
      save: sandbox.stub(),
    };

    beforeEach(() => {
      mockUpdatableLead.setStatus.resetHistory();
      mockUpdatableLead.setNotes.resetHistory();
      mockUpdatableLead.save.resetHistory();
      mockUpdatableLead.save.resolves(mockUpdatableLead);
      mockDataAccess.ContactSalesLead.findById.resolves(mockUpdatableLead);
    });

    it('updates status successfully', async () => {
      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.status).to.equal('CONTACTED');
      expect(mockUpdatableLead.setStatus).to.have.been.calledWith('CONTACTED');
      expect(mockUpdatableLead.save).to.have.been.calledOnce;
    });

    it('updates notes successfully', async () => {
      const context = {
        params: { contactSalesLeadId },
        data: { notes: 'Some notes' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(200);

      expect(mockUpdatableLead.setNotes).to.have.been.calledWith('Some notes');
      expect(mockUpdatableLead.setStatus).not.to.have.been.called;
      expect(mockUpdatableLead.save).to.have.been.calledOnce;
    });

    it('updates both status and notes', async () => {
      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED', notes: 'Called the customer' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(200);

      expect(mockUpdatableLead.setStatus).to.have.been.calledWith('CONTACTED');
      expect(mockUpdatableLead.setNotes).to.have.been.calledWith('Called the customer');
      expect(mockUpdatableLead.save).to.have.been.calledOnce;
    });

    it('returns 400 for invalid lead ID', async () => {
      const context = {
        params: { contactSalesLeadId: 'invalid' },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when data is missing entirely', async () => {
      const context = {
        params: { contactSalesLeadId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when neither status nor notes is provided', async () => {
      const context = {
        params: { contactSalesLeadId },
        data: {},
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 for invalid status value', async () => {
      const context = {
        params: { contactSalesLeadId },
        data: { status: 'INVALID_STATUS' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(400);
    });

    it('returns 404 when lead is not found', async () => {
      mockDataAccess.ContactSalesLead.findById.resolves(null);

      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to the lead organization', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(403);
    });

    it('returns 403 for non-admin updating lead without organization', async () => {
      const leadNoOrg = {
        ...mockUpdatableLead,
        getOrganizationId: () => null,
      };
      mockDataAccess.ContactSalesLead.findById.resolves(leadNoOrg);
      mockAccessControlUtil.hasAdminAccess.returns(false);

      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(403);
    });

    it('returns 500 on unexpected error with generic message', async () => {
      mockDataAccess.ContactSalesLead.findById.rejects(new Error('DB error'));

      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.update(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to update contact sales lead');
    });
  });
});
