/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { context as h2, h1 } from '@adobe/fetch';
import { hasText } from '@adobe/spacecat-shared-utils';

/* c8 ignore next 3 */
export const { fetch } = process.env.HELIX_FETCH_FORCE_HTTP1
  ? h1()
  : h2();

export const IMS_TOKEN_ENDPOINT = '/ims/token/v4';
export const IMS_TOKEN_ENDPOINT_V3 = '/ims/token/v3';
export const IMS_PRODUCT_CONTEXT_BY_ORG_ENDPOINT = '/ims/fetch_pc_by_org/v1';
export const IMS_ORGANIZATIONS_ENDPOINT = '/ims/organizations';
export const IMS_PROFILE_ENDPOINT = '/ims/profile/v1';

/**
 * Creates and populates a FormData object from key-value pairs.
 * @param {Object} fields - Object containing key-value pairs to append to FormData.
 * @returns {FormData} A populated FormData object.
 */
export const createFormData = (fields) => {
  const formData = new FormData();
  Object.entries(fields).forEach(([key, value]) => formData.append(key, value));
  return formData;
};

/**
 * Generates the IMS groups endpoint URL.
 * @param {string} imsOrgId - The IMS host.
 * @param {string} groupId - The IMS client ID.
 * @return `/ims/organizations/${string}/groups/${string}/members` - The IMS groups endpoint URL.
 */
export const getGroupMembersEndpoint = (imsOrgId, groupId) => `/ims/organizations/${imsOrgId}/groups/${groupId}/members`;

/**
 * Generates the IMS organizations endpoint URL.
 * @param {string} imsOrgId - The IMS host.
 * @return `/ims/organizations/${string}/v2` - The IMS organizations endpoint URL.
 */
export const getImsOrgsApiPath = (imsOrgId) => `${IMS_ORGANIZATIONS_ENDPOINT}/${imsOrgId}/v2`;

/**
 * Extracts the orgId and authSource from the IMS Org ID.
 * @param {string} imsOrgId - The IMS Org ID.
 * @return {{authSource: string, orgId: string}} - The orgId and authSource.
 */
export const extractIdAndAuthSource = (imsOrgId) => {
  const [orgId, authSource] = imsOrgId.split('@');
  return { orgId, authSource };
};

const emailDomainsToIgnore = ['techacct.adobe.com'];

/**
 * Validates whether the given email address is allowed.
 * @param {string} email - The email address to validate.
 * @return {boolean} - True if the email address is allowed, false otherwise.
 */
export const emailAddressIsAllowed = (email) => {
  if (!hasText(email)) {
    return false;
  }

  const emailParts = email.split('@');
  if (emailParts.length !== 2) {
    return false;
  }

  const domain = emailParts[1];
  return !emailDomainsToIgnore.includes(domain?.toLowerCase());
};
