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

import {
  badRequest,
  created,
  createResponse,
  forbidden,
  internalServerError,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidEmail,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { ContactSalesLead as ContactSalesLeadModel } from '@adobe/spacecat-shared-data-access';

import { ContactSalesLeadDto } from '../dto/contact-sales-lead.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * ContactSalesLeads controller. Provides methods to create and query contact sales leads.
 * @param {object} ctx - Context of the request.
 * @returns {object} ContactSalesLeads controller.
 * @constructor
 */
function ContactSalesLeadsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { ContactSalesLead, Organization } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Resolves the internal organization from the authenticated user's IMS org.
   * @param {object} context - Request context.
   * @returns {Promise<object|null>} Organization or null.
   */
  const resolveOrganization = async (context) => {
    const authInfo = context.attributes?.authInfo;
    if (!authInfo) return null;

    const profile = authInfo.getProfile();
    const tenantId = profile?.tenants?.[0]?.id;
    if (!hasText(tenantId)) return null;

    const imsOrgId = tenantId.includes('@') ? tenantId : `${tenantId}@AdobeOrg`;

    try {
      return await Organization.findByImsOrgId(imsOrgId);
    } catch (e) {
      context.log.error(`Error resolving organization for IMS org ${imsOrgId}: ${e.message}`);
      return null;
    }
  };

  /**
   * Creates a new contact sales lead.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} ContactSalesLead response.
   */
  const create = async (context) => {
    const {
      name, email, domain, siteId, notes,
    } = context.data || {};

    if (!hasText(name)) {
      return badRequest('Name is required');
    }

    if (!hasText(email)) {
      return badRequest('Email is required');
    }

    if (!isValidEmail(email)) {
      return badRequest('A valid email address is required');
    }

    try {
      const organization = await resolveOrganization(context);
      if (!organization) {
        return badRequest('Unable to resolve organization from authentication context');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const organizationId = organization.getId();

      if (hasText(siteId) && isValidUUID(siteId)) {
        const existingLead = await ContactSalesLead.findByAll(
          { organizationId, siteId },
        );
        if (existingLead) {
          return createResponse(
            {
              message:
                'A contact sales request has already been submitted for this site.',
            },
            409,
          );
        }
      } else {
        const leads = await ContactSalesLead.allByOrganizationId(organizationId);
        const duplicateEmailNoSite = leads.find(
          (lead) => lead.getEmail() === email && !lead.getSiteId(),
        );
        if (duplicateEmailNoSite) {
          return createResponse(
            {
              message:
                'A contact sales request has already been submitted for this email.',
            },
            409,
          );
        }
      }

      const leadData = {
        name,
        email,
        organizationId,
        status: ContactSalesLeadModel.STATUSES.NEW,
      };

      if (hasText(domain)) {
        leadData.domain = domain;
      }

      if (hasText(siteId) && isValidUUID(siteId)) {
        leadData.siteId = siteId;
      }

      if (hasText(notes)) {
        leadData.notes = notes;
      }

      const lead = await ContactSalesLead.create(leadData);
      return created(ContactSalesLeadDto.toJSON(lead));
    } catch (e) {
      context.log.error(`Error creating contact sales lead: ${e.message}`);
      return internalServerError('Failed to create contact sales lead');
    }
  };

  /**
   * Gets contact sales leads by organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of contact sales leads.
   */
  const getByOrganizationId = async (context) => {
    const { organizationId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its leads');
      }

      const leads = await ContactSalesLead.allByOrganizationId(organizationId);
      return ok(leads.map((lead) => ContactSalesLeadDto.toJSON(lead)));
    } catch (e) {
      context.log.error(`Error getting contact sales leads for org ${organizationId}: ${e.message}`);
      return internalServerError('Failed to retrieve contact sales leads');
    }
  };

  /**
   * Checks if a contact sales lead exists for a given organization and site.
   * Returns { exists: true/false } so the frontend can disable the button.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} { exists: boolean, lead?: object }
   */
  const checkBySite = async (context) => {
    const { organizationId, siteId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can check its leads');
      }

      const match = await ContactSalesLead.findByAll({ organizationId, siteId });

      if (match) {
        return ok({ exists: true, lead: ContactSalesLeadDto.toJSON(match) });
      }
      return ok({ exists: false });
    } catch (e) {
      context.log.error(`Error checking contact sales lead for org ${organizationId}, site ${siteId}: ${e.message}`);
      return internalServerError('Failed to check contact sales lead');
    }
  };

  const VALID_STATUSES = Object.values(ContactSalesLeadModel.STATUSES);

  /**
   * Updates a contact sales lead (partial update).
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Updated ContactSalesLead response.
   */
  const update = async (context) => {
    const { contactSalesLeadId } = context.params;
    const { status, notes } = context.data || {};

    if (!isValidUUID(contactSalesLeadId)) {
      return badRequest('Contact sales lead ID required');
    }

    if (!hasText(status) && !hasText(notes)) {
      return badRequest('At least one of status or notes is required');
    }

    if (hasText(status) && !VALID_STATUSES.includes(status)) {
      return badRequest(`Status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    try {
      const lead = await ContactSalesLead.findById(contactSalesLeadId);
      if (!lead) {
        return notFound('Contact sales lead not found');
      }

      const orgId = lead.getOrganizationId();
      if (orgId) {
        const organization = await Organization.findById(orgId);
        if (organization && !await accessControlUtil.hasAccess(organization)) {
          return forbidden('User does not have access to update this lead');
        }
      } else if (!accessControlUtil.hasAdminAccess()) {
        return forbidden('Only admins can update leads without an organization');
      }

      if (hasText(status)) {
        lead.setStatus(status);
      }
      if (hasText(notes)) {
        lead.setNotes(notes);
      }

      const updatedLead = await lead.save();
      return ok(ContactSalesLeadDto.toJSON(updatedLead));
    } catch (e) {
      context.log.error(`Error updating contact sales lead ${contactSalesLeadId}: ${e.message}`);
      return internalServerError('Failed to update contact sales lead');
    }
  };

  return {
    create,
    getByOrganizationId,
    checkBySite,
    update,
  };
}

export default ContactSalesLeadsController;
