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
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
  isObject,
} from '@adobe/spacecat-shared-utils';

import { SiteEnrollmentDto } from '../dto/site-enrollment.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * SiteEnrollments controller. Provides methods to read site enrollments.
 * @param {object} ctx - Context of the request.
 * @returns {object} SiteEnrollments controller.
 * @constructor
 */
function SiteEnrollmentsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { SiteEnrollment, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Validates config object to ensure it contains only string key-value pairs.
   * @param {any} config - The config object to validate.
   * @returns {boolean} True if valid, false otherwise.
   */
  const validateConfig = (config) => {
    if (!config) return true; // Allow null/undefined config
    if (!isObject(config)) return false;

    // Check that all keys and values are strings
    // Also ensure keys are not numeric (even if converted to strings)
    return Object.entries(config).every(([key, value]) => {
      // Check if the key is a string and not a numeric string
      const isValidKey = typeof key === 'string' && !/^\d+$/.test(key);
      const isValidValue = typeof value === 'string';
      return isValidKey && isValidValue;
    });
  };

  /**
   * Gets site enrollments by site ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of site enrollments response.
   */
  const getBySiteID = async (context) => {
    const { siteId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const siteEnrollments = await SiteEnrollment.allBySiteId(siteId);
      const enrollments = siteEnrollments.map(
        (siteEnrollment) => SiteEnrollmentDto.toJSON(siteEnrollment),
      );
      return ok(enrollments);
    } catch (e) {
      context.log.error(`Error getting site enrollments for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets configuration for a specific site enrollment.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Site enrollment config response.
   */
  const getConfigByEnrollmentID = async (context) => {
    const { siteId, enrollmentId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(enrollmentId)) {
      return badRequest('Enrollment ID required');
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      // Find the specific site enrollment
      const siteEnrollment = await SiteEnrollment.findById(enrollmentId);
      if (!siteEnrollment) {
        return notFound('Site enrollment not found');
      }

      // Verify the site enrollment belongs to the specified site
      if (siteEnrollment.getSiteId() !== siteId) {
        return notFound('Site enrollment not found for this site');
      }

      const config = siteEnrollment.getConfig() || {};
      return ok(config);
    } catch (e) {
      context.log.error(`Error getting site enrollment config for siteEnrollment ${enrollmentId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Updates configuration for a specific site enrollment.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Updated site enrollment config response.
   */
  const updateConfigByEnrollmentID = async (context) => {
    const { siteId, enrollmentId } = context.params;
    const { data: config } = context;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(enrollmentId)) {
      return badRequest('Enrollment ID required');
    }

    if (!validateConfig(config)) {
      return badRequest('Config must be an object with string key-value pairs');
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      // Find the specific site enrollment
      const siteEnrollment = await SiteEnrollment.findById(enrollmentId);
      if (!siteEnrollment) {
        return notFound('Site enrollment not found');
      }

      // Verify the site enrollment belongs to the specified site
      if (siteEnrollment.getSiteId() !== siteId) {
        return notFound('Site enrollment not found for this site');
      }

      // Update the config
      siteEnrollment.setConfig(config || {});
      await siteEnrollment.save();

      const updatedConfig = siteEnrollment.getConfig() || {};
      return ok(updatedConfig);
    } catch (e) {
      context.log.error(`Error updating site enrollment config for siteEnrollment ${enrollmentId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getBySiteID,
    getConfigByEnrollmentID,
    updateConfigByEnrollmentID,
  };
}

export default SiteEnrollmentsController;
