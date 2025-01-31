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

/* eslint-env mocha */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { checkScopes } from '../../src/auth/check-scopes.js';
import AuthInfo from '../../src/auth/auth-info.js';

use(chaiAsPromised);

describe('checkScopes tests', () => {
  let context;
  let mockAuthInfo;
  beforeEach('setup', () => {
    context = {
      log: console,
    };

    mockAuthInfo = new AuthInfo()
      .withProfile({ api_key_id: 'test-api-key' })
      .withScopes([
        { name: 'scope1' },
        { name: 'scope2' },
      ]);
  });

  it('should validate that the 2 scopes are set on authInfo', () => {
    checkScopes(['scope1', 'scope2'], mockAuthInfo, context.log);
  });

  it('should throw an error if there is no authInfo object', () => {
    expect(() => checkScopes(['scope1', 'scope2'], null, context.log)).to.throw('Auth info is required');
  });

  it('should return a false result when a required scope is missing', () => {
    const expectedError = 'API key is missing the [scope3] scope(s) required for this resource';
    expect(() => checkScopes(['scope3', 'scope2'], mockAuthInfo, context.log)).to.throw(expectedError);
  });
});
