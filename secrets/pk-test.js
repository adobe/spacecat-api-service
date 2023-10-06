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
import {
  createLocalJWKSet, importJWK, jwtVerify, SignJWT,
} from 'jose';
import jwks from '../src/support/idp-configs/jwks-json.js';

async function run() {
  if (process.argv.length < 3) {
    console.log('usage: pk-test <admin-idp-priv-xxxx.json>');
    process.exit(1);
  }
  const pk = JSON.parse(await readFile(process.argv[2], 'utf-8'));
  const privateKey = await importJWK(pk, 'RS256');

  const idToken = await new SignJWT({
    email: 'bob',
    name: 'Bob',
    userId: '112233',
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: pk.kid,
    })
    .setIssuedAt()
    .setIssuer('urn:example:issuer')
    .setAudience('dummy-clientid')
    .setExpirationTime('2h')
    .sign(privateKey);

  console.log('created jwt', idToken);

  const localJWKS = createLocalJWKSet(jwks);
  const { payload } = await jwtVerify(idToken, localJWKS, {
    audience: 'dummy-clientid',
  });
  console.log('valid', payload);
}

await run();
