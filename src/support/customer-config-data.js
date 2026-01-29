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
 * Maps SpaceCat Organization IDs to test V2 config file paths.
 * These are used for local testing without S3.
 */
const TEST_CONFIG_PATHS = {
  // Add SpaceCat org IDs here for local testing
};

/**
 * Gets customer configuration by SpaceCat Organization ID
 * @param {string} organizationId - The SpaceCat Organization ID
 * @returns {object|null} Customer configuration or null if not found
 */
export function getCustomerConfigByOrganizationId(organizationId) {
  const testFilePath = TEST_CONFIG_PATHS[organizationId];

  if (!testFilePath) {
    return null;
  }

  try {
    const fullPath = join(__dirname, testFilePath);
    const fileContent = readFileSync(fullPath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to load test config for ${organizationId}:`, error.message);
    return null;
  }
}

export default {
  getCustomerConfigByOrganizationId,
};
