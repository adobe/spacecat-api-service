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
import { createUrl } from '@adobe/fetch';
import { fetch, isAuditForAll } from '../support/utils.js';

const DOMAIN_LIST_URL = 'https://helix-pages.anywhere.run/helix-services/run-query@v3/dash/domain-list';
export const DEFAULT_PARAMS = { // export for testing
  interval: 30,
  offset: 0,
  limit: 100000,
};
export default async function fetchDomainList(domainkey, url) {
  const params = {
    ...DEFAULT_PARAMS,
    domainkey,
  };

  const resp = await fetch(createUrl(DOMAIN_LIST_URL, params));
  const respJson = await resp.json(); // intentionally not catching parse error here.

  const data = respJson?.results?.data;
  if (!Array.isArray(data)) {
    throw new Error('Unexpected response format. $.results.data is not array');
  }

  const urls = data.map((row) => row.hostname);
  return isAuditForAll(url) ? urls : urls.filter((row) => url === row);
}
