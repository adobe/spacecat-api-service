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

/**
 * Normalizes a URL pathname for S3 storage
 * - Removes trailing slash (except for root '/')
 * - Ensures starts with '/'
 * @param {string} pathname - URL pathname
 * @returns {string} - Normalized pathname
 */
export function normalizePath(pathname) {
  let normalized = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;

  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  return normalized;
}

/**
 * Extracts and normalizes hostname from URL
 * - Strips 'www.' prefix
 * @param {URL} url - URL object
 * @param {Object} logger - Logger instance
 * @returns {string} - Normalized hostname
 * @throws {Error} - If hostname extraction fails
 */
export function getHostName(url, logger) {
  try {
    const finalHostname = url.hostname.replace(/^www\./, '');
    return finalHostname;
  } catch (error) {
    logger.error(`Error extracting host name: ${error.message}`);
    throw new Error(`Error extracting host name: ${url.toString()}`);
  }
}

/**
 * Base64 URL encodes a string (RFC 4648)
 * - Uses URL-safe characters (- instead of +, _ instead of /)
 * - Removes padding (=)
 * @param {string} input - String to encode
 * @returns {string} - Base64 URL encoded string
 */
export function base64UrlEncode(input) {
  // Encode to UTF-8 bytes
  const bytes = new TextEncoder().encode(input);
  // Convert bytes → binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Standard base64
  const base64 = btoa(binary);
  // Convert to base64url (RFC 4648)
  return base64
    .replace(/\+/g, '-') // + → -
    .replace(/\//g, '_') // / → _
    .replace(/=+$/, ''); // remove padding
}

/**
 * Generates S3 path for Tokowaka configuration based on URL
 * @param {string} url - Full URL (e.g., 'https://www.example.com/products/item')
 * @param {Object} logger - Logger instance
 * @param {boolean} isPreview - Whether this is a preview path
 * @returns {string} - S3 path (e.g., 'opportunities/example.com/L3Byb2R1Y3RzL2l0ZW0')
 * @throws {Error} - If URL parsing fails
 */
export function getTokowakaConfigS3Path(url, logger, isPreview = false) {
  try {
    const urlObj = new URL(url);
    let path = urlObj.pathname;

    path = normalizePath(path);
    path = base64UrlEncode(path);

    const normalizedHostName = getHostName(urlObj, logger);
    const prefix = isPreview ? 'preview/opportunities' : 'opportunities';

    return `${prefix}/${normalizedHostName}/${path}`;
  } catch (error) {
    logger.error(`Error generating S3 path for URL ${url}: ${error.message}`);
    throw new Error(`Failed to generate S3 path: ${error.message}`);
  }
}

/**
 * Generates S3 path for domain-level metaconfig
 * @param {string} url - Full URL (used to extract domain)
 * @param {Object} logger - Logger instance
 * @param {boolean} isPreview - Whether this is a preview path
 * @returns {string} - S3 path for metaconfig (e.g., 'opportunities/example.com/config')
 * @throws {Error} - If URL parsing fails
 */
export function getTokowakaMetaconfigS3Path(url, logger, isPreview = false) {
  try {
    const urlObj = new URL(url);
    const normalizedHostName = getHostName(urlObj, logger);
    const prefix = isPreview ? 'preview/opportunities' : 'opportunities';

    return `${prefix}/${normalizedHostName}/config`;
  } catch (error) {
    logger.error(`Error generating metaconfig S3 path for URL ${url}: ${error.message}`);
    throw new Error(`Failed to generate metaconfig S3 path: ${error.message}`);
  }
}
