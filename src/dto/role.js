/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Data transfer object for Role.
 */
export const RoleDto = {

  /**
     * Converts a Role object into a JSON object.
     * @param {Readonly<Role>} role - Role object.
     * @returns {{
      * id: string,
      * name: string,
      * imsOrgId: string,
      * acl: Array<{
      *   actions: Array<string>,
      *   path: string
      * }>,
      * createdAt: date,
      * createdBy: string,
      * updatedAt: date,
      * updatedBy: string
      * }} JSON object.
     */
  toJSON: (role) => ({
    id: role.getId(),
    name: role.getName(),
    imsOrgId: role.getImsOrgId(),
    acl: role.getAcl(),
    createdAt: role.getCreatedAt(),
    createdBy: role.getCreatedBy(),
    updatedAt: role.getUpdatedAt(),
    updatedBy: role.getUpdatedBy(),
  }),
};
