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
import chaiAsPromised from 'chai-as-promised';

import AdobeImsHandler from '../../../../src/support/auth/handlers/ims.js';
import AbstractHandler from '../../../../src/support/auth/handlers/abstract.js';

chai.use(chaiAsPromised);

const { expect } = chai;

describe('AdobeImsHandler', () => {
  let logStub;
  let handler;

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };
    handler = new AdobeImsHandler(logStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('is an instance of AbstractHandler', () => {
    expect(handler).to.be.instanceof(AbstractHandler);
  });

  it('sets the name and logger properties correctly', () => {
    expect(handler.name).to.equal('ims');
    expect(handler.logger).to.equal(logStub);
  });

  it('logs messages correctly', () => {
    handler.log('test message', 'info');
    expect(logStub.info.calledWith('[ims] test message')).to.be.true;
  });

  it('returns null when checkAuth is called (not implemented)', async () => {
    const request = {};
    const context = {};
    const result = await handler.checkAuth(request, context);
    expect(result).to.be.null;
  });
});
