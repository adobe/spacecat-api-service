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
      description: `
        <use_case>
          Use this resource to discover and list all scraped content files available for a specific site. 
          Returns metadata about files including names, storage keys, sizes, and modification dates.
          Perfect for exploring what content has been scraped before retrieving specific files.
          Supports pagination and filtering by path for large datasets.
        </use_case>
        
        <important_notes>
          1. If you have a URL instead of siteId, first use getSiteByBaseURL to get the site details
          2. Always use this resource first to explore available content before retrieving files
          3. Supports different content types: "scrapes" (web pages), "imports" (bulk data), and "accessibility" (a11y audits)
          4. For filtering by path or pagination, use the listScrapedContentFiles tool instead
          5. The returned storage keys are required for retrieving actual file content
          6. File metadata includes size information to help decide retrieval strategy
        </important_notes>
      `,
      uriTemplate: 'scrape-content://sites/{siteId}/scraped-content/{type}',
      fetchFn: ({
        siteId, type, path, rootOnly, pageSize, pageToken,
      }) => scrapeController.listScrapedContentFiles({
        ...context,
        params: { siteId, type },
        data: {
          path, rootOnly, pageSize, pageToken,
        },
      }),
      notFoundMessage: ({ siteId }) => `Scrape for site ${siteId} not found`,
    }),
    scrapeContentFileByKey: createProxyResource({
      name: 'scrape-content-file',
      description: `
        <use_case>
          Use this resource to retrieve the actual content of a specific scraped file using its storage key.
          Returns either the file content directly or a presigned URL for large files.
          Perfect for accessing scraped web pages, imported data, or accessibility audit results.
        </use_case>
        
        <important_notes>
          1. Complete workflow: URL → getSiteByBaseURL → scrape-content-list → scrape-content-file
          2. The storage key must be obtained from scrape-content-list first
          3. Keys are automatically URL-decoded to handle encoded characters
          4. Use the exact key returned from the file listing without modification
          5. For specific page content, look for keys that match the URL path you're interested in
        </important_notes>
      `,
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
