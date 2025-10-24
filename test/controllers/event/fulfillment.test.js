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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import FulfillmentController from '../../../src/controllers/event/fulfillment.js';

use(chaiAsPromised);

describe('Fulfillment Controller', () => {
  const sandbox = sinon.createSandbox();

  const fulfillmentFunctions = [
    'processFulfillmentEvents',
  ];

  let fulfillmentController;
  let baseContext;

  beforeEach(() => {
    baseContext = {
      log: console,
      sqs: {
        sendMessage: sandbox.stub().resolves(),
      },
      env: {},
    };

    fulfillmentController = FulfillmentController(baseContext);
  });

  afterEach(() => {
    sandbox.restore();
  });

  const thisDirectory = dirname(fileURLToPath(import.meta.url));
  function localFileToObject(fileName) {
    return JSON.parse(fs.readFileSync(path.join(thisDirectory, fileName), 'utf8'));
  }

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
    const emptyObj = {};
    let response = await fulfillmentController.processFulfillmentEvents(emptyObj);
    expect(response.status).to.equal(400);
    expect(response.headers.get('x-error')).to.equal('Bad Request');

    // Missing payload
    let eventArray = localFileToObject('sample-hoolihan-event-missing-props.json');
    response = await fulfillmentController.processFulfillmentEvents({ data: eventArray });
    expect(response.status).to.equal(202);
    let results = await response.json();
    expect(results[0].status).to.equal('rejected');

    // Bad payload
    eventArray = localFileToObject('sample-hoolihan-event-bad-payload.json');
    response = await fulfillmentController.processFulfillmentEvents({ data: eventArray });
    expect(response.status).to.equal(202);
    results = await response.json();
    expect(results[0].status).to.equal('rejected');

    // No external-request-id
    eventArray = localFileToObject('sample-hoolihan-event-no-external-id.json');
    response = await fulfillmentController.processFulfillmentEvents({ data: eventArray });
    expect(response.status).to.equal(202);
    results = await response.json();
    expect(results[0].status).to.equal('accepted');
  });

  it('can process a valid Hoolihan event with a single fulfillment', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({ data: eventArray });

    expect(response.status).to.equal(202);
    const results = await response.json();
    expect(results).to.have.length(1);
    expect(results[0].status).to.equal('accepted');
    expect(results[0].requestId).to.equal('12345');
  });

  it('can process multiple valid Hoolihan events, with a single invalid one mixed in', async () => {
    const validEvent = localFileToObject('sample-hoolihan-event.json')[0];
    const multipleEvents = [
      { ...validEvent },
      { id: 'not-a-valid-event' },
      { ...validEvent },
      { ...validEvent },
    ];
    const response = await fulfillmentController.processFulfillmentEvents({ data: multipleEvents });
    expect(response.status).to.equal(202);

    const results = await response.json();
    expect(results).to.have.length(4);
    expect(results[0].status).to.equal('accepted');
    expect(results[1].status).to.equal('rejected'); // Rejected because it's not a valid event
    expect(results[2].status).to.equal('accepted');
    expect(results[3].status).to.equal('accepted');
    expect(results[3].requestId).to.equal('12345');
  });

  it('uses default event type when not specified', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({ data: eventArray });
    expect(response.status).to.equal(202);
    const results = await response.json();
    expect(results[0].status).to.equal('accepted');
  });

  it('accepts valid event types (aem-sites-optimizer)', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({
      data: eventArray,
      params: { eventType: 'aem-sites-optimizer' },
    });
    expect(response.status).to.equal(202);
    const results = await response.json();
    expect(results[0].status).to.equal('accepted');
  });

  it('accepts valid event types (edge-delivery-services)', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({
      data: eventArray,
      params: { eventType: 'edge-delivery-services' },
    });
    expect(response.status).to.equal(202);
    const results = await response.json();
    expect(results[0].status).to.equal('accepted');
  });

  it('accepts valid event types (llmo-optimizer)', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({
      data: eventArray,
      params: { eventType: 'llmo-optimizer' },
    });
    expect(response.status).to.equal(202);
    const results = await response.json();
    expect(results[0].status).to.equal('accepted');
  });

  it('rejects invalid event types', async () => {
    const eventArray = localFileToObject('sample-hoolihan-event.json');
    const response = await fulfillmentController.processFulfillmentEvents({
      data: eventArray,
      params: { eventType: 'invalid-event-type' },
    });
    expect(response.status).to.equal(400);
    expect(response.headers.get('x-error')).to.equal('Bad Request - Invalid event type');
  });

  it('rejects when SQS fails', async () => {
    const failingSqs = {
      sendMessage: sandbox.stub().rejects(new Error('Error queueing message')),
    };
    const contextWithBadSqs = {
      ...baseContext,
      sqs: failingSqs,
    };
    const eventArray = localFileToObject('sample-hoolihan-event.json');

    const controllerBadSqs = FulfillmentController(contextWithBadSqs);
    await expect(controllerBadSqs.processFulfillmentEvents({ data: eventArray })).to.be.rejectedWith('Error queueing message');
  });
});
