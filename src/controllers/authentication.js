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

function AuthenticationController(context) {
  const { dataAccess } = context;
  const {
    GOOGLE_ENCRYPTION_KEY,
    GOOGLE_ENCRYPTION_IV,
  } = context.env;

  const siteId = context.params?.siteId;

  const initGoogleAuthentication = () => {
    const decryptSecret = (encrypted) => {
      const decipher = crypto.createDecipheriv('aes-256-cbc', GOOGLE_ENCRYPTION_KEY, GOOGLE_ENCRYPTION_IV);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    };

    const config = dataAccess.getSiteByID(siteId).getConfig();
    const authClient = new google.auth.OAuth2(
      config.auth.google.client_id,
      decryptSecret(config.auth.google.client_secret),
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
