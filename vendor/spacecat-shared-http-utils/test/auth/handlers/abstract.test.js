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

// eslint-disable-next-line max-classes-per-file
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import AbstractHandler from '../../../src/auth/handlers/abstract.js';

use(chaiAsPromised);

describe('AbstractHandler', () => {
  let logStub;

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };
  });

  class ConcreteHandler extends AbstractHandler {
    constructor(log) {
      super('ConcreteHandler', log);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
    async checkAuth(request, context) {
      return { user: 'testUser' };
    }
  }

  it('throws an error if instantiated directly', () => {
    expect(() => new AbstractHandler('TestHandler', logStub)).to.throw(TypeError, 'Cannot construct AbstractHandler instances directly');
  });

  it('sets the name and log properties correctly', () => {
    const handler = new ConcreteHandler(logStub);
    expect(handler.name).to.equal('ConcreteHandler');
    expect(handler.logger).to.equal(logStub);
  });

  it('logs messages correctly', () => {
    const handler = new ConcreteHandler(logStub);
    handler.log('test message', 'info');
    expect(logStub.info.calledWith('[ConcreteHandler] test message')).to.be.true;
  });

  it('throws an error if checkAuth is not implemented', async () => {
    class IncompleteHandler extends AbstractHandler {
      constructor(log) {
        super('IncompleteHandler', log);
      }
    }

    const handler = new IncompleteHandler(logStub);
    await expect(handler.checkAuth()).to.be.rejectedWith(Error, 'checkAuth method must be implemented');
  });

  it('returns auth info if checkAuth is implemented correctly', async () => {
    const handler = new ConcreteHandler(logStub);
    const authInfo = await handler.checkAuth({}, {});
    expect(authInfo).to.deep.equal({ user: 'testUser' });
  });
});
