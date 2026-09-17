/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { createRequire } from 'module';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { Response } from '@adobe/fetch';
import { DevelopmentServer } from '@adobe/helix-universal-devserver';
import { main as apiMain } from '../../src/index.js';

// Load .env file before starting server
config();

// --- Local-dev-only /auth/login mock (never bundled into the Lambda) ---------
// The deployed api-service does NOT serve POST /auth/login — that route lives in
// spacecat-auth-service. The ASO UI's AuthenticationProvider exchanges the IMS
// token for a SpaceCat session token there on boot; when the exchange 404s it
// renders "Service temporarily unavailable" and the app never mounts. Against
// the local harness the UI points at this api-service (one base URL for auth and
// data), so there is nothing to serve /auth/login and every local UI session
// dead-ends. Under SKIP_AUTH (local dev only — the same escape hatch that injects
// a mock admin identity) answer POST /auth/login with a mock session token so the
// UI boots. This wrapper only intercepts that one route; everything else passes
// through to the real handler unchanged. It cannot reach production: test/dev/**
// is excluded from the Helix bundle (main = src/index.js).
const AUTH_LOGIN_PATH = '/auth/login';

// A well-formed but unsigned JWT. jwtDecode in the UI base64url-decodes the
// payload and never verifies the signature; data calls authenticate server-side
// via SKIP_AUTH, so this token is only ever read client-side for role/admin.
// is_admin grants the admin break-glass that bypasses the UI capability guards.
function mockSessionToken() {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    sub: 'dev-local-mock-user',
    is_admin: true,
    facs_enabled: false,
    tenants: [{ id: 'sitesinternal', name: 'Sites Internal', subServices: [] }],
    iat: 1735689600, // 2025-01-01T00:00:00Z, fixed (dev servers avoid Date.now)
    exp: 4102444800, // 2100-01-01T00:00:00Z
  };
  return `${b64url(header)}.${b64url(payload)}.dev-mock-not-a-real-signature`;
}

async function main(request, context) {
  if (
    process.env.SKIP_AUTH === 'true'
    && request.method === 'POST'
    && new URL(request.url).pathname === AUTH_LOGIN_PATH
  ) {
    const origin = request.headers.get('origin') || '*';
    return new Response(JSON.stringify({ sessionToken: mockSessionToken() }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
      },
    });
  }
  return apiMain(request, context);
}

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

// eslint-disable-next-line no-underscore-dangle
global.__rootdir = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

async function run(args) {
  const port = process.env.PORT || '3002';
  process.env.HLX_DEV_SERVER_HOST = `localhost:${port}`;
  process.env.HLX_DEV_SERVER_SCHEME = 'http';
  // eslint-disable-next-line no-console
  console.log(`Starting server at http://localhost:${port}...`);

  let devServer;
  if (args.includes('--webpack')) {
    // eslint-disable-next-line import/no-unresolved
    devServer = await import(`../../dist/spacecat-services/api-service@${version}-bundle.cjs`)
      .then((m) => new DevelopmentServer().withAdapter(m.default.lambda).withPort(port));
  } else if (args.includes('--esbuild')) {
    // eslint-disable-next-line import/no-unresolved
    devServer = await import(`../../dist/spacecat-services/api-service@${version}-bundle.mjs`)
      .then((m) => new DevelopmentServer().withAdapter(m.default.lambda).withPort(port));
  } else {
    devServer = new DevelopmentServer(main);
  }
  await devServer
    .withPort(port)
    .withHeader('x-forwarded-host', '')
    .init();
  await devServer.start();
}

run(process.argv.slice(2)).then(process.stdout).catch(process.stderr);
