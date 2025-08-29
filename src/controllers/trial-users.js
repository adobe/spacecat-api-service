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
  createResponse,
  created,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
  isValidEmail,
} from '@adobe/spacecat-shared-utils';
import { TrialUser as TrialUserModel } from '@adobe/spacecat-shared-data-access';
import { readFile } from 'fs/promises';

import { ImsClient } from '@adobe/spacecat-shared-ims-client';
import { TrialUserDto } from '../dto/trial-user.js';
import AccessControlUtil from '../support/access-control-util.js';

// Path to email template
const EMAIL_TEMPLATE_PATH = './static/email-templates/trial-user-email.xml';

/**
 * Loads and processes the email template with provided data.
 * @param {string} emailAddress - Single email address.
 * @returns {Promise<string>} Processed email template.
 */
async function buildEmailPayload(emailAddress) {
  const template = await readFile(EMAIL_TEMPLATE_PATH, { encoding: 'utf8' });
  return template
    .replace('{{emailAddress}}', emailAddress);
}

/**
 * TrialUsers controller. Provides methods to read and create trial users.
 * @param {object} ctx - Context of the request.
 * @returns {object} TrialUsers controller.
 * @constructor
 */
function TrialUsersController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { TrialUser, Organization } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets trial users by organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of trial users response.
   */
  const getByOrganizationID = async (context) => {
    const { organizationId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Access denied to this organization');
      }

      const trialUsers = await TrialUser.allByOrganizationId(organizationId);
      const users = trialUsers.map((user) => TrialUserDto.toJSON(user));
      return ok(users);
    } catch (e) {
      context.log.error(`Error getting trial users for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Creates a trial user invite for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} TrialUser response.
   */
  const createTrialUserForEmailInvite = async (context) => {
    const { env } = ctx;
    const { organizationId } = context.params;
    const { emailId } = context.data;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(emailId)) {
      return badRequest('Email ID is required');
    }

    if (!isValidEmail(emailId)) {
      return badRequest('Valid email address is required');
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Access denied to this organization');
      }

      // Check if trial user already exists with this email
      const existingTrialUser = await TrialUser.findByEmailId(emailId);
      if (existingTrialUser) {
        return createResponse({ message: 'Trial user with this email already exists' }, 409);
      }

      // Create new trial user invite
      const trialUser = await TrialUser.create({
        emailId,
        organizationId,
        status: TrialUserModel.STATUSES.INVITED,
        metadata: { origin: TrialUserModel.STATUSES.INVITED },
      });

      env.IMS_CLIENT_ID = env.EMAIL_IMS_CLIENT_ID;
      env.IMS_CLIENT_SECRET = env.EMAIL_IMS_CLIENT_SECRET;
      env.IMS_CLIENT_CODE = env.EMAIL_IMS_CLIENT_CODE;
      env.IMS_SCOPE = env.EMAIL_IMS_SCOPE;
      const imsClient = ImsClient.createFrom(ctx);
      const imsToken = await imsClient.getServiceAccessTokenV3();
      const postOfficeEndpoint = env.ADOBE_POSTOFFICE_ENDPOINT;

      const emailPayload = await buildEmailPayload(emailId);

      // Send email using Adobe Post Office API
      await fetch(`${postOfficeEndpoint}/po-server/message?templateName=expdev_xwalk_trial_confirm&locale=en-us`, {
        method: 'POST',
        headers: {
          Accept: 'application/xml',
          Authorization: `IMS ${imsToken}`,
          'Content-Type': 'application/xml',
        },
        body: emailPayload,
      });

      return created(TrialUserDto.toJSON(trialUser));
    } catch (e) {
      context.log.error(`Error creating trial user invite for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    createTrialUserForEmailInvite,
  };
}

export default TrialUsersController;
