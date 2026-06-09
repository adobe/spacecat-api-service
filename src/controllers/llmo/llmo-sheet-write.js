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

// Cap the number of row updates per request so a runaway batch can't exhaust the
// Lambda's compute / memory budget. Each update is microseconds — the SharePoint
// download/upload dominates, so increasing the cap has minimal latency impact.
export const MAX_UPDATES_PER_REQUEST = 100;

// dataSource / sheetType path segments must not contain '/', '\', '.' or any other
// character that could escape the per-tenant dataFolder when concatenated into the
// SharePoint file path or the admin.hlx.page publish URL. Allowed: alphanumerics,
// hyphen, underscore — matches every real-world LLMO sheet name in use today.
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
export const isSafePathSegment = (value) => typeof value === 'string'
  && value.length > 0 && SAFE_PATH_SEGMENT_RE.test(value);

// A `values` write may create a header column that doesn't exist yet (see
// updateWorksheet). Existing columns are never re-validated, but a *new* column
// name is gated so an authenticated caller can't pollute the worksheet header with
// arbitrary or oversized keys. The set is deliberately wider than isSafePathSegment
// (sheet headers legitimately contain spaces and '+', e.g. "Source GSC+Keywords")
// but still excludes control characters and caps length.
export const MAX_NEW_COLUMN_NAME_LENGTH = 100;
const NEW_COLUMN_NAME_RE = /^[\w .+-]+$/;
export const isCreatableColumnName = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= MAX_NEW_COLUMN_NAME_LENGTH
  && NEW_COLUMN_NAME_RE.test(value);

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
// round-trip, so indirect coverage through patchSheetRows is incomplete.
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
 * Validates a single sheet-row-update entry. Returns null on success or an error
 * message string. The optional `prefix` is included in messages so the caller can
 * point the user at the failing entry index in a batch payload.
 */
const validateUpdateEntry = (entry, prefix = '') => {
  const p = prefix ? `${prefix}.` : '';
  if (!isObject(entry)) {
    return `${prefix || 'entry'} must be an object`;
  }
  if (!hasText(entry.sheet)) {
    return `${p}sheet must be a non-empty string identifying the worksheet`;
  }
  if (!isObject(entry.match) || Object.keys(entry.match).length === 0) {
    return `${p}match must be a non-empty object of column-value pairs identifying the row`;
  }
  if (!isObject(entry.values) || Object.keys(entry.values).length === 0) {
    return `${p}values must be a non-empty object of column-value pairs to update`;
  }
  // Enforce the OpenAPI contract (additionalProperties: { type: string }) at runtime so
  // a caller that sends `{ deleted: true }` instead of `{ deleted: "true" }` gets a 400
  // rather than writing a boolean cell that diverges from the JSON projection contract.
  const nonStringMatch = Object.entries(entry.match).find(([, v]) => typeof v !== 'string');
  if (nonStringMatch) {
    return `${p}match.${nonStringMatch[0]} must be a string`;
  }
  const nonStringValue = Object.entries(entry.values).find(([, v]) => typeof v !== 'string');
  if (nonStringValue) {
    return `${p}values.${nonStringValue[0]} must be a string`;
  }
  return null;
};

/**
 * Validates the request body. Accepts either:
 *   - single-row shape: `{ sheet, match, values }`
 *   - batch shape:      `{ updates: [{ sheet, match, values }, ...] }`
 *
 * Returns `{ error }` on validation failure or `{ updates, isBatch }` on success.
 * `updates` is always normalised to an array — callers don't need to branch.
 */
export const parseSheetRowPatch = (data) => {
  if (!isObject(data)) {
    return { error: 'Request body must be an object' };
  }
  if (Array.isArray(data.updates)) {
    if (data.updates.length === 0) {
      return { error: 'updates must be a non-empty array' };
    }
    if (data.updates.length > MAX_UPDATES_PER_REQUEST) {
      return { error: `updates must contain at most ${MAX_UPDATES_PER_REQUEST} entries (got ${data.updates.length})` };
    }
    for (let i = 0; i < data.updates.length; i += 1) {
      const error = validateUpdateEntry(data.updates[i], `updates[${i}]`);
      if (error) {
        return { error };
      }
    }
    return { updates: data.updates, isBatch: true };
  }
  // Single-row body. Reject if the caller also tried to pass batch-only keys to
  // avoid ambiguity over which shape they meant.
  if ('updates' in data) {
    return { error: 'updates must be an array' };
  }
  const error = validateUpdateEntry(data);
  if (error) {
    return { error };
  }
  return { updates: [data], isBatch: false };
};

/**
 * Back-compat wrapper used by older callers that only validate. Returns the same
 * error string the previous single-row validator did, or null on success.
 */
export const validateSheetRowPatch = (data) => {
  const result = parseSheetRowPatch(data);
  return result.error ?? null;
};

