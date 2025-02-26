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

const PSI_ERROR_MAP = {
  ERRORED_DOCUMENT_REQUEST: {
    messageFormat: 'Could not fetch the page (Status: {statusCode})',
    pattern: /\(Status code: (\d+)\)/,
  },
  FAILED_DOCUMENT_REQUEST: {
    messageFormat: 'Failed to load the page (Details: {details})',
    pattern: /\(Details: (.+)\)/,
  },
  DNS_FAILURE: {
    messageFormat: 'DNS lookup failed',
    pattern: null,
  },
  NO_FCP: {
    messageFormat: 'No First Contentful Paint',
    pattern: null,
  },
};

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
  return `${Math.round(score * PERCENT_MULTIPLIER)}`;
}

const printSiteDetails = (site, isAuditEnabled, psiStrategy = 'mobile', latestAudit = null) => {
  const viewPSILink = latestAudit
    ? `${latestAudit.getIsError() ? ':warning: ' : ''}<https://googlechrome.github.io/lighthouse/viewer/?jsonurl=${latestAudit.getFullAuditRef()}|View Latest Audit> or `
    : '';
  const runPSILink = `<https://psi.experiencecloud.live?url=${site.getBaseURL()}&strategy=${psiStrategy}|Run PSI Check>`;

  const auditDisabledText = !isAuditEnabled ? ':warning: Audits have been disabled for site or strategy! This is usually done when PSI audits experience errors due to the target having issues (e.g. DNS or 404).\n' : '';

  return `${auditDisabledText}
      :identification_card: ${site.getId()}
      :cat-egory-white: ${site.getDeliveryType()}
      :github-4173: ${site.getGitHubURL() || '_not set_'}
      ${site.getIsLive() ? `:rocket: Is live (${formatDate(site.getIsLiveToggledAt())})` : ':submarine: Is not live'}
      :lighthouse: ${viewPSILink}${runPSILink}
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

function formatLighthouseError(runtimeError) {
  const { code, message } = runtimeError;
  const errorConfig = PSI_ERROR_MAP[code] || { messageFormat: 'Unknown error', pattern: null };
  let description = errorConfig.messageFormat;

  if (errorConfig.pattern) {
    const match = message.match(errorConfig.pattern);
    if (match) {
      const placeholders = [...match].slice(1);
      placeholders.forEach((value) => {
        description = description.replace(/\{[^}]+\}/i, value);
      });
    } else {
      description = description.replace(/\{[^}]+\}/g, 'unknown');
    }
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
