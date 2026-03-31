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

export const LLMO_CONFIG_DB_SYNC_TYPE = 'llmo-config-db-sync';

// Temporary: hardcoded site IDs for which the S3-to-DB config sync is enabled.
// TODO: replace with actual site UUIDs per environment.
export const ALLOWED_SITE_IDS = [
  '00000000-0000-0000-0000-000000000001', // dev
  '00000000-0000-0000-0000-000000000002', // prod
  'c2473d89-e997-458d-a86d-b4096649c12b', // dev
];

export function isSyncEnabledForSite(siteId) {
  return ALLOWED_SITE_IDS.includes(siteId);
}
