/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import ExcelJS from 'exceljs';
import { hasText, isObject } from '@adobe/spacecat-shared-utils';
import { createSharePointClient } from './llmo-onboarding.js';

const SHAREPOINT_FILE_PREFIX = '/sites/elmo-ui-data';
const HLX_ADMIN_BASE_URL = 'https://admin.hlx.page';
const HLX_ORG = 'adobe';
const HLX_SITE = 'project-elmo-ui-data';
const HLX_REF = 'main';

// dataSource / sheetType path segments must not contain '/', '\', '.' or any other
// character that could escape the per-tenant dataFolder when concatenated into the
// SharePoint file path or the admin.hlx.page publish URL. Allowed: alphanumerics,
// hyphen, underscore — matches every real-world LLMO sheet name in use today.
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
export const isSafePathSegment = (value) => typeof value === 'string'
  && value.length > 0 && SAFE_PATH_SEGMENT_RE.test(value);

const buildSharePointPath = (dataFolder, sheetType, dataSource) => {
  const segments = [SHAREPOINT_FILE_PREFIX, dataFolder];
  if (sheetType) {
    segments.push(sheetType);
  }
  segments.push(`${dataSource}.xlsx`);
  return segments.join('/');
};

const buildPublishPath = (dataFolder, sheetType, dataSource) => {
  const segments = [dataFolder];
  if (sheetType) {
    segments.push(sheetType);
  }
  segments.push(`${dataSource}.json`);
  return segments.join('/');
};

// ExcelJS represents rich-text and formula cells as objects. Coerce them back to the
// plain-string projection the Helix CDN will emit, so a `match` value of e.g.
// "first prompt" still hits a row whose cell happens to be stored as rich text.
// Exported for direct unit testing — ExcelJS often normalises rich text on a write/load
// round-trip, so indirect coverage through patchSheetRow is incomplete.
export const cellValueAsString = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((r) => (r && r.text) || '').join('');
    }
    if (value.formula !== undefined) {
      return value.result === null || value.result === undefined ? '' : String(value.result);
    }
    if (typeof value.text === 'string') {
      return value.text; // hyperlink-like
    }
  }
  return String(value);
};

const findRowMatching = (worksheet, headerMap, match) => {
  const matchedRows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      return; // skip header
    }
    // Callers validate that every match column exists in headerMap before reaching here,
    // so headerMap.get(column) is always defined.
    const isMatch = Object.entries(match).every(([column, expected]) => {
      const cell = row.getCell(headerMap.get(column));
      return cellValueAsString(cell.value) === String(expected);
    });
    if (isMatch) {
      matchedRows.push(rowNumber);
    }
  });
  return matchedRows;
};

const buildHeaderMap = (worksheet) => {
  const headerRow = worksheet.getRow(1);
  const headerMap = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (cell.value !== null && cell.value !== undefined) {
      headerMap.set(String(cell.value), colNumber);
    }
  });
  return headerMap;
};

/**
 * Publishes the JSON projection of the updated workbook to admin.hlx.page so the
 * Helix CDN (project-elmo-ui-data) serves the new contents to the UI.
 *
 * Failures are logged but not thrown — the SharePoint write has already succeeded
 * by the time we publish, and the next scheduled publish cycle would pick it up.
 */
