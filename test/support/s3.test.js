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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { s3ClientWrapper } from '../../src/support/s3.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('S3 client wrapper tests', () => {
  let mockRequest;
  let mockContext;
  let exampleHandler;

  beforeEach(() => {
    mockRequest = {};
    mockContext = {
      log: console,
      runtime: {
        region: 'us-east-1',
      },
    };

    exampleHandler = sinon.spy(async (message, context) => {
      const { log } = context;
      const messageStr = JSON.stringify(message);
      log.info(`Handling message ${messageStr}`);
      return new Response(messageStr);
    });
  });

  it('should add an S3Client to the context', async () => {
    expect(mockContext.s3Client).to.be.undefined;

    await s3ClientWrapper(exampleHandler)(mockRequest, mockContext);

    // s3Client should now be included in the context
    expect(exampleHandler.calledOnce).to.be.true;
    expect(exampleHandler.calledWith(mockRequest, sinon.match.has('s3Client'))).to.be.true;
  });

  it('does not create a new S3Client if one already exists in the context', async () => {
    mockContext.s3Client = {
      test: 'mocked-client',
    };

    await s3ClientWrapper(exampleHandler)(mockRequest, mockContext);

    // The s3Client provided in the context should not have been overwritten
    expect(exampleHandler.calledOnce).to.be.true;
    const callArgs = exampleHandler.getCall(0).args[1];
    expect(callArgs.s3Client.test).to.equal('mocked-client');
  });
});
