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
import { cachedOk } from '../../src/support/cached-response.js';

describe('cachedOk', () => {
  it('sets the default Cache-Control and Vary headers', async () => {
    const response = cachedOk({ hello: 'world' });
    expect(response.status).to.equal(200);
    expect(response.headers.get('Cache-Control')).to.equal('private, max-age=7200');
    expect(response.headers.get('Vary')).to.equal('Authorization');
    const body = await response.json();
    expect(body).to.deep.equal({ hello: 'world' });
  });

  it('lets caller-supplied headers override the defaults', () => {
    const response = cachedOk({ hello: 'world' }, {
      'Cache-Control': 'private, max-age=60',
    });
    expect(response.headers.get('Cache-Control')).to.equal('private, max-age=60');
    // Vary default still applied because it wasn't overridden
    expect(response.headers.get('Vary')).to.equal('Authorization');
  });

  it('accepts arbitrary additional headers', () => {
    const response = cachedOk({ ok: true }, { 'X-Custom-Header': 'foo' });
    expect(response.headers.get('X-Custom-Header')).to.equal('foo');
    expect(response.headers.get('Cache-Control')).to.equal('private, max-age=7200');
  });
});
