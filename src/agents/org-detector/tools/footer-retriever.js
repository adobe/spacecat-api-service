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
import { resolveUrl, scrape } from './common-retriever.js';

/**
 * Retrieves the `<footer>` content from a given URL using an external API.
 *
 * @param {string} url - The URL to scrape for the footer.
 * @param {string} apiKey - API key for authentication with the external service.
 * @param {string} apiUrl - Base URL of the external API endpoint.
 * @param {object} log - logger
 * @returns {Promise<string>} - The `<footer>` HTML content or an empty string if not found.
 */
export async function retrieveFooter(url, apiKey, apiUrl, log) {
  const finalUrl = resolveUrl(url);

  const requestBody = {
    skipStorage: true,
    skipMessage: true,
    options: {
      waitForSelector: '.footer[data-block-status="loaded"]',
    },
    urls: [{ url: finalUrl }],
  };

  const responseData = await scrape(apiUrl, apiKey, requestBody, log);

  if (!responseData) {
    return null;
  }

  const content = responseData.results?.[0]?.content || '';
  return content.match(/<footer[\s\S]*?<\/footer>/)?.[0] || null;
}
