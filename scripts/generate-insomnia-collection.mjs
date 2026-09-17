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
 * Generates a whole-API request collection from a bundled, dereferenced OpenAPI spec, in
 * either Insomnia v4 export format or REST Client / IntelliJ HTTP Client `.http` format.
 *
 * Conventions baked in (both formats):
 *   - A base URL pointing at dev (`/api/ci`), plus `imsAccessToken`, `sessionToken`, and
 *     every distinct path-param name found across the whole spec (siteId, organizationId,
 *     opportunityId, etc.) as variables to fill in.
 *   - A `login` request (exchanges an Adobe IMS access token for a session token via
 *     POST /auth/login) kept separate from the rest.
 *   - Everything else grouped by each operation's most specific tag - this spec's
 *     convention is `tags: [genericTag, ..., specificTag]`, e.g. `[site, audit policy]`.
 *
 * Format-specific details:
 *   - Insomnia: an "Auth" folder for `login` (its after-response script stores the
 *     returned `sessionToken` into the active environment) and an "API" container folder
 *     holding one subfolder per resource. Each subfolder - not "API" itself - carries the
 *     inherited `Authorization: Bearer {{ _.sessionToken }}` and `x-client-type` headers:
 *     Insomnia only reliably inherits folder headers from a request's direct parent, not
 *     further up a multi-level ancestor chain.
 *   - `.http`: a LOGIN section followed by one `# ===== TAG =====` section per resource,
 *     each request carrying `Authorization: Bearer {{sessionToken}}` directly (`.http` has
 *     no folder-inheritance concept at all).
 *
 * Usage:
 *   # 1. Bundle the spec into one fully-resolved file (no $ref left) - required first,
 *   #    since both output formats expect everything inlined.
 *   npx @redocly/cli bundle docs/openapi/api.yaml --dereferenced --ext json \
 *     -o tmp/bundled-api.json
 *
 *   # 2. Generate the collection from that bundle.
 *   node scripts/generate-insomnia-collection.mjs                       # Insomnia (default)
 *   node scripts/generate-insomnia-collection.mjs --format http         # .http
 *   node scripts/generate-insomnia-collection.mjs --spec-path /path/to/bundled-api.json \
 *     --output /path/to/output-file
 *
 * Insomnia output: Import -> the generated file. Fill in `imsAccessToken` (and any path
 * params you need) in the active environment, run "Login" once, then run anything else.
 *
 * .http output: open in VS Code (REST Client extension) or IntelliJ/PyCharm's built-in
 * HTTP Client, fill in `@imsAccessToken` (or just paste a session token straight into
 * `@sessionToken` via `mysticat auth token -e dev`), run "Login" once if needed, then run
 * any request.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_OUTPUT_BY_FORMAT = {
  insomnia: 'tmp/spacecat-api-insomnia-export.json',
  http: 'tmp/spacecat-api.http',
};

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'spec-path': { type: 'string', default: 'tmp/bundled-api.json' },
    format: { type: 'string', default: 'insomnia' },
    output: { type: 'string' },
  },
});

if (!['insomnia', 'http'].includes(args.format)) {
  console.error(`Unknown --format "${args.format}" - expected "insomnia" or "http".`);
  process.exit(1);
}
const outputPath = args.output ?? DEFAULT_OUTPUT_BY_FORMAT[args.format];

let spec;
try {
  spec = JSON.parse(readFileSync(args['spec-path'], 'utf-8'));
} catch (err) {
  console.error(`Could not read spec at "${args['spec-path']}": ${err.message}`);
  console.error('Bundle it first: npx @redocly/cli bundle docs/openapi/api.yaml --dereferenced --ext json -o tmp/bundled-api.json');
  process.exit(1);
}
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

function httpUrl(path) {
  return path.replace(/\{([^}]+)\}/g, (_match, name) => `{{${name}}}`);
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

