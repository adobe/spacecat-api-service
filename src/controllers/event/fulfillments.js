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

import { isObject } from '@adobe/spacecat-shared-utils';
import { createResponse } from '@adobe/spacecat-shared-http-utils';

function queueEventsForProcessing(hoolihanEventArray) { // TODO: pass sqs as a param
  if (!Array.isArray(hoolihanEventArray)) {
    throw new Error('Invalid event envelope: must be an array');
  }

  // Note the processing status of each fulfillment event included in the Hoolihan event
  const processingStatus = [];

  for (const hoolihanEvent of hoolihanEventArray) {
    try {
      if (!isObject(hoolihanEvent) || hoolihanEvent.value?.content == null) {
        throw new Error('Invalid event envelope: must have a "value" property with a "content" property');
      }

      // Parse event.value.content from Base64 to JSON
      const eventContent = Buffer.from(hoolihanEvent.value.content, 'base64').toString('utf-8');
      const fulfillmentEvent = JSON.parse(eventContent);

      // TODO: queue event via SQS
      // sqs.sendMessage(queueUrl, fulfillmentEvent)

      processingStatus.push({
        status: 'accepted',
        requestId: fulfillmentEvent.external_request_id
          || 'no-external-request-id', // TODO, alternatively, use an ID from sqs?
      });
    } catch (error) {
      // Include a "rejected" entry for invalid events
      processingStatus.push({
        status: 'rejected',
      });
    }
  }

  return processingStatus;
}

/**
 * Fulfillment controller. Provides methods to handle fulfillment_completed
 * events from the Fulfillment Gateway.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Fulfillment controller.
 * @constructor
 */
function FulfillmentController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  async function processFulfillmentEvents(context) {
    const { log = console } = context;

    try {
      const processingResults = queueEventsForProcessing(context.data);

      // TODO: anything else that we would like to see in the logs here? processingResults?
      log.info(`Fulfillment events processed: ${processingResults.length}`);
      return createResponse(processingResults, 202);
    } catch (error) {
      log.error(`Bad request, unable to process event: ${error.message}`);
      return new Response('', {
        status: error.statusCode || 400,
        headers: {
          'x-error': 'Bad Request',
        },
      });
    }
  }

  return {
    processFulfillmentEvents,
  };
}

export default FulfillmentController;
