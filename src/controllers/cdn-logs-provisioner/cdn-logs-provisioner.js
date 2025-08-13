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
  ok, created, badRequest, forbidden, internalServerError, notFound,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../../support/access-control-util.js';
import { provisionBucketForTenant } from './cdn-logs-provisioner-helper.js';

/* c8 ignore start */
/**
 * CDN Logs Provisioner Controller for managing S3 buckets and IAM credentials for organizations.
 * @param {object} ctx - Context object containing dataAccess, log, env, etc.
 * @returns {object} CDN Logs Provisioner Controller
 * @constructor
 */
function CdnLogsProvisionerController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { log, env } = ctx;

  const region = env.AWS_REGION || 'us-east-1';
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Provisions CDN logs infrastructure for an organization (idempotent operation)
   * Creates S3 bucket, IAM policy/user, and stores credentials if they don't exist
   * @param {object} context - Request context with imsOrgName and imsOrgId parameters
   * @returns {Promise<Response>} HTTP response with provisioning details
   */
  const provisionBucket = async (context) => {
    try {
      const { imsOrgName, imsOrgId } = context.params || {};
      if (!imsOrgName || !imsOrgId) {
        return badRequest('imsOrgName and imsOrgId are required as path parameters');
      }

      const { dataAccess } = context;
      const { Organization } = dataAccess;

      const organization = await Organization.findByImsOrgId(imsOrgId);
      if (!organization) {
        return notFound(`Organization not found by IMS org ID: ${imsOrgId}`);
      }

      if (!(await accessControlUtil.hasAccess(organization))) {
        return forbidden(`Access denied for organization: ${imsOrgName}`);
      }

      log.info(`Provisioning CDN logs bucket for organization: ${imsOrgName} (ID: ${imsOrgId})`);

      const result = await provisionBucketForTenant(imsOrgName, imsOrgId, region, log);

      // bucketExists=false means the bucket was newly created in this request
      if (result.bucketExists === false) {
        return created(result);
      } else {
        return ok(result);
      }
    } catch (error) {
      log.error('Error in CDN logs provisioner controller:', error);

      if (error.message.includes('Organization') || error.message.includes('orgName') || error.message.includes('orgId')) {
        return badRequest(error.message);
      }

      return internalServerError(`Failed to provision CDN logs bucket: ${error.message}`);
    }
  };

  return {
    provisionBucket,
  };
}

export default CdnLogsProvisionerController;

/* c8 ignore end */
