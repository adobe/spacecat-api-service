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

/* c8 ignore start */

import { createProxyResource } from '../../../utils/jsonrpc.js';

export function createScrapeContentResources(scrapeController, context) {
  if (!scrapeController) {
    return {};
  }

  return {
    scrapeContentFilesList: createProxyResource({
      name: 'scrape-content-list',
      description: 'Lists all scraped content files stored in S3 for a specific site and handler type. Handler types include "scrapes" (default web scraping), "imports" and "accessibility". This resource helps you discover what scraped content is available before retrieving specific files.',
      uriTemplate: 'scrape-content://sites/{siteId}/scraped-content/{type}',
      fetchFn: ({ siteId, type }) => scrapeController.listScrapedContentFiles({
        ...context,
        params: { siteId, type },
      }),
      notFoundMessage: ({ siteId }) => `Scrape for site ${siteId} not found`,
    }),
    scrapeContentFileByKey: createProxyResource({
      name: 'scrape-content-file',
      description: 'Retrieves a specific scraped content file from S3 using its storage key. Use this after getting the file list from scrape-content-list to access the actual content of a particular scraped file. The key parameter should be obtained from the file listing.',
      uriTemplate: 'scrape-content://sites/{siteId}/files/{key}',
      fetchFn: ({ siteId, key }) => {
        const decodedKey = decodeURIComponent(key);
        return scrapeController.getFileByKey({
          ...context,
          params: { siteId },
          data: { key: decodedKey },
        });
      },
      notFoundMessage: ({ siteId, key }) => `File for ${siteId} and key ${key} not found`,
    }),
  };
}

/* c8 ignore end */
