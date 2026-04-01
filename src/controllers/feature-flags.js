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
  forbidden,
  internalServerError,
  notFound,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { FeatureFlagDto } from '../dto/feature-flag.js';
import AccessControlUtil from '../support/access-control-util.js';
import {
  isValidFeatureFlagName,
  listFeatureFlagsByOrgAndProduct,
  normalizeFeatureFlagProduct,
  upsertFeatureFlag,
} from '../support/feature-flags-storage.js';

/**
 * Parses raw query string from API Gateway-style invocation (same pattern as brands controller).
 * @param {object} context
 * @returns {Record<string, string>}
 */
function getQueryParams(context) {
  const rawQueryString = context.invocation?.event?.rawQueryString;
  if (!rawQueryString) return {};
  const params = {};
  rawQueryString.split('&').forEach((param) => {
    const [key, value] = param.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value !== undefined
        ? decodeURIComponent(value)
        : '';
    }
  });
  return params;
}

/**
 * @param {object} context
 * @returns {string}
 */
function resolveUpdatedBy(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
  if (profile?.user_id) return String(profile.user_id);
  if (profile?.sub) return String(profile.sub);
  return 'spacecat-api-service';
}

/**
 * @param {object} context
 * @returns {object} Parsed write target fields, or an error response object from `badRequest`.
 */
function parseWriteTarget(context) {
  const { organizationId, product: pathProduct, flagName: rawFlagName } = context.params;
  let flagName = rawFlagName;
  try {
    flagName = decodeURIComponent(rawFlagName);
  } catch {
    flagName = rawFlagName;
  }

  if (!isValidUUID(organizationId)) {
    return badRequest('Organization ID required');
  }

  const pathProductNorm = normalizeFeatureFlagProduct(pathProduct);
  if (!pathProductNorm) {
    return badRequest('Path parameter "product" must be ASO or LLMO');
  }

  if (!isValidFeatureFlagName(flagName)) {
    return badRequest(
      'Invalid flag name: use non-empty lowercase snake_case (^[a-z][a-z0-9_]*$), max 255 characters',
    );
  }

  return { organizationId, pathProductNorm, flagName };
}

/**
 * Org-scoped feature flags (mysticat Postgres / PostgREST).
 * @param {object} ctx - Request context (injected)
 */
function FeatureFlagsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Organization } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * @param {object} context
   * @returns {import('@adobe/spacecat-shared-http-utils').Response|null}
   */
  function requirePostgrest(context) {
    const postgrestClient = context.dataAccess?.services?.postgrestClient;
    if (!postgrestClient?.from) {
      return createResponse(
        { message: 'Feature flags require Postgres / mysticat PostgREST (DATA_SERVICE_PROVIDER=postgres)' },
        503,
      );
    }
    return null;
  }

  const listByOrganization = async (context) => {
    const unavailable = requirePostgrest(context);
    if (unavailable) return unavailable;

    const { organizationId } = context.params;
    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const query = getQueryParams(context);
    const product = normalizeFeatureFlagProduct(query.product);
    if (!product) {
      return badRequest('Query parameter "product" is required and must be ASO or LLMO');
    }

    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view feature flags');
      }

      const { postgrestClient } = context.dataAccess.services;
      const rows = await listFeatureFlagsByOrgAndProduct({
        organizationId,
        product,
        postgrestClient,
      });
      return ok(rows.map((r) => FeatureFlagDto.toJSON(r)));
    } catch (e) {
      context.log.error(`Error listing feature flags for org ${organizationId}: ${e.message}`);
      return internalServerError('Failed to list feature flags');
    }
  };

  const persistFlag = async (context, value, logVerb) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can set organization feature flags');
    }
    const unavailable = requirePostgrest(context);
    if (unavailable) return unavailable;

    const target = parseWriteTarget(context);
    if (!('pathProductNorm' in target)) {
      return target;
    }
    const { organizationId, pathProductNorm, flagName } = target;

    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = resolveUpdatedBy(context);
      const row = await upsertFeatureFlag({
        organizationId,
        product: pathProductNorm,
        flagName,
        value,
        updatedBy,
        postgrestClient,
      });
      return ok(FeatureFlagDto.toJSON(row));
    } catch (e) {
      context.log.error(`Error ${logVerb} feature flag for org ${organizationId}: ${e.message}`);
      return internalServerError('Failed to update feature flag');
    }
  };

  const putByOrganizationProductAndName = async (context) => persistFlag(
    context,
    true,
    'enabling',
  );

  const deleteByOrganizationProductAndName = async (context) => persistFlag(
    context,
    false,
    'disabling',
  );

  return {
    listByOrganization,
    putByOrganizationProductAndName,
    deleteByOrganizationProductAndName,
  };
}

export default FeatureFlagsController;
