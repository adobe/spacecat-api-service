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

/**
 * Endpoint registry for the Brand24 proxy (POC — Offsite Visibility dashboard,
 * project-elmo-ui). Maps a friendly `endpoint` key to the real Brand24 REST
 * path, its path params, and the query params callers are allowed to pass
 * through. Deliberately narrow (only what the dashboard uses today) — ported
 * from the same-shaped registry in the brand24-project-explorer POC app
 * (src/lib/endpoints.ts) so the two stay easy to compare.
 */

const DATE_QUERY = ['date_from', 'date_to'];

function projectEndpoint(key, tail, extraQuery = [], maxRangeDays = null) {
  return {
    key,
    pathTemplate: `/api-data/v1/project/{project_id}/${tail}`,
    pathParams: ['project_id'],
    allowedQuery: [...DATE_QUERY, ...extraQuery],
    maxRangeDays,
  };
}

export const BRAND24_ENDPOINTS = {
  'projects-list': {
    key: 'projects-list',
    pathTemplate: '/api-data/v1/account/{account_id}/projects_list/',
    pathParams: ['account_id'],
    allowedQuery: [],
    maxRangeDays: null,
  },
  'mentions-count': projectEndpoint('mentions-count', 'mentions/count', [], 31),
  'mentions-sentiment': projectEndpoint('mentions-sentiment', 'mentions/sentiment', [], 31),
  'mentions-reach': projectEndpoint('mentions-reach', 'mentions/reach', [], 31),
  mentions: projectEndpoint('mentions', 'mentions', ['limit', 'cursor'], null),
  'ai-summary': projectEndpoint('ai-summary', 'ai-summary', [], 31),
  'ai-insights': projectEndpoint('ai-insights', 'ai-insights', [], 31),
  'usage-estimation': {
    key: 'usage-estimation',
    pathTemplate: '/api-data/v1/account/mentions-usage-estimation',
    pathParams: [],
    allowedQuery: [],
    maxRangeDays: null,
  },
};

export function getBrand24Endpoint(key) {
  return BRAND24_ENDPOINTS[key];
}

export function buildBrand24Path(endpointDef, pathValues) {
  return endpointDef.pathTemplate
    .replace('{project_id}', String(pathValues.project_id ?? ''))
    .replace('{account_id}', String(pathValues.account_id ?? ''));
}
