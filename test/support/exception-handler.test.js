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
import chai from 'chai';
import sinon from 'sinon';
import { Response } from '@adobe/fetch';
// import { ClientError } from '@adobe/spacecat-shared-utils';
import exceptionHandler from '../../src/support/exception-handler.js';

const { expect } = chai;

describe('exceptionHandler', () => {
  it('should return the result of the function when no error is thrown', async () => {
    const fn = sinon.stub().resolves('success');
    const handler = exceptionHandler(fn);

    const result = await handler();

    expect(result).to.equal('success');
  });

  it.skip('should return a 400 response when a ClientError is thrown', async () => {
    // eslint-disable-next-line no-undef
    const error = new ClientError('Client error');
    const fn = sinon.stub().throws(error);
    const handler = exceptionHandler(fn);

    const result = await handler();

    expect(result).to.be.instanceOf(Response);
    expect(result.status).to.equal(400);
    expect(result.body).to.equal('Client error');
  });

  it.skip('should return a 500 response when a non-ClientError is thrown', async () => {
    const error = new Error('Server error');
    const fn = sinon.stub().throws(error);
    const handler = exceptionHandler(fn);

    const result = await handler();

    expect(result).to.be.instanceOf(Response);
    expect(result.status).to.equal(500);
    expect(result.body).to.equal('Server error');
  });
});
