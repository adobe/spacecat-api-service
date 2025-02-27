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

import { parse } from 'csv/sync';

/**
 * Parses CSV content into an array of rows
 * @param {string} content - CSV content as string
 * @param {function} [processor] - Optional function to process each row into structured data
 * @param {boolean} [skipHeader=true] - Whether to skip the first row as header
 * @returns {Array} Processed data or raw rows if no processor provided
 */
export function parseCSV(content, processor, skipHeader = true) {
  const rows = parse(content, {
    skip_empty_lines: true,
    trim: true,
    columns: false,
  });

  if (!processor) {
    return rows;
  }

  const dataRows = skipHeader && rows.length > 1 ? rows.slice(1) : rows;
  return processor(dataRows);
}

/**
 * Processes CSV rows for import configuration
 * @param {Array<Array<string>>} rows - Array of CSV rows
 * @returns {Array<{baseURL: string, importType: string, importConfig: Object}>} Processed imports
 */
export function processImportRows(rows) {
  return rows.map((row) => {
    const [baseURL, importType, importConfigStr] = row;
    let importConfig;

    try {
      importConfig = importConfigStr ? JSON.parse(importConfigStr) : undefined;
    } catch (error) {
      throw new Error(`Invalid JSON in import configuration for ${baseURL}: ${importConfigStr}`);
    }

    return {
      baseURL,
      importType,
      importConfig,
    };
  });
}
