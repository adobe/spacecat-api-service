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
import { ElementsTransportError } from '../../../src/support/elements/errors.js';

describe('ElementsTransportError', () => {
  it('is an Error subclass', () => {
    const err = new ElementsTransportError(404, 'not found');
    expect(err).to.be.instanceOf(Error);
  });

  it('has name ElementsTransportError', () => {
    const err = new ElementsTransportError(404, 'not found');
    expect(err.name).to.equal('ElementsTransportError');
  });

  it('stores status on the instance', () => {
    const err = new ElementsTransportError(503, 'service unavailable');
    expect(err.status).to.equal(503);
  });

  it('stores message on the instance', () => {
    const err = new ElementsTransportError(403, 'forbidden');
    expect(err.message).to.equal('forbidden');
  });

  it('stores body on the instance when provided', () => {
    const body = { error: 'upstream error detail' };
    const err = new ElementsTransportError(422, 'unprocessable', body);
    expect(err.body).to.deep.equal(body);
  });

  it('leaves body undefined when not provided', () => {
    const err = new ElementsTransportError(401, 'unauthorized');
    expect(err.body).to.be.undefined;
  });

  it('accepts a string body', () => {
    const err = new ElementsTransportError(500, 'internal error', 'raw text response');
    expect(err.body).to.equal('raw text response');
  });
});
