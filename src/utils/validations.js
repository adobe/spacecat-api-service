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

const MAX_BODY_SIZE = 4 * 1024 * 1024; // 4 MB

/**
 * Validates if the URL is a valid GitHub repository URL.
 *
 * @param {string} repoUrl - The GitHub repository URL.
 * @returns {boolean} true if the URL is valid, false otherwise.
 */
function validateRepoUrl(repoUrl) {
  return /^https:\/\/github\.com\/[\w-]+\/[\w-]+(\.git)?$/.test(repoUrl);
}

/**
 * Checks if the provided body fits within the given size budget.
 * Supports strings, Uint8Array (Buffer) and arbitrary JSON-serialisable values.
 *
 * @param {any} data – request body to measure.
 * @param {number} maxSize – maximum allowed size in bytes.
 * @returns {boolean} true when size <= maxSize.
 */
function checkBodySize(data, maxSize) {
  if (data instanceof Uint8Array) {
    return data.length <= maxSize;
  }

  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8') <= maxSize;
  }

  if (data !== null && data !== undefined) {
    const jsonStr = JSON.stringify(data);
    return Buffer.byteLength(jsonStr, 'utf8') <= maxSize;
  }

  return true;
}

export {
  MAX_BODY_SIZE,
  validateRepoUrl,
  checkBodySize,
};
