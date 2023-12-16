/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

const PERCENT_MULTIPLIER = 100;

function addEllipsis(string, limit = 24) {
  if (string.length > limit - 2) {
    return `${string.substring(0, 18)}..`;
  }
  return string;
}

/**
 * Formats an ISO date.
 *
 * @param {string} isoDate - The ISO date to format.
 * @return {string} - The formatted date.
 */
const formatDate = (isoDate) => {
  if (isoDate === null) {
    return 'N/A';
  }

  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return date.toISOString().replace('T', ' ').slice(0, 19);
};

/**
 * Formats the score as a whole number percentage.
 *
 * @param {number} score - The score to be formatted.
 * @returns {string} The formatted percentage string.
 */
function formatScore(score) {
  if (Number.isNaN(score)) {
    return '---';
  }
  return `${Math.round(score * PERCENT_MULTIPLIER)}%`;
}

const printSiteDetails = (site) => {
  const psiURL = `https://psi.experiencecloud.live?url=${site.getBaseURL()}&strategy=mobile`;

  return `
      :mars-team: Base URL: ${site.getBaseURL()}
      :github-4173: GitHub: ${site.getGitHubURL() || '_not set_'}
      ${site.isLive() ? ':rocket:' : ':submarine:'} Is Live: ${site.isLive() ? 'Yes' : 'No'}
      :lighthouse: <${psiURL}|Run PSI check>
    `;
};

const formatURL = (input) => {
  const urlPattern = /^https?:\/\//i;

  if (urlPattern.test(input)) {
    return input.replace(/^http:/i, 'https:');
  } else {
    return `https://${input}`;
  }
};

function formatSize(bytes) {
  let kilobytes = bytes / 1024;
  const decimals = 2;
  const suffixes = ['KB', 'MB', 'GB', 'TB'];

  let index = 0;
  while (kilobytes >= 1024 && index < suffixes.length - 1) {
    kilobytes /= 1024;
    index += 1;
  }

  return `${kilobytes.toFixed(decimals)} ${suffixes[index]}`;
}

const ERROR_MAP = {
  ERRORED_DOCUMENT_REQUEST: 'Lighthouse could not fetch the page (Status: {statusCode})',
  NO_FCP: 'No First Contentful Paint',
};

function formatLighthouseError(runtimeError) {
  const { code, message } = runtimeError;
  let description = ERROR_MAP[code] || 'Unknown error';

  if (code === 'ERRORED_DOCUMENT_REQUEST') {
    const match = message.match(/\(Status code: (\d+)\)/);
    const statusCode = match ? match[1] : 'unknown';
    description = description.replace('{statusCode}', statusCode);
  }

  return `Lighthouse Error: ${description} [${code}]`;
}

export {
  addEllipsis,
  formatDate,
  formatLighthouseError,
  formatScore,
  formatSize,
  formatURL,
  printSiteDetails,
};
