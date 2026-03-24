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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

const sanitizeConfig = (config) => {
  if (!isNonEmptyObject(config)) {
    return null;
  }
  const json = Config.toDynamoItem(config);

  // remove bulky brandProfile field
  // and any other sensitive fields if needed
  if (json) {
    delete json.brandProfile;
  }
  return json;
};

const toListJSON = (config) => {
  if (!isNonEmptyObject(config)) {
    return null;
  }
  const json = Config.toDynamoItem(config);
  if (!json) {
    return null;
  }

  const result = {};
  if (isNonEmptyObject(json.llmo)) {
    result.llmo = {};
    const {
      dataFolder, brand, tags, customerIntent,
    } = json.llmo;
    if (dataFolder) result.llmo.dataFolder = dataFolder;
    if (brand) result.llmo.brand = brand;
    if (tags) result.llmo.tags = tags;
    if (customerIntent) result.llmo.customerIntent = customerIntent;
  }
  if (isNonEmptyObject(json.edgeOptimizeConfig)) {
    result.edgeOptimizeConfig = json.edgeOptimizeConfig;
  }
  if (isNonEmptyObject(json.slack)) {
    result.slack = json.slack;
  }
  if (isNonEmptyObject(json.brandConfig)) {
    result.brandConfig = json.brandConfig;
  }
  if (isNonEmptyObject(json.fetchConfig)) {
    result.fetchConfig = json.fetchConfig;
  }
  if (isNonEmptyObject(json.handlers)) {
    result.handlers = json.handlers;
  }
  return Object.keys(result).length > 0 ? result : null;
};

export const ConfigDto = {
  toJSON: sanitizeConfig,
  toListJSON,
};
