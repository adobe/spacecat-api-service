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
import { guardId, guardString } from '../../util/index.js';

/**
 * LatestAuditCollection - A collection class responsible for managing LatestAudit entities.
 * Extends the AuditCollection to provide specific methods for interacting with LatestAudit records.
 *
 * @class LatestAuditCollection
 * @extends AuditCollection
 */
class LatestAuditCollection extends BaseCollection {
  async create(item) {
    return super.create(item, { upsert: true });
  }

  async allByAuditType(auditType) {
    guardString('auditType', auditType, this.entityName);

    return this.all({ auditType });
  }

  async findById(siteId, auditType) {
    guardId('siteId', siteId, this.entityName);
    guardString('auditType', auditType, this.entityName);

    return this.findByIndexKeys({ siteId, auditType });
  }
}

export default LatestAuditCollection;
