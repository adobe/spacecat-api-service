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

import { google } from 'googleapis';
import crypto from 'crypto';

function AuthenticationController(lambdaContext) {
  const { dataAccess } = lambdaContext;
  const {
    GOOGLE_ENCRYPTION_KEY,
    GOOGLE_ENCRYPTION_IV,
  } = lambdaContext.env;

  const initGoogleAuthentication = async (context) => {
    const siteId = context.params?.siteId;
    const decryptSecret = (encrypted) => {
      const key = Buffer.from(GOOGLE_ENCRYPTION_KEY, 'base64');
      const iv = Buffer.from(GOOGLE_ENCRYPTION_IV, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    };

    const site = await dataAccess.getSiteByID(siteId);
    const config = site.getConfig();
    const authClient = new google.auth.OAuth2(
      config.auth.google.client_id,
      decryptSecret(config.auth.google.client_secret),
      config.auth.google.redirect_uri,
    );
    const scopes = [
      'https://www.googleapis.com/auth/webmasters.readonly',
    ];
    return authClient.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    });
  };

  const authenticateWithGoogle = async (code) => code;

  return {
    initGoogleAuthentication,
    authenticateWithGoogle,
  };
}

export default AuthenticationController;
