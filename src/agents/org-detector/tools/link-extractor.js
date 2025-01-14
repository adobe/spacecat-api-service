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
import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Extracts absolute URLs from anchor (`<a>`) elements in the given HTML content.
 *
 * @param {string} html - The raw HTML content to parse and extract links from.
 * @param {string} domain - The base domain to resolve relative links.
 * @param {object} log - logger
 * @returns {string[]} - An array of absolute URLs extracted from the HTML.
 */
export function extractLinks(html, domain, log) {
  if (!hasText(html)) {
    log.error('Extract Links: Invalid HTML input. Expected a non-empty string.');
    return [];
  }

  if (!hasText(domain)) {
    log.error('Extract Links: Invalid domain input. Expected a non-empty string.');
    return [];
  }

  try {
    const baseDomain = domain.endsWith('/') ? domain : `${domain}/`;

    const dom = new JSDOM(html);
    const { document } = dom.window;
    const anchorElements = document.querySelectorAll('a');

    const links = Array.from(anchorElements)
      .map((anchor) => {
        const href = anchor.getAttribute('href');

        if (!href) {
          log.info('Extract Links: Skipping an anchor element without an href attribute.');
          return null;
        }

        if (href.startsWith('http://') || href.startsWith('https://')) {
          return href;
        }

        if (href.startsWith('/')) {
          return `${baseDomain}${href.slice(1)}`;
        }

        return `${baseDomain}${href}`;
      })
      .filter((link) => !!link);

    log.info(`Extract Links: Successfully extracted ${links.length} links.`);
    return links;
    /* c8 ignore next 4 */
  } catch (error) {
    log.error(`Extract Links: An error occurred while extracting links - ${error.message}`);
    return [];
  }
}
