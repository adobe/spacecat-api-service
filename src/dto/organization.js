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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { createOrganization } from '@adobe/spacecat-shared-data-access/src/models/organization.js';

/**
 * Data transfer object for Organization.
 */
export const OrganizationDto = {

  /**
   * Converts a JSON object into a Organization object.
   * @param {object } jsonObject - JSON object.
   * @returns {Readonly<Organization>} Organization object.
   */
  fromJson: (jsonObject) => {
    const organizationData = {
      id: jsonObject.id,
      name: jsonObject.name,
      imsOrgId: jsonObject.imsOrgId,
      createdAt: jsonObject.createdAt,
      updatedAt: jsonObject.updatedAt,
      config: Config.fromDynamoItem(jsonObject.config),
    };

    return createOrganization(organizationData);
  },

  /**
   * Converts a Organization object into a JSON object.
   * @param {Readonly<Organization>} organization - Organization object.
   * @returns {{
   * }}
   */
  toJSON: (organization) => ({
    id: organization.getId(),
    name: organization.getName(),
    imsOrgId: organization.imsOrgId(),
    createdAt: organization.getCreatedAt(),
    updatedAt: organization.getUpdatedAt(),
    config: Config.toDynamoItem(organization.getConfig()),
  }),
};
