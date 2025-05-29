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

import { hasText, isObject } from '@adobe/spacecat-shared-utils';
import { createResponse } from '@adobe/spacecat-shared-http-utils';

/**
 * Fulfillment controller. Provides a method to handle fulfillment_completed
 * events from the Fulfillment Gateway. Events are queued for processing onto
 * the provided SQS queue URL.
 *
 * @param {UniversalContext} context - The context object.
 * @param {object} context.env - The environment object.
 * @param {object} context.env.FULFILLMENT_EVENTS_QUEUE_URL - URL of the SQS queue to use.
 * @param {object} context.log - The logger.
 * @param {object} context.sqs - The SQS client.
 * @returns {object} Fulfillment controller.
 * @constructor
 */
function FulfillmentController(context) {
  const { log, sqs } = context;
  const {
    FULFILLMENT_EVENTS_QUEUE_URL: queueUrl,
  } = context.env;

  const INVALID_EVENT_ERROR_CODE = 'INVALID_HOOLIHAN_EVENT';
  const ACCEPTED = 'accepted';
  const REJECTED = 'rejected';

  const FULFILLMENT_EVENT_TYPES = {
    EDGE_DELIVERY_SERVICES: 'edge-delivery-services',
    AEM_SITES_OPTIMIZER: 'aem-sites-optimizer',
  };

  async function queueEventsForProcessing(hoolihanEventArray, eventType) {
    if (!Array.isArray(hoolihanEventArray)) {
      const error = new Error('Invalid event envelope, must be an array');
      error.code = INVALID_EVENT_ERROR_CODE;
      throw error;
    }

    // Pull all fulfillment events from the envelope and prepare to be sent to SQS
    const validationStatus = [];
    const fulfillmentEvents = hoolihanEventArray.map((hoolihanEvent) => {
      try {
        if (!isObject(hoolihanEvent) || !hasText(hoolihanEvent.value?.content)) {
          throw new Error('Invalid event, must have a "value" property with a "content" property');
        }

        // Parse the event payload from Base64 to JSON
        const eventContent = Buffer.from(hoolihanEvent.value.content, 'base64').toString('utf-8');
        const fulfillmentEvent = JSON.parse(eventContent);

        // Add fulfillment_event_type to the event
        fulfillmentEvent.fulfillment_event_type = eventType;

        validationStatus.push({
          status: ACCEPTED,
          requestId: fulfillmentEvent.external_request_id || 'no-external-request-id',
        });

        return fulfillmentEvent;
      } catch (error) {
        log.error(`Failed to process hoolihanEventId: ${hoolihanEvent.id || 'no-hoolihan-id'}, Message: ${error.message}`);

        validationStatus.push({
          status: REJECTED,
        });
      }
      return null;
    }).filter((event) => event !== null);

    for (const fulfillmentEvent of fulfillmentEvents) {
      // Failure to send a message to the queue will result in an Error response, meaning the
      // event push will be retried by the publisher (Hoolihan). If we were to return a 2xx
      // response instead and fail to queue the event, then it would be lost.

      // eslint-disable-next-line no-await-in-loop
      await sqs.sendMessage(queueUrl, fulfillmentEvent);
    }

    return validationStatus;
  }

  function countByStatus(results, status) {
    return results.reduce((count, result) => count + (status === result.status ? 1 : 0), 0);
  }

  /**
   * Process an array of fulfillment_completed events, in the format produced by the Fulfillment
   * Gateway and delivered by the Hoolihan pipeline.
   *
   * @param {Object} requestContext - Context of the request.
   * @param {Array<HoolihanEvent>} requestContext.data - Array of Hoolihan events for processing.
   * @returns {Promise<Response|*>} ProcessingStatus[] response, with an entry for each event in
   * the request.
   * @throws {Error} If there is a problem with the SQS queue.
   */
  async function processFulfillmentEvents(requestContext) {
    try {
      const eventType = requestContext.params?.eventType
        || FULFILLMENT_EVENT_TYPES.EDGE_DELIVERY_SERVICES;
      // Validate eventType
      if (!Object.values(FULFILLMENT_EVENT_TYPES).includes(eventType)) {
        log.error(`Invalid event type: ${eventType}`);
        return new Response('', {
          status: 400,
          headers: {
            'x-error': 'Bad Request - Invalid event type',
          },
        });
      }

      const results = await queueEventsForProcessing(requestContext.data, eventType);
      const acceptedCount = countByStatus(results, ACCEPTED);
      const rejectedCount = results.length - acceptedCount;

      log.info(`Fulfillment events processed. Total: ${results.length} (Accepted: ${acceptedCount}, Rejected: ${rejectedCount})`);
      return createResponse(results, 202);
    } catch (error) {
      if (error.code === INVALID_EVENT_ERROR_CODE) {
        log.error(`Bad request, unable to process event. Message: ${error.message}`);
        return new Response('', {
          status: 400,
          headers: {
            'x-error': 'Bad Request',
          },
        });
      }
      // Unknown error code; re-throw
      throw error;
    }
  }

  return {
    processFulfillmentEvents,
  };
}

export default FulfillmentController;
