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

import { expect } from 'chai';
import sinon from 'sinon';

import { imsClientWrapper } from '../../src/clients/ims-client-wrapper.js';

describe('IMS Client Wrapper', () => {
  it('should add an IMS Client to the context', async () => {
    const exampleContext = {
      log: console,
      env: {
        IMS_HOST: 'ims.example.com',
        IMS_CLIENT_ID: 'mock-client-id',
        IMS_CLIENT_CODE: 'mock-client-code',
        IMS_CLIENT_SECRET: 'mock-secret',
      },
    };
    const exampleHandler = sinon.spy(async (message, context) => {
      const { log: logger } = context;
      const messageStr = JSON.stringify(message);
      logger.info(`Handling message ${messageStr}`);
      return new Response(messageStr);
    });

    const handler = imsClientWrapper(exampleHandler);
    await handler({}, exampleContext);

    expect(exampleHandler.calledOnce).to.be.true;
    // imsClient should be included in the context
    expect(exampleHandler.calledWith(sinon.match.any, sinon.match.has('imsClient'))).to.be.true;
  });
});
