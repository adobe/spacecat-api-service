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

import BaseCollection from '../base/base.collection.js';

/**
 * RoleMemberCollection - A collection class responsible for managing Role entities.
 * Extends the BaseCollection to provide specific methods for interacting with Role records.
 *
 * @class RoleMemberCollection
 * @extends BaseCollection
 */
class RoleMemberCollection extends BaseCollection {
  /**
   * Return all roleMembers associated with the provided identities. These must allso
   * be associated with the specified imsOrgId in the primary key.
   * @param {string} imsOrgId - The IMS Org ID to that the roles should have in its primary key.
   * @param {string[]} identities - The identities to filter roles by.
   */
  async allRoleMembershipByIdentities(imsOrgId, identities) {
    // This is the filter function passed to the database as a FilterExpression
    const filter = (attr, { eq }) => identities.map((identity) => eq(attr.identity, identity)).join(' OR ');

    return /* await */ this.allByImsOrgId(imsOrgId, { filter });
  }
}

export default RoleMemberCollection;
