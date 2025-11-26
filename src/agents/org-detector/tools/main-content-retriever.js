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
import { JSDOM } from 'jsdom';
import { resolveUrl, scrape } from './common-retriever.js';

/**
 * Retrieves the `<main>` content from a given URL using an external API.
 *
 * @param {string} url - The URL to scrape for the `<main>` content.
 * @param {string} apiKey - API key for authentication with the external service.
 * @param {string} apiUrl - Base URL of the external API endpoint.
 * @param {object} log - logger
 * @returns {Promise<string>} - The `<main>` content as plain text, or an empty string if not found
 */
export async function retrieveMainContent(url, apiKey, apiUrl, log) {
  const requestBody = {
    skipStorage: true,
    skipMessage: true,
    options: {
      waitForSelector: 'main',
    },
    urls: [{ url: resolveUrl(url) }],
  };

  const responseData = await scrape(apiUrl, apiKey, requestBody, log);

  if (!responseData) {
    return null;
  }

  const content = responseData.results?.[0]?.content || '';
  if (!content) {
    log.info(`Could not retrieve the main content of URL: ${url}`);
    return null;
  }

  const dom = new JSDOM(content);
  const mainContent = dom.window.document.querySelector('main');
  if (!mainContent) {
    log.info('No `<main>` element found in the parsed content.');
    return null;
  }

  return mainContent.textContent.trim();
}
