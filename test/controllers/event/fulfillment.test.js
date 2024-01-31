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
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import FulfillmentController from '../../../src/controllers/event/fulfillments.js';

chai.use(chaiAsPromised);

const { expect } = chai;

describe('Fulfillment Controller', () => {
  const sandbox = sinon.createSandbox();

  const fulfillmentFunctions = [
    'processFulfillmentEvents',
  ];

  const thisDirectory = dirname(fileURLToPath(import.meta.url));

  let mockDataAccess;
  let fulfillmentController;

  beforeEach(() => {
    mockDataAccess = {
      // addOrganization: sandbox.stub().resolves(organizations[0]),
    };

    fulfillmentController = FulfillmentController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    fulfillmentFunctions.forEach((funcName) => {
      expect(fulfillmentController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(fulfillmentController).forEach((funcName) => {
      expect(fulfillmentFunctions).to.include(funcName);
    });
  });

  it('can handle poorly crafted/malicious Hoolihan events', async () => {
    const context = {};
    const response = await fulfillmentController.processFulfillmentEvents(context);
    expect(response.status).to.equal(400);
  });

  it('can process a valid Hoolihan event with a single fulfillment', async () => {
    const data = JSON.parse(fs.readFileSync(path.join(thisDirectory, 'sample-hoolihan-event.json')));
    const context = { data };
    const response = await fulfillmentController.processFulfillmentEvents(context);

    expect(response.status).to.equal(202);
    // TODO: add assertions for the body
  });
});
