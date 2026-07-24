#!/usr/bin/env node
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

/* eslint-disable no-console */

/**
 * Generates a whole-API Insomnia v4 export from a bundled, dereferenced OpenAPI spec.
 *
 * Conventions baked in:
 *   - A "Base Environment" (dev, baseUrl -> /api/ci) plus a "Prod" sub-environment
 *     (baseUrl -> /api/v1), both carrying `imsAccessToken`, `sessionToken`, and every
 *     distinct path-param name found across the whole spec (siteId, organizationId,
 *     opportunityId, etc.) as empty variables to fill in.
 *   - An "Auth" folder containing only the `login` operation (exchanges an Adobe IMS
 *     access token for a session token via POST /auth/login). Its after-response
 *     script stores the returned `sessionToken` into whichever environment is active.
 *   - An "API" container folder holding one subfolder per resource (grouped by each
 *     operation's most specific tag - this spec's convention is
 *     `tags: [genericTag, ..., specificTag]`, e.g. `[site, audit policy]`). Each
 *     subfolder - not the "API" folder itself - carries the inherited
 *     `Authorization: Bearer {{ _.sessionToken }}` and `x-client-type: api-e2e-tests`
 *     headers: Insomnia only reliably inherits folder headers from a request's direct
 *     parent, not further up a multi-level ancestor chain.
 *
 * Usage:
 *   # 1. Bundle the spec into one fully-resolved file (no $ref left) - required first,
 *   #    since Insomnia's importer expects everything inlined.
 *   npx @redocly/cli bundle docs/openapi/api.yaml --dereferenced --ext json \
 *     -o tmp/bundled-api.json
 *
 *   # 2. Generate the Insomnia export from that bundle.
 *   node scripts/generate-insomnia-collection.mjs
 *   node scripts/generate-insomnia-collection.mjs --spec-path /path/to/bundled-api.json \
 *     --output /path/to/export.json
 *
 * Then in Insomnia (or an Insomnia-based tool): Import -> the generated file. Fill in
 * `imsAccessToken` (and any path params you need) in the active environment, run
 * "Login" once, then run anything else.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'spec-path': { type: 'string', default: 'tmp/bundled-api.json' },
    output: { type: 'string', default: 'tmp/spacecat-api-insomnia-export.json' },
  },
});

const spec = JSON.parse(readFileSync(args['spec-path'], 'utf-8'));
const { paths } = spec;

// ---------------------------------------------------------------------------
// id helpers
// ---------------------------------------------------------------------------
const idCounters = {};
function makeId(prefix, key) {
  const n = idCounters[prefix] ?? 0;
  idCounters[prefix] = n + 1;
  const safe = key.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 40);
  return `${prefix}_${safe}_${n}`;
}

// ---------------------------------------------------------------------------
// path params
// ---------------------------------------------------------------------------
function pathParams(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function insomniaUrl(path) {
  return path.replace(/\{([^}]+)\}/g, (_match, name) => `{{ _.${name} }}`);
}

const allParams = [...new Set(Object.keys(paths).flatMap(pathParams))].sort();

// ---------------------------------------------------------------------------
// example synthesis
// ---------------------------------------------------------------------------
const PLACEHOLDER_BY_FORMAT = {
  uuid: '00000000-0000-4000-8000-000000000000',
  'date-time': '2026-01-01T00:00:00.000Z',
  date: '2026-01-01',
  email: 'user@example.com',
  uri: 'https://example.com',
};

function synthExample(schema, depth = 0, seen = new Set()) {
  if (!schema || depth > 4 || typeof schema !== 'object' || seen.has(schema)) {
    return null;
  }
  const nextSeen = new Set(seen).add(schema);

  if ('example' in schema) {
    return schema.example;
  }
  if (schema.examples && typeof schema.examples === 'object') {
    const first = Object.values(schema.examples)[0];
    if (first && typeof first === 'object' && 'value' in first) {
      return first.value;
    }
  }
  if ('default' in schema) {
    return schema.default;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  let { type } = schema;
  if (Array.isArray(type)) {
    type = type.find((t) => t !== 'null') ?? type[0];
  }

  if (type === 'object' || (type === undefined && schema.properties)) {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const keys = Object.keys(props);
    const chosen = keys.filter((k) => required.has(k));
    const picked = chosen.length > 0 ? chosen : keys.slice(0, 3);
    const out = {};
    picked.forEach((k) => {
      out[k] = synthExample(props[k], depth + 1, nextSeen);
    });
    return out;
  }
  if (type === 'array') {
    const item = synthExample(schema.items, depth + 1, nextSeen);
    return item !== null ? [item] : [];
  }
  if (type === 'string') {
    return PLACEHOLDER_BY_FORMAT[schema.format] ?? 'string';
  }
  if (type === 'integer' || type === 'number') {
    return 0;
  }
  if (type === 'boolean') {
    return false;
  }
  return null;
}

function requestBodyText(op) {
  const rb = op.requestBody;
  if (!rb) {
    return null;
  }
  const jsonContent = rb.content?.['application/json'];
  if (!jsonContent) {
    return null;
  }

  let example;
  if ('example' in jsonContent) {
    ({ example } = jsonContent);
  } else if (jsonContent.examples && Object.keys(jsonContent.examples).length > 0) {
    const first = Object.values(jsonContent.examples)[0];
    example = first && typeof first === 'object' && 'value' in first ? first.value : first;
  } else {
    example = synthExample(jsonContent.schema);
  }
  return example === null || example === undefined ? null : JSON.stringify(example, null, 2);
}

function queryParams(op) {
  return (op.parameters ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => {
      const schema = p.schema ?? {};
      const value = p.example ?? schema.default ?? schema.example ?? '';
      return {
        name: p.name,
        value: String(value ?? ''),
        description: p.description ?? '',
        disabled: !p.required,
      };
    });
}

function opName(method, path, op) {
  if (op.summary && op.summary.length <= 90) {
    return op.summary;
  }
  return `${method.toUpperCase()} ${path}`;
}

function opDescription(op) {
  const parts = [];
  if (op.summary) {
    parts.push(op.summary);
  }
  if (op.description && op.description !== op.summary) {
    parts.push(op.description);
  }
  const codes = Object.keys(op.responses ?? {});
  if (codes.length > 0) {
    parts.push(`Responses: ${codes.sort().join(', ')}.`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// collect operations, primary-tag grouping
// ---------------------------------------------------------------------------
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = [];
Object.entries(paths).forEach(([path, methods]) => {
  Object.entries(methods).forEach(([method, op]) => {
    if (METHODS.includes(method)) {
      operations.push([path, method, op]);
    }
  });
});

let loginOp = null;
const grouped = {};
operations.forEach(([path, method, op]) => {
  if (op.operationId === 'login') {
    loginOp = [path, method, op];
    return;
  }
  const tags = op.tags ?? ['untagged'];
  const primary = tags[tags.length - 1];
  (grouped[primary] ??= []).push([path, method, op]);
});

// ---------------------------------------------------------------------------
// build resources
// ---------------------------------------------------------------------------
const resources = [];

const WORKSPACE_ID = 'wrk_spacecat_api';
const BASE_ENV_ID = 'env_base_spacecat';
const PROD_ENV_ID = 'env_sub_prod_spacecat';
const AUTH_FOLDER_ID = 'fld_auth';
const API_FOLDER_ID = 'fld_api';

resources.push({
  _id: WORKSPACE_ID,
  _type: 'workspace',
  parentId: null,
  name: 'SpaceCat API',
  description: [
    'Full request collection generated from the bundled OpenAPI spec '
      + '(docs/openapi/api.yaml, adobe/spacecat-api-service, main branch) - '
      + `${operations.length - (loginOp ? 1 : 0)} operations across ${Object.keys(grouped).length} `
      + 'resource folders.',
    'Run "Login" first (Auth folder) to exchange an Adobe IMS access token for a session token '
      + '- its after-response script stores it into the active environment. Each resource '
      + 'subfolder under "API" attaches that session token as `Authorization: Bearer <sessionToken>`, '
      + 'plus an `x-client-type: api-e2e-tests` header, to every request inside it (folder-level '
      + 'headers - Insomnia only reliably inherits from the direct parent folder, so these are set '
      + 'per-subfolder rather than once on "API"). The service accepts the session JWT via '
      + 'Authorization header or cookie interchangeably (bearer checked first) - see '
      + 'https://opensource.adobe.com/spacecat-api-service/#section/Authentication/cookie_auth',
    'Switch environments (bottom-left dropdown) to move between Dev and Prod - each carries its '
      + 'own baseUrl plus every distinct path parameter name used across the whole API (siteId, '
      + 'organizationId, opportunityId, etc.). Many of these names are reused across unrelated '
      + 'resources (e.g. the generic `id` / `name` / `type` params), so expect to update the '
      + 'relevant variable when switching which endpoint you are exercising.',
  ].join('\n\n'),
  scope: 'collection',
});

const envData = { baseUrl: '', imsAccessToken: '', sessionToken: '' };
allParams.forEach((p) => {
  envData[p] = '';
});
const envOrder = ['baseUrl', 'imsAccessToken', 'sessionToken', ...allParams];

resources.push({
  _id: BASE_ENV_ID,
  _type: 'environment',
  parentId: WORKSPACE_ID,
  name: 'Base Environment',
  data: { ...envData, baseUrl: 'https://spacecat.experiencecloud.live/api/ci' },
  dataPropertyOrder: { '&': envOrder },
  color: null,
  isPrivate: false,
  metaSortKey: 1000000000000,
});

resources.push({
  _id: PROD_ENV_ID,
  _type: 'environment',
  parentId: BASE_ENV_ID,
  name: 'Prod',
  data: { ...envData, baseUrl: 'https://spacecat.experiencecloud.live/api/v1' },
  dataPropertyOrder: { '&': envOrder },
  color: '#e53935',
  isPrivate: false,
  metaSortKey: 1000000000001,
});

resources.push({
  _id: AUTH_FOLDER_ID,
  _type: 'request_group',
  parentId: WORKSPACE_ID,
  name: 'Auth',
  description: '',
  environment: {},
  environmentPropertyOrder: null,
  metaSortKey: 1000000000000,
});

if (loginOp) {
  const [path, method] = loginOp;
  resources.push({
    _id: 'req_login',
    _type: 'request',
    parentId: AUTH_FOLDER_ID,
    name: 'Login (IMS access token -> session token)',
    description: 'Authenticates with an IMS access token and returns { sessionToken } - a '
      + 'service-signed JWT containing the user profile and tenants. security: [] - no auth '
      + 'required for this call itself.\n\n'
      + 'Ref: https://opensource.adobe.com/spacecat-api-service/#tag/auth/operation/login',
    method: method.toUpperCase(),
    url: `{{ _.baseUrl }}${insomniaUrl(path)}`,
    body: {
      mimeType: 'application/json',
      text: '{\n  "accessToken": "{{ _.imsAccessToken }}"\n}',
    },
    parameters: [],
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'x-client-type', value: 'api-e2e-tests' },
    ],
    authentication: { type: 'none' },
    afterResponseScript: [
      'const body = insomnia.response.json();',
      'if (insomnia.response.code === 200 && body && body.sessionToken) {',
      "  insomnia.environment.set('sessionToken', body.sessionToken);",
      "  console.log('sessionToken stored in the active environment.');",
      '} else {',
      "  console.log('Login did not return a sessionToken - check imsAccessToken.');",
      '}',
    ].join('\n'),
    metaSortKey: 1000000000000,
    isPrivate: false,
    settingStoreCookies: true,
    settingSendCookies: true,
  });
}

resources.push({
  _id: API_FOLDER_ID,
  _type: 'request_group',
  parentId: WORKSPACE_ID,
  name: 'API',
  description: 'Every non-login endpoint lives under here. Authorization (Bearer) + '
    + 'x-client-type headers live on each resource subfolder, not here - Insomnia only '
    + "reliably inherits from a request's direct parent folder.",
  environment: {},
  environmentPropertyOrder: null,
  metaSortKey: 1000000000001,
});

let folderSort = 0;
Object.keys(grouped).sort().forEach((tag) => {
  const folderId = makeId('fld', tag);
  resources.push({
    _id: folderId,
    _type: 'request_group',
    parentId: API_FOLDER_ID,
    name: tag,
    description: '',
    environment: {},
    environmentPropertyOrder: null,
    headers: [
      { name: 'Authorization', value: 'Bearer {{ _.sessionToken }}' },
      { name: 'x-client-type', value: 'api-e2e-tests' },
    ],
    metaSortKey: 1000000000000 + folderSort,
  });
  folderSort += 1;

  let reqSort = 0;
  const sortKey = ([path, method]) => `${path} ${method}`;
  [...grouped[tag]]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .forEach(([path, method, op]) => {
      const reqId = makeId('req', `${method}_${path}`);
      const request = {
        _id: reqId,
        _type: 'request',
        parentId: folderId,
        name: opName(method, path, op),
        description: opDescription(op),
        method: method.toUpperCase(),
        url: `{{ _.baseUrl }}${insomniaUrl(path)}`,
        parameters: queryParams(op),
        headers: [],
        authentication: { type: 'none' },
        metaSortKey: 1000000000000 + reqSort,
        isPrivate: false,
      };
      const bodyText = requestBodyText(op);
      if (bodyText !== null) {
        request.body = { mimeType: 'application/json', text: bodyText };
        request.headers.push({ name: 'Content-Type', value: 'application/json' });
      }
      resources.push(request);
      reqSort += 1;
    });
});

const exportData = {
  _type: 'export',
  __export_format: 4,
  __export_date: new Date().toISOString(),
  __export_source: 'spacecat-api-service:generate-insomnia-collection',
  resources,
};

writeFileSync(args.output, `${JSON.stringify(exportData, null, 2)}\n`);

console.log(`Generated ${resources.length} resources -> ${args.output}`);
console.log(`Folders: ${Object.keys(grouped).length + 2}`);
// eslint-disable-next-line no-underscore-dangle -- `_type` is Insomnia's own export field name.
console.log(`Requests: ${resources.filter((r) => r._type === 'request').length}`);
