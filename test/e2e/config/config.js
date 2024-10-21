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

// End-to-end test configurations
function isTestingProd() {
  return process.env.ENVIRONMENT === 'prod';
}

const BASE_URL = 'https://spacecat.experiencecloud.live/api';
const IMPORT_JOBS_SUFFIX = 'tools/import/jobs';
const DEV_API_URL = `${BASE_URL}/ci/${IMPORT_JOBS_SUFFIX}`;
const PROD_API_URL = `${BASE_URL}/v1/${IMPORT_JOBS_SUFFIX}`;

export const apiUrl = isTestingProd() ? PROD_API_URL : DEV_API_URL;

export const apiKey = isTestingProd()
  ? process.env.AEM_E2E_IMPORT_API_KEY_PROD : process.env.AEM_E2E_IMPORT_API_KEY_DEV;
