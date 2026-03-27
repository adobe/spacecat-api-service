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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import esmock from 'esmock';

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
    getStatus: () => 'NEW',
    getCreatedAt: () => '2026-01-01T00:00:00Z',
    getUpdatedAt: () => '2026-01-01T00:00:00Z',
  };

  const mockDataAccess = {
    ContactSalesLead: {
      findByEmail: sandbox.stub(),
      findById: sandbox.stub(),
      create: sandbox.stub(),
      allByOrganizationId: sandbox.stub(),
    },
    Organization: {
      findById: sandbox.stub(),
      findByImsOrgId: sandbox.stub(),
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

  beforeEach(async () => {
    sandbox.restore();

    const ControllerUnderTest = await esmock('../../src/controllers/contact-sales-leads.js', {});

    mockDataAccess.ContactSalesLead.findByEmail.resolves(null);
    mockDataAccess.ContactSalesLead.create.resolves(mockLead);
    mockDataAccess.ContactSalesLead.allByOrganizationId.resolves([]);
    mockDataAccess.Organization.findById.resolves(mockOrganization);
    mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);

    const authInfo = new AuthInfo()
      .withAuthenticated(true)
      .withProfile({
        email: 'test@example.com',
        name: 'Test User',
        tenants: [{ id: 'test-ims-org-id' }],
      })
      .withType('ims');

    contactSalesLeadsController = ControllerUnderTest.default({
      dataAccess: mockDataAccess,
      log: mockLogger,
      pathInfo: { method: 'POST', suffix: '/contact-sales-leads', headers: {} },
      attributes: { authInfo },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('create', () => {
    it('creates a new contact sales lead successfully', async () => {
      const context = {
        data: {
          name: 'Test User',
          email: 'test@example.com',
          domain: 'https://example.com',
          siteId,
        },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withAuthenticated(true)
            .withProfile({
              email: 'test@example.com',
              tenants: [{ id: 'test-ims-org-id' }],
            })
            .withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(201);

      const body = await response.json();
      expect(body.name).to.equal('Test User');
      expect(body.email).to.equal('test@example.com');
      expect(body.domain).to.equal('https://example.com');
      expect(body.siteId).to.equal(siteId);
      expect(body.status).to.equal('NEW');
    });

    it('creates a lead without optional siteId', async () => {
      const context = {
        data: { name: 'Test User', email: 'test@example.com' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withAuthenticated(true)
            .withProfile({
              email: 'test@example.com',
              tenants: [{ id: 'test-ims-org-id' }],
            })
            .withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(201);
    });

    it('returns 400 when name is missing', async () => {
      const context = {
        data: { email: 'test@example.com' },
        log: mockLogger,
        attributes: { authInfo: new AuthInfo().withAuthenticated(true).withType('ims') },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when email is missing', async () => {
      const context = {
        data: { name: 'Test User' },
        log: mockLogger,
        attributes: { authInfo: new AuthInfo().withAuthenticated(true).withType('ims') },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when email is invalid', async () => {
      const context = {
        data: { name: 'Test User', email: 'not-an-email' },
        log: mockLogger,
        attributes: { authInfo: new AuthInfo().withAuthenticated(true).withType('ims') },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(400);
    });

    it('returns 409 when a lead already exists for the same org and site', async () => {
      mockDataAccess.ContactSalesLead.allByOrganizationId.resolves([mockLead]);

      const context = {
        data: {
          name: 'Test User',
          email: 'test@example.com',
          siteId,
        },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withAuthenticated(true)
            .withProfile({
              email: 'test@example.com',
              tenants: [{ id: 'test-ims-org-id' }],
            })
            .withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(409);
    });

    it('returns 409 when a lead with same email without site already exists', async () => {
      const mockLeadNoSite = {
        ...mockLead,
        getSiteId: () => null,
      };
      mockDataAccess.ContactSalesLead.allByOrganizationId.resolves([mockLeadNoSite]);

      const context = {
        data: { name: 'Test User', email: 'test@example.com' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withAuthenticated(true)
            .withProfile({
              email: 'test@example.com',
              tenants: [{ id: 'test-ims-org-id' }],
            })
            .withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(409);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.ContactSalesLead.allByOrganizationId.rejects(new Error('DB error'));

      const context = {
        data: { name: 'Test User', email: 'test@example.com' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo()
            .withAuthenticated(true)
            .withProfile({
              email: 'test@example.com',
              tenants: [{ id: 'test-ims-org-id' }],
            })
            .withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.create(context);
      expect(response.status).to.equal(500);
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

    it('returns 400 when organization is not found', async () => {
      mockDataAccess.Organization.findById.resolves(null);

      const context = {
        params: { organizationId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.getByOrganizationId(context);
      expect(response.status).to.equal(400);
    });
  });

  describe('checkBySite', () => {
    beforeEach(() => {
      mockDataAccess.ContactSalesLead.allByOrganizationId.resolves([mockLead]);
    });

    it('returns exists=true when a lead matches the org and site', async () => {
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
      const otherSiteId = '333e4567-e89b-12d3-a456-426614174099';
      const context = {
        params: { organizationId, siteId: otherSiteId },
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

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.ContactSalesLead.allByOrganizationId.rejects(new Error('DB error'));

      const context = {
        params: { organizationId, siteId },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.checkBySite(context);
      expect(response.status).to.equal(500);
    });
  });

  describe('updateStatus', () => {
    const contactSalesLeadId = '123e4567-e89b-12d3-a456-426614174001';

    const mockUpdatableLead = {
      getId: () => contactSalesLeadId,
      getOrganizationId: () => organizationId,
      getSiteId: () => siteId,
      getName: () => 'Test User',
      getEmail: () => 'test@example.com',
      getDomain: () => 'https://example.com',
      getStatus: () => 'CONTACTED',
      getCreatedAt: () => '2026-01-01T00:00:00Z',
      getUpdatedAt: () => '2026-01-15T00:00:00Z',
      setStatus: sandbox.stub(),
      save: sandbox.stub(),
    };

    beforeEach(() => {
      mockUpdatableLead.setStatus.resetHistory();
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

      const response = await contactSalesLeadsController.updateStatus(context);
      expect(response.status).to.equal(200);

      const body = await response.json();
      expect(body.status).to.equal('CONTACTED');
      expect(mockUpdatableLead.setStatus).to.have.been.calledWith('CONTACTED');
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

      const response = await contactSalesLeadsController.updateStatus(context);
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

      const response = await contactSalesLeadsController.updateStatus(context);
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

      const response = await contactSalesLeadsController.updateStatus(context);
      expect(response.status).to.equal(404);
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.ContactSalesLead.findById.rejects(new Error('DB error'));

      const context = {
        params: { contactSalesLeadId },
        data: { status: 'CONTACTED' },
        log: mockLogger,
        attributes: {
          authInfo: new AuthInfo().withAuthenticated(true).withType('ims'),
        },
      };

      const response = await contactSalesLeadsController.updateStatus(context);
      expect(response.status).to.equal(500);
    });
  });
});
