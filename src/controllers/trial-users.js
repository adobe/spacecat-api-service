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
  unauthorized,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
  isValidEmail,
} from '@adobe/spacecat-shared-utils';
import { TrialUser as TrialUserModel } from '@adobe/spacecat-shared-data-access';

import { ImsClient } from '@adobe/spacecat-shared-ims-client';
import { TrialUserDto } from '../dto/trial-user.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Builds the email payload XML for trial user invitation.
 * @param {string} emailAddress - Single email address.
 * @returns {string} XML email payload.
 */
function buildEmailPayload(emailAddress) {
  return `<sendTemplateEmailReq>
    <toList>${emailAddress}</toList>
</sendTemplateEmailReq>`;
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
    const { organizationId } = context.params;
    const { emailId } = context.data;
    const { env } = context;

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
        return createResponse({ message: `Trial user with this email already exists ${existingTrialUser.getId()}` }, 409);
      }

      env.IMS_CLIENT_ID = env.EMAIL_IMS_CLIENT_ID;
      env.IMS_CLIENT_SECRET = env.EMAIL_IMS_CLIENT_SECRET;
      env.IMS_CLIENT_CODE = env.EMAIL_IMS_CLIENT_CODE;
      env.IMS_SCOPE = env.EMAIL_IMS_SCOPE;
      const imsClient = ImsClient.createFrom(context);
      const imsTokenPayload = await imsClient.getServiceAccessToken();
      const postOfficeEndpoint = env.ADOBE_POSTOFFICE_ENDPOINT;
      const emailTemplateName = env.EMAIL_LLMO_TEMPLATE;
      const emailPayload = buildEmailPayload(emailId);
      // Send email using Adobe Post Office API
      const emailSentResponse = await fetch(`${postOfficeEndpoint}/po-server/message?templateName=${emailTemplateName}&locale=en-us`, {
        method: 'POST',
        headers: {
          Accept: 'application/xml',
          Authorization: `IMS ${imsTokenPayload.access_token}`,
          'Content-Type': 'application/xml',
        },
        body: emailPayload,
      });

      // create user only when email is sent successfully
      if (emailSentResponse.status === 200) {
        const trialUser = await TrialUser.create({
          emailId,
          organizationId,
          status: TrialUserModel.STATUSES.INVITED,
          metadata: { origin: TrialUserModel.STATUSES.INVITED },
        });
        return created(TrialUserDto.toJSON(trialUser));
      } else {
        return badRequest('Some Error Occured while sending email to the user');
      }
    } catch (e) {
      context.log.error(`Error creating trial user invite for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets the email address of the currently authenticated user.
   * Tries multiple sources: trial_email, preferred_username, email.
   *
   * @param {Object} context - Request context
   * @returns {string|null} Email address or null if not found
   */
  const getCurrentUserEmail = (context) => {
    const authInfo = context.attributes?.authInfo;
    if (!authInfo) return null;

    const profile = authInfo.getProfile?.();
    if (!profile) return null;

    // Try multiple fields that might contain the email
    return profile.trial_email || profile.preferred_username || profile.email || null;
  };

  /**
   * Gets email preferences for the currently authenticated user.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Email preferences response
   */
  const getEmailPreferences = async (context) => {
    const email = getCurrentUserEmail(context);
    if (!email) {
      return unauthorized('Unable to identify current user');
    }

    try {
      const trialUser = await TrialUser.findByEmailId(email);
      if (!trialUser) {
        return notFound('Trial user not found');
      }

      const metadata = trialUser.getMetadata() || {};
      const emailPreferences = metadata.emailPreferences || {};

      // Default to opted-in if not set
      return ok({
        emailPreferences: {
          weeklyDigest: emailPreferences.weeklyDigest !== false,
        },
      });
    } catch (e) {
      context.log.error(`Error getting email preferences for ${email}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Updates email preferences for the currently authenticated user.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Response>} Updated email preferences response
   */
  const updateEmailPreferences = async (context) => {
    const email = getCurrentUserEmail(context);
    if (!email) {
      return unauthorized('Unable to identify current user');
    }

    const { weeklyDigest } = context.data || {};

    // Validate that weeklyDigest is a boolean if provided
    if (weeklyDigest !== undefined && typeof weeklyDigest !== 'boolean') {
      return badRequest('weeklyDigest must be a boolean');
    }

    try {
      const trialUser = await TrialUser.findByEmailId(email);
      if (!trialUser) {
        return notFound('Trial user not found');
      }

      // Update email preferences in metadata
      const metadata = trialUser.getMetadata() || {};
      metadata.emailPreferences = {
        ...(metadata.emailPreferences || {}),
        ...(weeklyDigest !== undefined ? { weeklyDigest } : {}),
      };
      trialUser.setMetadata(metadata);
      await trialUser.save();

      return ok({
        emailPreferences: {
          weeklyDigest: metadata.emailPreferences.weeklyDigest !== false,
        },
      });
    } catch (e) {
      context.log.error(`Error updating email preferences for ${email}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    createTrialUserForEmailInvite,
    getEmailPreferences,
    updateEmailPreferences,
  };
}

export default TrialUsersController;
