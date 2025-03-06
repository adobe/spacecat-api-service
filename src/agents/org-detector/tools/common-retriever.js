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
import { tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import URI from 'urijs';

/**
 * Resolves a given URL to a standardized format.
 * Ensures the URL starts with "https://" and includes "www." if the subdomain is not present.
 *
 * @param {string} url - The input URL to resolve.
 * @returns {string} - The resolved and standardized URL.
 */
export function resolveUrl(url) {
  const uri = new URI(url.startsWith('http') ? url : `https://${url}`);
  return uri.subdomain()
    ? uri.toString()
    : uri.toString().replace(/https?:\/\//, 'https://www.');
}

/**
 * Sends a POST request to the spacecat content scraper API and retrieves content
 *
 * @param {string} apiUrl - Base URL of the external API endpoint.
 * @param {string} apiKey - API key for authentication.
 * @param {object} requestBody - The request payload to send.
 * @param {object} log - logger
 * @returns {Promise<object|null>} - The API response or null if an error occurs.
 */
export async function scrape(apiUrl, apiKey, requestBody, log) {
  try {
    const response = await fetch(`${apiUrl}/scrape`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      log.error(`Scrape error: scraper returned: ${response.status}. Scrape request: ${JSON.stringify(requestBody)}`);
      return null;
    }

    return await response.json();
    /* c8 ignore next 4 */
  } catch (error) {
    log.error(`Error occurred during scrape request - ${error.message}`);
    return null;
  }
}
