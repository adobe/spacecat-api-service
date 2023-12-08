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

const { extractLastAudit } = require('./audit.js');

const PERCENT_MULTIPLIER = 100;

function addEllipsis(string, limit = 24) {
  if (string.length > limit - 2) {
    return `${string.substring(0, 18)}..`;
  }
  return string;
}

/**
 * Extracts the last word from a sentence.
 *
 * @param {string} sentence - The sentence to extract the last word from.
 * @return {string} - The last word of the sentence.
 */
const getLastWord = (sentence) => sentence.trim().split(' ').pop();

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
  const psiURL = `https://developers.google.com/speed/pagespeed/insights/?url=${site.domain}&strategy=mobile`;

  const lastAuditedAt = formatDate(extractLastAudit(site)?.auditedAt);

  return `
      :mars-team: Domain: https://${site.domain}
      :github-4173: GitHub: ${site.gitHubURL ? site.gitHubURL : '_not set_'}
      ${site.isLive ? ':rocket:' : ':submarine:'} Is Live: ${site.isLive ? 'Yes' : 'No'}
      :lighthouse: <${psiURL}|Run PSI check>
      :clock1: Last audit on ${lastAuditedAt}
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

export {
  addEllipsis,
  formatDate,
  formatScore,
  formatSize,
  formatURL,
  getLastWord,
  printSiteDetails,
};