export const publishToHlx = async (publishPath, log, deps = {}) => {
  const fetchFn = deps.fetch || globalThis.fetch;
  const adminKey = deps.adminKey ?? process.env.ADMIN_HLX_API_KEY;
  if (!adminKey) {
    log.warn(`LLMO_SHEET_WRITE: ADMIN_HLX_API_KEY not configured; skipping HLX publish for ${publishPath}`);
    return;
  }
  const headers = { Cookie: `auth_token=${adminKey}` };
  const targets = ['preview', 'live'];
  for (const target of targets) {
    const url = `${HLX_ADMIN_BASE_URL}/${target}/${HLX_ORG}/${HLX_SITE}/${HLX_REF}/${publishPath}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchFn(url, { method: 'POST', headers });
      if (!response.ok) {
        log.warn(`LLMO_SHEET_WRITE: HLX ${target} publish returned ${response.status} for ${publishPath}`);
      }
    } catch (err) {
      log.warn(`LLMO_SHEET_WRITE: HLX ${target} publish failed for ${publishPath}: ${err.message}`);
    }
  }
};

/**
 * Validates the request body for a sheet-row patch.
 * Returns null on success or a string error message on failure.
 */
export const validateSheetRowPatch = (data) => {
  if (!isObject(data)) {
    return 'Request body must be an object';
  }
  if (!hasText(data.sheet)) {
    return 'sheet must be a non-empty string identifying the worksheet';
  }
  if (!isObject(data.match) || Object.keys(data.match).length === 0) {
    return 'match must be a non-empty object of column-value pairs identifying the row';
  }
  if (!isObject(data.values) || Object.keys(data.values).length === 0) {
    return 'values must be a non-empty object of column-value pairs to update';
  }
  // Enforce the OpenAPI contract (additionalProperties: { type: string }) at runtime so
  // a caller that sends `{ deleted: true }` instead of `{ deleted: "true" }` gets a 400
  // rather than writing a boolean cell that diverges from the JSON projection contract.
  const nonStringMatch = Object.entries(data.match).find(([, v]) => typeof v !== 'string');
  if (nonStringMatch) {
    return `match.${nonStringMatch[0]} must be a string`;
  }
  const nonStringValue = Object.entries(data.values).find(([, v]) => typeof v !== 'string');
  if (nonStringValue) {
    return `values.${nonStringValue[0]} must be a string`;
  }
  return null;
};

/**
 * Reads the XLSX backing a single LLMO data file from SharePoint, updates the cells
 * of exactly one row matching {match} with {values}, uploads the workbook back,
 * and republishes the JSON projection via admin.hlx.page.
 *
 * Concurrency: this is a read-modify-write at the workbook level. Concurrent calls
 * targeting the same workbook can clobber each other. The endpoint is intended for
 * low-frequency UI-driven edits (e.g. soft-delete on strategic-recommendations); for
 * high-throughput writes the SDK's worksheet-by-name row APIs should be used instead.
 *
 * @returns {Promise<{rowNumber:number, updated:Record<string,unknown>}>}
 * @throws {Error} with `.statusCode` populated (400/404/409/500) for the caller to map.
 */
export const patchSheetRow = async (
  {
    sharepointPath, publishPath, sheet, match, values,
  },
  { env, log },
  deps = {},
) => {
  const sharepointClient = deps.sharepointClient
    ?? await createSharePointClient(env);

  const document = sharepointClient.getDocument(sharepointPath);
  const exists = await document.exists();
  if (!exists) {
    const err = new Error(`Workbook not found at ${sharepointPath}`);
    err.statusCode = 404;
    throw err;
  }

  log.info(`LLMO_SHEET_WRITE: downloading workbook ${sharepointPath}`);
  const buffer = await document.getDocumentContent();

  const workbook = new (deps.ExcelJS?.Workbook ?? ExcelJS.Workbook)();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.getWorksheet(sheet);
  if (!worksheet) {
    const available = workbook.worksheets.map((w) => w.name).join(', ');
    const err = new Error(`Worksheet "${sheet}" not found in workbook. Available: ${available}`);
    err.statusCode = 404;
    throw err;
  }

  const headerMap = buildHeaderMap(worksheet);
  const unknownMatchCols = Object.keys(match).filter((c) => !headerMap.has(c));
  const unknownValueCols = Object.keys(values).filter((c) => !headerMap.has(c));
  if (unknownMatchCols.length > 0 || unknownValueCols.length > 0) {
    const headers = [...headerMap.keys()].join(', ');
    const err = new Error(`Unknown column(s) ${[...unknownMatchCols, ...unknownValueCols].join(', ')}. Available: ${headers}`);
    err.statusCode = 400;
    throw err;
  }

  const matchedRows = findRowMatching(worksheet, headerMap, match);
  if (matchedRows.length === 0) {
    const err = new Error(`No row in worksheet "${sheet}" matches ${JSON.stringify(match)}`);
    err.statusCode = 404;
    throw err;
  }
  if (matchedRows.length > 1) {
    const err = new Error(`Match criteria are ambiguous: ${matchedRows.length} rows in "${sheet}" match ${JSON.stringify(match)}. Refine match to identify exactly one row.`);
    err.statusCode = 409;
    throw err;
  }

  const [rowNumber] = matchedRows;
  const row = worksheet.getRow(rowNumber);
  Object.entries(values).forEach(([column, value]) => {
    row.getCell(headerMap.get(column)).value = value;
  });
  row.commit();

  log.info(`LLMO_SHEET_WRITE: writing row ${rowNumber} in "${sheet}" of ${sharepointPath}`);
  const outputBuffer = await workbook.xlsx.writeBuffer();
  await document.uploadRawDocument(Buffer.from(outputBuffer));

  await publishToHlx(publishPath, log, deps);

  return { rowNumber, updated: { ...values } };
};

export const sharepointPathFor = buildSharePointPath;
export const publishPathFor = buildPublishPath;
