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
import { writeFile } from 'fs/promises';
import {
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint, exportSPKI,
} from 'jose';

async function run() {
  const keyPair = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(keyPair.publicKey);
  const privateJwk = await exportJWK(keyPair.privateKey);
  const kid = await calculateJwkThumbprint(privateJwk);
  publicJwk.kid = kid;
  publicJwk.issuer = 'https://admin.hlx.page/';
  privateJwk.kid = kid;
  const date = new Date().toISOString().split(/[T:.-]/).slice(0, 6)
    .join('');
  const publicPem = Buffer.from(await exportSPKI(keyPair.publicKey), 'utf-8').toString('base64url');
  const priName = `admin-idp-prv-${date}.json`;
  const pubName = `admin-idp-pub-${date}.json`;
  const pemName = `admin-idp-pub-${date}.pem`;

  await writeFile(priName, JSON.stringify(privateJwk), 'utf-8');
  await writeFile(pubName, JSON.stringify(publicJwk), 'utf-8');
  await writeFile(pemName, publicPem, 'utf-8');
  console.log(' public jwk saved as:', pubName);
  console.log(' public pem saved as:', pemName);
  console.log('private jwk saved as:', priName);
}

await run();
