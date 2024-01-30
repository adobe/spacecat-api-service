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

/**
 * Fulfillment controller. Provides methods to handle fulfillment_completed
 * events from the Fulfillment Gateway.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Fulfillment controller.
 * @constructor
 */
function FulfillmentsController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  async function processFulfillmentEvents(context) {
    const { log } = context;
    log.info('TODO: handle fulfillment events');
  }

  return {
    processFulfillmentEvents,
  };
}

export default FulfillmentsController;