// `entryRef` prefixes batch error messages with `updates[i]: ` so the caller can
// locate the failing entry. Empty for the single-update case so the wording stays
// identical to the pre-batch contract.
const updateWorksheet = (worksheet, entryRef, headerMap, match, values) => {
  const prefix = entryRef ? `${entryRef}: ` : '';

  // `match` columns must already exist — you cannot identify a row by a column the
  // worksheet doesn't have, so an unknown match column is a caller error (400).
  const unknownMatchCols = Object.keys(match).filter((c) => !headerMap.has(c));
  if (unknownMatchCols.length > 0) {
    const headers = [...headerMap.keys()].join(', ');
    const err = new Error(`${prefix}Unknown match column(s) ${unknownMatchCols.join(', ')}. Available: ${headers}`);
    err.statusCode = 400;
    throw err;
  }

  // `values` columns are created on demand: a value column that isn't in the header
  // row yet is appended after the last existing column, so e.g. the first-ever GSC
  // prompt dismissal can introduce a `status` column the generator never emitted.
  // `headerMap` is mutated in place so subsequent entries in the same batch (which
  // share the cached map) see the new column. Existing data rows leave the new cell
  // empty — only the matched row below gets a value.
  const missingValueCols = Object.keys(values).filter((c) => !headerMap.has(c));
  if (missingValueCols.length > 0) {
    const invalidNewCols = missingValueCols.filter((c) => !isCreatableColumnName(c));
    if (invalidNewCols.length > 0) {
      const err = new Error(`${prefix}Cannot create column(s) ${invalidNewCols.join(', ')}: new column names must be 1-${MAX_NEW_COLUMN_NAME_LENGTH} characters of letters, digits, spaces, and . _ + - only`);
      err.statusCode = 400;
      throw err;
    }
    const headerRow = worksheet.getRow(1);
    let nextCol = headerMap.size > 0 ? Math.max(...headerMap.values()) : 0;
    missingValueCols.forEach((column) => {
      nextCol += 1;
      headerRow.getCell(nextCol).value = column;
      headerMap.set(column, nextCol);
    });
    headerRow.commit();
  }

  const matchedRows = findRowMatching(worksheet, headerMap, match);
  if (matchedRows.length === 0) {
    const err = new Error(`${prefix}No row in worksheet "${worksheet.name}" matches ${JSON.stringify(match)}`);
    err.statusCode = 404;
    throw err;
  }
  if (matchedRows.length > 1) {
    const err = new Error(`${prefix}Match criteria are ambiguous: ${matchedRows.length} rows in "${worksheet.name}" match ${JSON.stringify(match)}. Refine match to identify exactly one row.`);
    err.statusCode = 409;
    throw err;
  }

  const [rowNumber] = matchedRows;
  const row = worksheet.getRow(rowNumber);
  Object.entries(values).forEach(([column, value]) => {
    row.getCell(headerMap.get(column)).value = value;
  });
  row.commit();
  return rowNumber;
};

/**
 * Reads the XLSX backing a single LLMO data file from SharePoint, applies one or
 * more row updates against it, uploads the workbook back, and republishes the JSON
 * projection via admin.hlx.page.
 *
 * Semantics:
 *  - All-or-nothing. Every entry must validate AND match exactly one row in its
 *    target worksheet before any writes happen. The first failing entry throws
 *    with `.statusCode` (400/404/409) and the workbook is not uploaded.
 *  - `values` columns missing from the header row are created on the fly (appended
 *    after the last column); `match` columns must already exist (unknown → 400).
 *  - Worksheet header maps are cached per-sheet across entries so a 100-update
 *    batch against the same sheet still scans the header row once.
 *
 * Concurrency: this is a read-modify-write at the workbook level. Concurrent calls
 * targeting the same workbook can clobber each other. The endpoint is intended for
 * low-frequency UI-driven edits (e.g. soft-delete on strategic-recommendations).
 *
 * @returns {Promise<{ results: Array<{ sheet: string, rowNumber: number,
 *                                       updated: Record<string, string> }> }>}
 * @throws {Error} with `.statusCode` populated (400/404/409/500) for the caller to map.
 */
export const patchSheetRows = async (
  { sharepointPath, publishPath, updates },
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

  log.info(`LLMO_SHEET_WRITE: downloading workbook ${sharepointPath} for ${updates.length} update(s)`);
  const buffer = await document.getDocumentContent();

  const workbook = new (deps.ExcelJS?.Workbook ?? ExcelJS.Workbook)();
  await workbook.xlsx.load(buffer);

  const headerMapBySheet = new Map();
  const results = [];

  for (let i = 0; i < updates.length; i += 1) {
    const { sheet, match, values } = updates[i];
    const entryRef = updates.length === 1 ? '' : `updates[${i}]`;
    const prefix = entryRef ? `${entryRef}: ` : '';
    const worksheet = workbook.getWorksheet(sheet);
    if (!worksheet) {
      const available = workbook.worksheets.map((w) => w.name).join(', ');
      const err = new Error(`${prefix}Worksheet "${sheet}" not found in workbook. Available: ${available}`);
      err.statusCode = 404;
      throw err;
    }
    if (!headerMapBySheet.has(sheet)) {
      headerMapBySheet.set(sheet, buildHeaderMap(worksheet));
    }
    const rowNumber = updateWorksheet(
      worksheet,
      entryRef,
      headerMapBySheet.get(sheet),
      match,
      values,
    );
    results.push({ sheet, rowNumber, updated: { ...values } });
  }

  log.info(`LLMO_SHEET_WRITE: writing ${updates.length} update(s) to ${sharepointPath}`);
  const outputBuffer = await workbook.xlsx.writeBuffer();
  await document.uploadRawDocument(Buffer.from(outputBuffer));

  await publishToHlx(publishPath, log, deps);

  return { results };
};

/**
 * Back-compat single-row wrapper. Returns `{ rowNumber, updated }` matching the
 * shape callers depended on before batch support landed.
 */
export const patchSheetRow = async (args, ctx, deps = {}) => {
  const {
    sharepointPath, publishPath, sheet, match, values,
  } = args;
  const { results } = await patchSheetRows(
    {
      sharepointPath,
      publishPath,
      updates: [{ sheet, match, values }],
    },
    ctx,
    deps,
  );
  const [first] = results;
  return { rowNumber: first.rowNumber, updated: first.updated };
};

export const sharepointPathFor = buildSharePointPath;
export const publishPathFor = buildPublishPath;
