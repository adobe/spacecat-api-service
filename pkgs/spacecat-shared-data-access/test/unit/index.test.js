/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { expect } from 'chai';
import sinon from 'sinon';
import dataAccessWrapper from '../../src/index.js';

describe('Data Access Wrapper Tests', () => {
  let mockFn;
  let mockContext;
  let mockRequest;

  beforeEach(() => {
    mockFn = sinon.stub().resolves('function response');
    mockContext = {
      attributes: { authInfo: {} },
      env: {},
      log: {
        info: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy(),
      },
    };
    mockRequest = {};
  });

  afterEach(() => {
    sinon.restore();
  });

  it('adds dataAccess to context and calls the wrapped function', async () => {
    const wrappedFn = dataAccessWrapper(mockFn);

    const response = await wrappedFn(mockRequest, mockContext);

    expect(mockFn.calledOnceWithExactly(mockRequest, mockContext)).to.be.true;
    expect(response).to.equal('function response');
  });

  it('does not recreate dataAccess if already present in context', async () => {
    mockContext.dataAccess = { existingDataAccess: true };
    const wrappedFn = dataAccessWrapper(mockFn);

    await wrappedFn(mockRequest, mockContext);

    expect(mockContext.dataAccess).to.deep.equal({ existingDataAccess: true });
  });
});
