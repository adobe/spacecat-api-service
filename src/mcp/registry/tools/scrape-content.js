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

import { z } from 'zod';
import { createProxyTool } from '../../../utils/jsonrpc.js';

export function createScrapeContentTools(scrapeController, context) {
  if (!scrapeController) {
    return {};
  }

  /* ------------- listScrapedContentFiles ---------------- */
  const listScrapedContentFilesTool = createProxyTool({
    annotations: {
      title: 'List Scraped Content Files',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `
      <use_case>
        Use this tool to discover and list all scraped content files available for a specific site. 
        Returns metadata about files including names, storage keys, sizes, and modification dates.
        Perfect for exploring what content has been scraped before retrieving specific files.
        Supports pagination and filtering by path for large datasets.
      </use_case>
      
      <important_notes>
        1. If you have a URL instead of siteId, first use getSiteByBaseURL to get the site details
        2. Always use this tool first to explore available content before retrieving files
        3. Supports different content types: "scrapes" (web pages), "imports" (bulk data), and "accessibility" (a11y audits)
        4. Use 'path' parameter to filter files by specific URL paths (e.g., "/products" to find product pages)
        5. Use 'rootOnly=true' to list only top-level directories instead of all files
        6. Results are paginated - use 'pageToken' from response to get next page
        7. The returned storage keys are required for retrieving actual file content
        8. File metadata includes size information to help decide retrieval strategy
      </important_notes>
    `,
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site to fetch scraped content for'),
      type: z.string().describe('The handler type for scraped content (e.g., "scrapes", "imports", "accessibility")'),
      path: z.string().optional().describe('Filter files by path prefix (e.g., "/products" to find product pages)'),
      rootOnly: z.string().optional().describe('Set to "true" to list only top-level directories instead of all files'),
      pageSize: z.string().optional().describe('Number of items per page (default: 100, max when rootOnly=true: 100)'),
      pageToken: z.string().optional().describe('Token for pagination - use nextPageToken from previous response'),
    }).strict(),
    fetchFn: ({
      siteId, type, path, rootOnly, pageSize, pageToken,
    }) => scrapeController.listScrapedContentFiles({
      ...context,
      params: { siteId, type },
      data: {
        path, rootOnly, pageSize, pageToken,
      },
    }),
    notFoundMessage: ({ siteId, type }) => `Scraped content files for site ${siteId} and type ${type} not found`,
  });

  /* ------------- getScrapedContentFileByKey ---------------- */
  const getScrapedContentFileByKeyTool = createProxyTool({
    annotations: {
      title: 'Get Scraped Content File by Key',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `
      <use_case>
        Use this tool to retrieve the actual content of a specific scraped file using its storage key.
        Returns either the file content directly or a presigned URL for large files.
        Perfect for accessing scraped web pages, imported data, or accessibility audit results.
      </use_case>
      
      <important_notes>
        1. Complete workflow: URL → getSiteByBaseURL → listScrapedContentFiles → getScrapedContentFileByKey
        2. The storage key must be obtained from listScrapedContentFiles first
        3. Keys are automatically URL-decoded to handle encoded characters
        4. Use the exact key returned from the file listing without modification
        5. For specific page content, look for keys that match the URL path you're interested in
      </important_notes>
    `,
    inputSchema: z.object({
      siteId: z.string().uuid().describe('The UUID of the site'),
      key: z.string().describe('The storage key of the file to retrieve (obtained from file listing)'),
    }).strict(),
    fetchFn: ({ siteId, key }) => {
      const decodedKey = decodeURIComponent(key);
      return scrapeController.getFileByKey({
        ...context,
        params: { siteId },
        data: { key: decodedKey },
      });
    },
    notFoundMessage: ({ siteId, key }) => `Scraped content file for site ${siteId} with key ${key} not found`,
  });

  return {
    listScrapedContentFiles: listScrapedContentFilesTool,
    getScrapedContentFileByKey: getScrapedContentFileByKeyTool,
  };
}

/* c8 ignore end */
