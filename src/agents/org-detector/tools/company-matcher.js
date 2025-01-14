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

/**
 * Normalizes a string by converting it to lowercase, removing diacritics (accents),
 * and retaining only alphanumeric characters and spaces.
 *
 * @param {string} str - The input string to normalize.
 * @returns {string} - The normalized string with spaces preserved.
 */
function normalizeStringKeepingSpaces(str) {
  return str
    .toLowerCase()
    // remove diacritics (accents)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // remove all non-alphanumeric characters except spaces
    .replace(/[^a-z0-9\s]/g, '')
    // collapse multiple spaces and trim leading/trailing spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes the length of the longest common substring between two strings
 * that starts immediately after a space or at index 0 in both strings.
 *
 * @param {string} str1 - The first input string.
 * @param {string} str2 - The second input string.
 * @returns {number} - The length of the longest common substring meeting the criteria.
 */
function longestCommonSubstringAfterWhitespace(str1, str2) {
  const s1 = normalizeStringKeepingSpaces(str1);
  const s2 = normalizeStringKeepingSpaces(str2);

  /* c8 ignore next 1 */
  if (!s1.length || !s2.length) return 0;

  // initialize the DP table
  const dp = Array(s1.length + 1)
    .fill(null)
    .map(() => Array(s2.length + 1).fill(0));

  let maxLen = 0;

  // fill the DP table
  for (let i = 1; i <= s1.length; i += 1) {
    for (let j = 1; j <= s2.length; j += 1) {
      if (s1[i - 1] === s2[j - 1]) {
        if (dp[i - 1][j - 1] > 0) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          const canStartS1 = i === 1 || s1[i - 2] === ' ';
          const canStartS2 = j === 1 || s2[j - 2] === ' ';
          dp[i][j] = canStartS1 && canStartS2 ? 1 : 0;
        }
        maxLen = Math.max(maxLen, dp[i][j]);
      } else {
        dp[i][j] = 0;
      }
    }
  }

  return maxLen;
}

/**
 * Filters a list of organizations to find those whose names have a significant
 * similarity to a query string based on the longest common substring.
 *
 * @param {object} dataAccess - An object providing access to the data layer.
 * @param {object} dataAccess.Organization - A data access model for organizations.
 * @param {string} query - The query string to match against organization names.
 * @returns {Promise<Array<{id: string, name: string, imsOrgId: string}>>}
 *          A promise that resolves to an array of matched organizations with their details.
 */
export async function matchCompanies(dataAccess, query) {
  const { Organization } = dataAccess;

  const orgs = await Organization.all();

  return orgs.filter((org) => longestCommonSubstringAfterWhitespace(org.getName(), query) > 4)
    .map((org) => ({
      id: org.getId(),
      name: org.getName(),
      imsOrgId: org.getImsOrgId(),
    }));
}
