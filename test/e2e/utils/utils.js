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

import { Blob } from 'buffer';
import path from 'path';
import fs from 'fs';
import { expect } from 'chai';
import { apiKey, apiUrl } from '../config/config.js';

const defaultUrls = [
  'https://business.adobe.com/products/experience-manager/sites/aem-sites.html',
  'https://www.adobe.com/products/photoshop.html',
];

/* eslint-disable no-await-in-loop */
export async function makeRequest({
  url = apiUrl, method, data, key = apiKey,
}) {
  const parsedUrl = new URL(url);
  const headers = new Headers({
    'Content-Type': data ? 'application/json' : '',
    'x-api-key': key,
  });

  // FormData requests set the multipart/form-data header (including boundary) automatically
  if (data instanceof FormData) {
    headers.delete('Content-Type');
  }

  return fetch(parsedUrl, {
    method,
    headers,
    body: data,
  });
}

export function getNewImportJobRequestData({
  urls = defaultUrls, options, bundledImportJsPath,
} = {}) {
  const requestBody = new FormData();
  requestBody.append('urls', JSON.stringify(urls));

  if (options) {
    // Conditionally include options, when provided
    requestBody.append('options', JSON.stringify(options));
  }

  if (bundledImportJsPath) {
    // Conditionally include the custom (bundled) import.js, when provided
    const bundledCode = fs.readFileSync(bundledImportJsPath, 'utf8');
    const bundledScriptBlob = new Blob([bundledCode], { type: 'application/javascript' });
    requestBody.append('importScript', bundledScriptBlob, path.basename(bundledImportJsPath));
  }

  return requestBody;
}

export async function getImportJobStatus(jobId) {
  const response = await makeRequest({
    url: `${apiUrl}/${jobId}`,
    method: 'GET',
  });

  return response.json();
}

export async function pollUntilJobIsComplete(jobId) {
  let jobStatus = 'RUNNING';
  let job;
  while (jobStatus === 'RUNNING') {
    // Wait for 3 seconds before polling
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });

    job = await getImportJobStatus(jobId);
    jobStatus = job.status;
  }

  return job;
}

/**
 * Retries an async function with exponential backoff.
 * Only retries on 5xx server errors by default.
 *
 * @param {Function} fn - Async function to retry (should return response object)
 * @param {Object} options - Configuration options
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {Function} [options.shouldRetry] - Custom function to determine if retry needed
 * @returns {Promise<*>} - Result of the function
 */
export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    shouldRetry = (response) => response.status >= 500,
  } = options;

  let response;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    response = await fn();

    if (!shouldRetry(response)) {
      return response;
    }

    if (attempt < maxRetries - 1) {
      const delay = baseDelayMs * (2 ** attempt);
      const jitter = Math.floor(Math.random() * (delay / 2));
      // eslint-disable-next-line no-console
      console.log(`Retry ${attempt + 1}/${maxRetries - 1} after ${delay + jitter}ms (status: ${response.status})`);
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }

  return response;
}

export function expectJobsToMatch(expectedJob, actualJob) {
  const propertiesToIgnore = ['id', 'startTime', 'endTime', 'duration'];

  for (const key of Object.keys(expectedJob)) {
    if (!propertiesToIgnore.includes(key)) {
      // Compare all props except for the ones we are ignoring
      expect(expectedJob[key]).to.deep.equal(actualJob[key]);
    }
  }
}
