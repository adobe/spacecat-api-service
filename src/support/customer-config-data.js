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

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// eslint-disable-next-line no-underscore-dangle
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Maps IMS Org IDs to test V2 config file paths.
 * These are used for local testing without S3.
 */
const TEST_CONFIG_PATHS = {
  '757A02BE532B22BA0A490D4CAdobeOrg': '../../scripts/v1v2test/generalmotors/757A02BE532B22BA0A490D4CAdobeOrg.json',
  '51F301D95EC6EC0A0A495EDFAdobeOrg': '../../scripts/v1v2test/adobe/51F301D95EC6EC0A0A495EDFAdobeOrg.json',
};

/**
 * Gets customer configuration by IMS Org ID
 * @param {string} imsOrgId - The IMS Organization ID
 * @returns {object|null} Customer configuration or null if not found
 */
export function getCustomerConfigByImsOrgId(imsOrgId) {
  const testFilePath = TEST_CONFIG_PATHS[imsOrgId];

  if (!testFilePath) {
    return null;
  }

  try {
    const fullPath = join(__dirname, testFilePath);
    const fileContent = readFileSync(fullPath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to load test config for ${imsOrgId}:`, error.message);
    return null;
  }
}

export default {
  getCustomerConfigByImsOrgId,
};
