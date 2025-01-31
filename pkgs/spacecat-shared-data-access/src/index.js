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

import { createDataAccess } from './service/index.js';

export * from './service/index.js';

const TABLE_NAME_DATA = 'spacecat-services-data-dev';

/**
 * Wrapper for data access layer
 * @param {function} fn - The function to wrap
 * @returns {function} - The wrapped function
 */
export default function dataAccessWrapper(fn /* , opts = {} */) {
  /**
   * Wrapper for data access layer. This wrapper will create a data access layer if it is not
   * already created. It requires the context to have a log object. It will also use the
   * DYNAMO_TABLE_NAME_DATA environment variable to create the data access layer.
   *
   * @param {object} request - The request object
   * @param {object} context - The context object
   * @returns {Promise<object>} - The wrapped function
   */
  return async (request, context) => {
    if (!context.dataAccess) {
      const { log } = context;

      const {
        DYNAMO_TABLE_NAME_DATA = TABLE_NAME_DATA,
      } = context.env;

      console.log('§§§ Calling createDataAccess with tableNameData:', DYNAMO_TABLE_NAME_DATA);
      console.log('§§§ Calling createDataAccess with context.attributes.authInfo', context.attributes.authInfo);
      context.dataAccess = createDataAccess({
        tableNameData: DYNAMO_TABLE_NAME_DATA,
        aclCtx: context.attributes.authInfo,
        // aclCtx, e.g. from context.attributes.authInfo
      }, log);
    }

    return fn(request, context);
  };
}
