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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { athenaClientWrapper } from '../../src/support/athena.js';

use(chaiAsPromised);

describe('athenaClientWrapper', () => {
  let mockHandler;
  let dummyClient;

  beforeEach(() => {
    dummyClient = { test: 'athena-client' };
    mockHandler = sinon.spy(async (req, ctx) => {
      ctx.called = true;
      return 'ok';
    });
  });

  it('injects athenaClientFactory if not present', async () => {
    const AWSAthenaClientMock = {
      fromContext: sinon.stub().returns(dummyClient),
    };

    const wrapped = athenaClientWrapper(mockHandler, AWSAthenaClientMock);
    const req = { test: 1 };
    const ctx = { foo: 'bar' };
    await wrapped(req, ctx);
    expect(ctx.athenaClientFactory).to.be.a('function');
    ctx.athenaClientFactory('folder');
    expect(mockHandler.calledOnce).to.be.true;
    expect(ctx.called).to.be.true;
  });

  it('does not overwrite existing athenaClientFactory', async () => {
    const existingFactory = sinon.stub().returns('existing');
    const ctx = { athenaClientFactory: existingFactory };
    const AWSAthenaClientMock = {
      fromContext: sinon.stub().returns(dummyClient),
    };
    const wrapped = athenaClientWrapper(mockHandler, AWSAthenaClientMock);
    await wrapped({}, ctx);
    expect(ctx.athenaClientFactory).to.equal(existingFactory);
    expect(mockHandler.calledOnce).to.be.true;
    expect(ctx.called).to.be.true;
  });
});
