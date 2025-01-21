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

import Fuse from 'fuse.js';

const fuseOptions = {
  // isCaseSensitive: false,
  includeScore: true,
  // shouldSort: true,
  // includeMatches: false,
  // findAllMatches: false,
  minMatchCharLength: 5,
  threshold: 0.6,
  useExtendedSearch: true,
  // ignoreLocation: false,
  // ignoreFieldNorm: true,
  // fieldNormWeight: 1,
  keys: [
    'name',
  ],
};

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
    .replace(/[\u0300-\u036f]/g, ' ')
    // remove all non-alphanumeric characters except spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // collapse multiple spaces and trim leading/trailing spaces
    .replace(/\s+/g, ' ')
    .trim();
}

export async function matchCompanies(dataAccess, query) {
  const { Organization } = dataAccess;
  const orgs = (await Organization.all())
    .map((org) => ({
      id: org.getId(),
      name: org.getName(),
      imsOrgId: org.getImsOrgId(),
    }));

  // makes sure the fuzzy search matches at least 1 word in the query one-to-one
  // see. https://www.fusejs.io/examples.html#extended-search
  const searchQuery = normalizeStringKeepingSpaces(query).split(' ')
    .map((t) => `'${t}`).join(' | ');

  const fuse = new Fuse(orgs, fuseOptions);
  const initial = fuse.search(searchQuery);

  // fallback to the original search query in case the partial exact match doesn't yield
  const final = initial.length > 0 ? initial : fuse.search(query);

  return final.map((r) => r.item);
}
