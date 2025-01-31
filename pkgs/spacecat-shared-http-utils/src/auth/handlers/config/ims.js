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
export default {
  name: 'ims-na1',
  discoveryUrl: 'https://ims-na1.adobelogin.com/ims/.well-known/openid-configuration',
  discovery: {
    issuer: 'https://ims-na1.adobelogin.com',
    authorization_endpoint: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
    token_endpoint: 'https://ims-na1.adobelogin.com/ims/token/v3',
    userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2',
    revocation_endpoint: 'https://ims-na1.adobelogin.com/ims/revoke',
    jwks_uri: 'https://ims-na1.adobelogin.com/ims/keys',
  },
};
