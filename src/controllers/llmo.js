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

import { ok } from '@adobe/spacecat-shared-http-utils';

function LlmoController() {
  const getLlmoData = async (context) => {
    const { siteId, dataSource } = context.params;
    const { log } = context;

    try {
      // Fetch data from the external endpoint
      const response = await fetch('https://main--gw25--vivesing.aem.live/readme.json', {
        headers: {
          Referer: 'https://dev.d2ikwb7s634epv.amplifyapp.com/',
          'User-Agent': 'SpaceCat-API-Service/1.0',
        },
      });

      if (!response.ok) {
        log.error(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
        throw new Error(`External API returned ${response.status}: ${response.statusText}`);
      }

      // Get the response data
      const data = await response.json();

      log.info(`Successfully proxied data for siteId: ${siteId}, dataSource: ${dataSource}`);

      // Return the response as-is
      return ok(data);
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, dataSource: ${dataSource}`, error);
      throw error;
    }
  };

  return {
    getLlmoData,
  };
}

export default LlmoController;
