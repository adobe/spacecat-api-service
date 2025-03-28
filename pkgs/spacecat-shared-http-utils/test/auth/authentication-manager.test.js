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
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';

import AuthenticationManager from '../../src/auth/authentication-manager.js';
import NotAuthenticatedError from '../../src/auth/errors/not-authenticated.js';
import AbstractHandler from '../../src/auth/handlers/abstract.js';

use(chaiAsPromised);

const createHandler = (
  name,
  shouldAuthenticate,
  shouldThrowError = false,
) => class extends AbstractHandler {
  constructor(log) {
    super(name, log);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
  async checkAuth(request, ctx) {
    if (shouldThrowError) {
      throw new Error('Authentication error');
    }
    return shouldAuthenticate ? { user: 'testUser' } : null;
  }
};

describe('AuthenticationManager', () => {
  let logStub;
  let DummyHandler;

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };

    DummyHandler = createHandler('DummyHandler', true);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('fails to create authentication manager without handler list', () => {
    expect(() => AuthenticationManager.create(null, logStub)).to.throw('Invalid handlers');
    expect(() => AuthenticationManager.create([], logStub)).to.throw('No handlers provided');
  });

  it('handles errors thrown by checkAuth', async () => {
    const ErrorAuthHandler = createHandler('ErrorAuthHandler', false, true);
    const manager = AuthenticationManager.create([ErrorAuthHandler], logStub);
    const request = {};
    const context = {};

    await expect(manager.authenticate(request, context)).to.be.rejectedWith(NotAuthenticatedError);
    expect(logStub.error.calledWith('Failed to authenticate with ErrorAuthHandler:')).to.be.true;
    expect(logStub.info.calledWith('No authentication handler was able to authenticate the request')).to.be.true;
  });

  it('creates an instance with registered handlers', () => {
    const manager = AuthenticationManager.create([DummyHandler], logStub);
    expect(manager).to.be.instanceof(AuthenticationManager);
    expect(manager.handlers).to.have.lengthOf(1);
    expect(manager.handlers[0]).to.be.instanceof(DummyHandler);
  });

  it('authenticates successfully with a valid handler', async () => {
    const PassAuthHandler = createHandler('PassAuthHandler', true);
    const manager = AuthenticationManager.create([PassAuthHandler], logStub);
    const request = {};
    const context = {};

    const authInfo = await manager.authenticate(request, context);

    expect(authInfo).to.deep.equal({ user: 'testUser' });
    expect(context.attributes.authInfo).to.deep.equal({ user: 'testUser' });
    expect(logStub.debug.calledWith('Authenticated with PassAuthHandler')).to.be.true;
  });

  it('fails to authenticate with invalid handlers', async () => {
    const FailAuthHandler = createHandler('FailAuthHandler', false);
    const manager = AuthenticationManager.create([FailAuthHandler], logStub);
    const request = {};
    const context = {};

    await expect(manager.authenticate(request, context)).to.be.rejectedWith(NotAuthenticatedError);
    expect(logStub.info.calledWith('No authentication handler was able to authenticate the request')).to.be.true;
  });

  it('tries all handlers before failing', async () => {
    const FailAuthHandler = createHandler('FailAuthHandler', false);
    const PassAuthHandler = createHandler('PassAuthHandler', true);
    const manager = AuthenticationManager.create([FailAuthHandler, PassAuthHandler], logStub);
    const request = {};
    const context = {};

    const authInfo = await manager.authenticate(request, context);
    expect(authInfo).to.deep.equal({ user: 'testUser' });
    expect(context.attributes.authInfo).to.deep.equal({ user: 'testUser' });
    expect(logStub.debug.calledWith('Failed to authenticate with FailAuthHandler')).to.be.true;
    expect(logStub.debug.calledWith('Authenticated with PassAuthHandler')).to.be.true;
    expect(logStub.debug.callCount).to.equal(5);
  });

  it('uses multiple handlers and authenticate with the first valid one', async () => {
    const Handler1 = createHandler('TestHandler1', true);
    const Handler2 = createHandler('TestHandler2', true);
    const manager = AuthenticationManager.create([Handler1, Handler2], logStub);
    const request = {};
    const context = {};

    const authInfo = await manager.authenticate(request, context);
    expect(authInfo).to.deep.equal({ user: 'testUser' });
    expect(context.attributes.authInfo).to.deep.equal({ user: 'testUser' });
    expect(logStub.debug.calledWith('Authenticated with TestHandler1')).to.be.true;
    expect(logStub.debug.callCount).to.equal(3);
  });
});
