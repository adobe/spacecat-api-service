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

import { isIsoDate } from '@adobe/spacecat-shared-utils';

import BaseModel from '../base/base.model.js';

/**
 * ApiKey - A class representing an ApiKey entity.
 * Provides methods to access and manipulate ApiKey-specific data.
 *
 * @class ApiKey
 * @extends BaseModel
 */
class ApiKey extends BaseModel {
  static SCOPE_NAMES = [
    'sites.read_all',
    'sites.write_all',
    'organizations.read_all',
    'organizations.write_all',
    'audits.read_all',
    'audits.write_all',
    'imports.read',
    'imports.write',
    'imports.delete',
    'imports.read_all',
    'imports.all_domains',
    'imports.assistant',
  ];

  isValid() {
    const now = new Date();

    if (isIsoDate(this.getDeletedAt()) && new Date(this.getDeletedAt()) < now) {
      return false;
    }

    if (isIsoDate(this.getRevokedAt()) && new Date(this.getRevokedAt()) < now) {
      return false;
    }

    if (isIsoDate(this.getExpiresAt()) && new Date(this.getExpiresAt()) < now) {
      return false;
    }

    return true;
  }
}

export default ApiKey;
