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
/* eslint-disable no-console */
import { readFile } from 'fs/promises';
import crypto from 'crypto';
import {
  importJWK, SignJWT,
} from 'jose';
import localJWKS from '../src/support/idp-configs/jwks-json.js';

async function run() {
  if (process.argv.length < 3) {
    console.log('usage: jwt <owner/repo> [roles|scopes...]');
    process.exit(1);
  }
  const secrets = JSON.parse(await readFile('secrets/secrets.json', 'utf-8'));
  const privateKey = await importJWK(JSON.parse(secrets.HLX_ADMIN_IDP_PRIVATE_KEY), 'RS256');
  const publicKey = localJWKS.keys[0];
  const jti = crypto.randomBytes(33).toString('base64');

  let roles;
  let scopes;
  for (const roleOrScope of process.argv.slice(3)) {
    if (roleOrScope.indexOf(':') > 0) {
      if (!scopes) {
        scopes = [];
      }
      scopes.push(roleOrScope);
    } else {
      if (!roles) {
        roles = [];
      }
      roles.push(roleOrScope);
    }
  }
  const idToken = await new SignJWT({
    email: 'helix@adobe.com',
    name: 'Helix Admin',
    roles,
    scopes,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: publicKey.kid,
    })
    .setIssuedAt()
    .setIssuer(publicKey.issuer)
    .setAudience(secrets.HLX_SITE_APP_AZURE_CLIENT_ID)
    .setSubject(process.argv[2])
    .setExpirationTime('365 days')
    .setJti(jti)
    .sign(privateKey);

  process.stdout.write(`export API_KEY_ID=${jti}\n`);
  process.stdout.write(`export API_KEY=${idToken}\n`);
}

await run();
