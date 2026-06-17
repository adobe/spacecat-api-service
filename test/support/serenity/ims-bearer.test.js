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

import { expect } from 'chai';

import { extractImsBearer } from '../../../src/support/serenity/ims-bearer.js';

function ctx({ type, authorization } = {}) {
  return {
    attributes: {
      authInfo: type === undefined ? undefined : { getType: () => type },
    },
    pathInfo: { headers: { authorization } },
  };
}

describe('extractImsBearer', () => {
  it('returns the token for an IMS caller with a Bearer header', () => {
    expect(extractImsBearer(ctx({ type: 'ims', authorization: 'Bearer abc.def.ghi' })))
      .to.equal('abc.def.ghi');
  });

  it('returns null when there is no auth info', () => {
    expect(extractImsBearer(ctx({ type: undefined, authorization: 'Bearer abc' }))).to.equal(null);
  });

  it('returns null for a non-IMS auth type', () => {
    expect(extractImsBearer(ctx({ type: 'jwt', authorization: 'Bearer abc' }))).to.equal(null);
  });

  it('returns null when the Authorization header is missing', () => {
    expect(extractImsBearer(ctx({ type: 'ims', authorization: undefined }))).to.equal(null);
  });

  it('returns null when the header is not a Bearer scheme', () => {
    expect(extractImsBearer(ctx({ type: 'ims', authorization: 'Basic abc' }))).to.equal(null);
  });

  it('returns null when the Bearer token is empty', () => {
    expect(extractImsBearer(ctx({ type: 'ims', authorization: 'Bearer ' }))).to.equal(null);
  });

  it('returns null for a null/undefined context', () => {
    expect(extractImsBearer(undefined)).to.equal(null);
    expect(extractImsBearer(null)).to.equal(null);
    expect(extractImsBearer({})).to.equal(null);
  });

  it('returns null when authInfo has no getType', () => {
    const context = { attributes: { authInfo: {} }, pathInfo: { headers: { authorization: 'Bearer x' } } };
    expect(extractImsBearer(context)).to.equal(null);
  });
});
