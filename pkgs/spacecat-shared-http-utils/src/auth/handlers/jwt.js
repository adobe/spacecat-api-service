/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { hasText } from '@adobe/spacecat-shared-utils';
import { importSPKI, jwtVerify } from 'jose';

import AbstractHandler from './abstract.js';
import AuthInfo from '../auth-info.js';
import { getBearerToken } from './utils/bearer.js';

const ALGORITHM_ES256 = 'ES256';
export const ISSUER = 'https://spacecat.experiencecloud.live';

export default class JwtHandler extends AbstractHandler {
  constructor(log) {
    super('jwt', log);
  }

  async #setup(context) {
    const authPublicKey = context.env?.AUTH_PUBLIC_KEY;

    if (!hasText(authPublicKey)) {
      throw new Error('No public key provided');
    }

    this.authPublicKey = await importSPKI(authPublicKey, ALGORITHM_ES256);
  }

  async #validateToken(token) {
    const verifiedToken = await jwtVerify(
      token,
      this.authPublicKey,
      {
        algorithms: [ALGORITHM_ES256], // force expected algorithm
        clockTolerance: 5, // number of seconds to tolerate when checking the nbf and exp claims
        complete: false, // only return the payload and not headers etc.
        ignoreExpiration: false, // validate expiration
        issuer: ISSUER, // validate issuer
      },
    );

    return verifiedToken.payload;
  }

  async checkAuth(request, context) {
    const authInfo = new AuthInfo()
      .withType(this.name)
      .withAuthenticated(false);

    try {
      await this.#setup(context);

      const token = getBearerToken(context);

      if (!hasText(token)) {
        this.log('No bearer token provided', 'debug');
        authInfo.withReason('No bearer token provided');
        return authInfo;
      }

      const payload = await this.#validateToken(token);

      return new AuthInfo()
        .withType(this.name)
        .withAuthenticated(true)
        .withProfile(payload);
    } catch (e) {
      this.log(`Failed to validate token: ${e.message}`, 'error');
      authInfo.withReason(e.message);
    }

    return authInfo;
  }
}
