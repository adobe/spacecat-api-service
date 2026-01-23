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

import { TrialUserDto } from '../dto/trial-user.js';
import AccessControlUtil from '../support/access-control-util.js';
import { sendTrialUserInviteEmail } from '../support/email-service.js';

/**
 * Gets the email of the current authenticated user from the auth profile.
 * @param {Object} context - Request context
 * @returns {string|null} User email or null if not found
 */
const getCurrentUserEmail = (context) => {
  const authInfo = context.attributes?.authInfo;
  if (!authInfo) {
    return null;
  }

  const profile = authInfo.getProfile();
  if (!profile) {
    return null;
  }

  // Trial users have trial_email, regular users have email
  return profile.trial_email || profile.email || null;
};
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

      // Send invitation email using the email service
      const emailResult = await sendTrialUserInviteEmail({
        context,
        emailAddress: emailId,
      });

      // Create user only when email is sent successfully
      if (emailResult.success) {
        const trialUser = await TrialUser.create({
          emailId,
          organizationId,
          status: TrialUserModel.STATUSES.INVITED,
          metadata: { origin: TrialUserModel.STATUSES.INVITED },
        });
        return created(TrialUserDto.toJSON(trialUser));
      } else {
        context.log.error(`Failed to send invitation email: ${emailResult.error}`);
        return badRequest('An error occurred while sending email to the user');
      }
    } catch (e) {
      context.log.error(`Error creating trial user invite for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Updates email preferences for the current authenticated user.
   * Allows users to opt-in/out of weekly digest emails.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Updated email preferences response.
   */
  const updateEmailPreferences = async (context) => {
    const { weeklyDigest } = context.data;

    // Validate input
    if (typeof weeklyDigest !== 'boolean') {
      return badRequest('weeklyDigest must be a boolean value');
    }

    // Get current user email from auth context
    const userEmail = getCurrentUserEmail(context);
    if (!userEmail) {
      return unauthorized('Unable to identify current user');
    }

    try {
      // Find the trial user by email
      const trialUser = await TrialUser.findByEmailId(userEmail);
      if (!trialUser) {
        return notFound('User not found');
      }

      // Get existing metadata or initialize empty object
      const metadata = trialUser.getMetadata() || {};

      // Update email preferences in metadata
      metadata.emailPreferences = {
        ...(metadata.emailPreferences || {}),
        weeklyDigest,
      };

      // Update the trial user with new metadata
      trialUser.setMetadata(metadata);
      await trialUser.save();

      context.log.info(`Updated email preferences for user ${userEmail}: weeklyDigest=${weeklyDigest}`);

      return ok({
        message: 'Email preferences updated successfully',
        emailPreferences: metadata.emailPreferences,
      });
    } catch (e) {
      context.log.error(`Error updating email preferences for user ${userEmail}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets email preferences for the current authenticated user.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Email preferences response.
   */
  const getEmailPreferences = async (context) => {
    // Get current user email from auth context
    const userEmail = getCurrentUserEmail(context);
    if (!userEmail) {
      return unauthorized('Unable to identify current user');
    }

    try {
      // Find the trial user by email
      const trialUser = await TrialUser.findByEmailId(userEmail);
      if (!trialUser) {
        return notFound('User not found');
      }

      // Get email preferences from metadata, with defaults
      const metadata = trialUser.getMetadata() || {};
      const emailPreferences = {
        weeklyDigest: true, // Default to opted-in
        ...(metadata.emailPreferences || {}),
      };

      return ok({ emailPreferences });
    } catch (e) {
      context.log.error(`Error getting email preferences for user ${userEmail}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    createTrialUserForEmailInvite,
    updateEmailPreferences,
    getEmailPreferences,
  };
}

export default TrialUsersController;
