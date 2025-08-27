/*
 * Copyright 2025 Adobe. All rights reserved.
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
  notFound,
  ok,
  forbidden,
  internalServerError,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
  hasText,
} from '@adobe/spacecat-shared-utils';

import { OrganizationIdentityProviderDto } from '../dto/organization-identity-provider.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * OrganizationIdentityProvider controller. Provides methods to read organization
 * identity providers.
 * @param {object} ctx - Context of the request.
 * @returns {object} OrganizationIdentityProvider controller.
 * @constructor
 */
function OrganizationIdentityProviderController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Organization, OrganizationIdentityProvider } = dataAccess;

  /**
   * Gets organization identity providers by organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of organization identity providers response.
   */
  const getByOrganizationID = async (context) => {
    const { organizationId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      // Check if user has access to the specific organization
      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its identity providers');
      }

      const organizationIdentityProviders = await OrganizationIdentityProvider
        .allByOrganizationId(organizationId);
      const providers = organizationIdentityProviders
        .map((provider) => OrganizationIdentityProviderDto.toJSON(provider));
      return ok(providers);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  /**
   * Creates a new organization identity provider.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} OrganizationIdentityProvider response.
   */
  const create = async (context) => {
    const { organizationId } = context.params;
    const { provider, externalId, metadata } = context.data;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(provider)) {
      return badRequest('Provider is required');
    }

    if (!hasText(externalId)) {
      return badRequest('External ID is required');
    }

    // Validate provider type
    const validProviders = Object.values(OrganizationIdentityProvider.PROVIDER_TYPES);
    if (!validProviders.includes(provider)) {
      return badRequest(`Provider must be one of: ${validProviders.join(', ')}`);
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can create identity providers');
      }

      // Check if organization identity provider already exists with this provider and external ID
      const existingProvider = await OrganizationIdentityProvider
        .findByProviderAndExternalId(provider, externalId);
      if (existingProvider) {
        return badRequest('Organization identity provider with this provider and external ID already exists');
      }

      // Create new organization identity provider
      const organizationIdentityProvider = await OrganizationIdentityProvider.create({
        organizationId,
        provider,
        externalId,
        metadata: metadata || {},
      });

      return createResponse(
        OrganizationIdentityProviderDto.toJSON(organizationIdentityProvider),
        201,
      );
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    create,
  };
}

export default OrganizationIdentityProviderController;
