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

import fetch from '@adobe/fetch';
import { parseCSV } from '../csv.js';

/**
 * Downloads and parses a CSV file from Slack
 * @param {Object} file - Slack file object
 * @param {string} file.url_private - Private URL of the file
 * @param {string} file.token - Slack bot token for authentication
 * @param {function} [processor] - Optional function to process each row into structured data
 * @param {boolean} [skipHeader=true] - Whether to skip the first row as header
 * @returns {Promise<Array>} Processed data or raw rows if no processor provided
 */
export async function parseCSVFromSlack(file, processor, skipHeader = true) {
  const response = await fetch(file.url_private, {
    headers: {
      Authorization: `Bearer ${file.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file from Slack: ${response.statusText}`);
  }

  const content = await response.text();
  return parseCSV(content, processor, skipHeader);
}