function queryParams(path, op) {
  // Query params can be declared on the shared path item (applies to every method on that
  // path) rather than the operation itself - e.g. audit-policy's `limit`/`cursor`. Merge both,
  // with operation-level entries overriding a path-level one of the same name (OpenAPI's own
  // resolution rule for this).
  const merged = new Map();
  [...(paths[path]?.parameters ?? []), ...(op.parameters ?? [])].forEach((p) => {
    merged.set(`${p.in}:${p.name}`, p);
  });
  return [...merged.values()]
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
// build resources (Insomnia)
// ---------------------------------------------------------------------------
function buildInsomniaResources() {
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
    const sortKey = ([path, method]) => `${path} ${method}`;
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
          parameters: queryParams(path, op),
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

  return resources;
}

function writeInsomniaExport() {
  const resources = buildInsomniaResources();
  const exportData = {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'spacecat-api-service:generate-insomnia-collection',
    resources,
  };

  writeFileSync(outputPath, `${JSON.stringify(exportData, null, 2)}\n`);

  console.log(`Generated ${resources.length} resources -> ${outputPath}`);
  console.log(`Folders: ${Object.keys(grouped).length + 2}`);
  // eslint-disable-next-line no-underscore-dangle -- `_type` is Insomnia's own export field name.
  console.log(`Requests: ${resources.filter((r) => r._type === 'request').length}`);
}

// ---------------------------------------------------------------------------
// build output (.http)
// ---------------------------------------------------------------------------
function httpQueryString(path, op) {
  const required = queryParams(path, op).filter((p) => !p.disabled);
  if (required.length === 0) {
    return '';
  }
  return `?${required.map((p) => `${p.name}=${p.value || `{{${p.name}}}`}`).join('&')}`;
}

function optionalQueryParamsComment(path, op) {
  const optional = queryParams(path, op).filter((p) => p.disabled).map((p) => p.name);
  return optional.length > 0 ? `# optional query params: ${optional.join(', ')}` : null;
}

function buildHttpRequestBlock(path, method, op) {
  const lines = [`### ${opName(method, path, op)}`];
  const comment = optionalQueryParamsComment(path, op);
  if (comment) {
    lines.push(comment);
  }
  lines.push(`${method.toUpperCase()} {{baseUrl}}${httpUrl(path)}${httpQueryString(path, op)}`);
  lines.push('Authorization: Bearer {{sessionToken}}');
  lines.push('x-client-type: api-e2e-tests');
  const bodyText = requestBodyText(op);
  if (bodyText !== null) {
    lines.push('Content-Type: application/json');
    lines.push('');
    lines.push(bodyText);
  }
  return lines.join('\n');
}

function buildHttpFile() {
  const sections = [];

  sections.push([
    '# SpaceCat API - generated from the bundled OpenAPI spec',
    `# ${operations.length - (loginOp ? 1 : 0)} operations across ${Object.keys(grouped).length} resource sections.`,
    '#',
    '# Auth: x-api-key is deprecated for this API starting August 2026. Get a',
    '# ready-to-use session token via the mysticat CLI (no manual login-endpoint',
    '# call needed):',
    '#   mysticat login              # once, if not already logged in',
    '#   mysticat auth token -e dev  # prints a session token - paste it below',
    '# Paste the output into @sessionToken and skip straight past LOGIN. LOGIN',
    '# below calls POST /auth/login directly - only needed to exercise that',
    '# endpoint itself.',
    '#',
    '# Running requests:',
    '# - VS Code (REST Client extension) / IntelliJ / PyCharm: open this file and',
    '#   click the run arrow above any request.',
    '# - Claude Code: ask it to run a specific request from this file.',
    '',
    '@baseUrl = https://spacecat.experiencecloud.live/api/ci',
    '@sessionToken = YOUR_SESSION_TOKEN_HERE',
    '@imsAccessToken = YOUR_IMS_ACCESS_TOKEN_HERE',
    ...allParams.map((p) => `@${p} = YOUR_${p.toUpperCase()}_HERE`),
  ].join('\n'));

  if (loginOp) {
    const [path, method] = loginOp;
    sections.push([
      '# =============================================================================',
      '# LOGIN (optional) - exchanges an IMS access token for a session token',
      '# =============================================================================',
      '',
      '### Login',
      `${method.toUpperCase()} {{baseUrl}}${httpUrl(path)}`,
      'Content-Type: application/json',
      '',
      '{',
      '  "accessToken": "{{imsAccessToken}}"',
      '}',
    ].join('\n'));
  }

  const sortKey = ([path, method]) => `${path} ${method}`;
  Object.keys(grouped).sort().forEach((tag) => {
    const requestBlocks = [...grouped[tag]]
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map(([path, method, op]) => buildHttpRequestBlock(path, method, op));
    sections.push([
      '# =============================================================================',
      `# ${tag.toUpperCase()}`,
      '# =============================================================================',
      '',
      requestBlocks.join('\n\n'),
    ].join('\n'));
  });

  return `${sections.join('\n\n')}\n`;
}

function writeHttpFile() {
  const httpText = buildHttpFile();
  writeFileSync(outputPath, httpText);

  console.log(`Generated ${operations.length} requests across ${Object.keys(grouped).length} sections -> ${outputPath}`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
if (args.format === 'http') {
  writeHttpFile();
} else {
  writeInsomniaExport();
}
