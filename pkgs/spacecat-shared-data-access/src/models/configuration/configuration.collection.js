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

import { incrementVersion, sanitizeIdAndAuditFields, zeroPad } from '../../util/util.js';
import BaseCollection from '../base/base.collection.js';

/**
 * ConfigurationCollection - A collection class responsible for managing Configuration entities.
 * Extends the BaseCollection to provide specific methods for interacting with
 * Configuration records.
 *
 * @class ConfigurationCollection
 * @extends BaseCollection
 */
class ConfigurationCollection extends BaseCollection {
  async create(data) {
    const latestConfiguration = await this.findLatest();
    const version = latestConfiguration ? incrementVersion(latestConfiguration.getVersion()) : 1;
    const sanitizedData = sanitizeIdAndAuditFields('Organization', data);
    sanitizedData.version = version;

    return super.create(sanitizedData);
  }

  async findByVersion(version) {
    return this.findByAll({ versionString: zeroPad(version, 10) });
  }

  async findLatest() {
    return this.findByAll({}, { order: 'desc' });
  }
}

export default ConfigurationCollection;
