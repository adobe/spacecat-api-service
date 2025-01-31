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

import BaseCollection from '../base/base.collection.js';

/**
 * AuditCollection - A collection class responsible for managing Audit entities.
 * Extends the BaseCollection to provide specific methods for interacting with Audit records.
 *
 * @class AuditCollection
 * @extends BaseCollection
 */
class AuditCollection extends BaseCollection {
  // create a copy of the audit as a LatestAudit entity
  async _onCreate(item) {
    const collection = this.entityRegistry.getCollection('LatestAuditCollection');
    await collection.create(item.toJSON());
  }

  // of the created audits, find the latest per site and auditType
  // and create a LatestAudit copy for each
  async _onCreateMany(items) {
    const collection = this.entityRegistry.getCollection('LatestAuditCollection');
    const latestAudits = items.createdItems.reduce((acc, audit) => {
      const siteId = audit.getSiteId();
      const auditType = audit.getAuditType();
      const auditedAt = audit.getAuditedAt();
      const key = `${siteId}-${auditType}`;

      if (!acc[key] || acc[key].getAuditedAt() < auditedAt) {
        acc[key] = audit;
      }

      return acc;
    }, {});

    await collection.createMany(Object.values(latestAudits).map((audit) => audit.toJSON()));
  }
}

export default AuditCollection;
