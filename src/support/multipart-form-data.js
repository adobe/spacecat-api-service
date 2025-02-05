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

import Busboy from 'busboy';
import { isObject } from '@adobe/spacecat-shared-utils';

/**
 * Parses the data from a request with multipart/form-data content type.
 *
 * @param {Request} request - The HTTP request.
 * @param {object} headers - The HTTP request headers.
 * @param {number} fileCountLimit - Limit of files that can be included in the request.
 * @param {number} maxFileSizeMb - Size limit of a single file which can be uploaded, in MB.
 * @returns {Promise<{object}>} The parsed data from the request.
 */
async function getData(request, headers, fileCountLimit, maxFileSizeMb) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers,
      limits: {
        files: fileCountLimit,
        fileSize: maxFileSizeMb * 1024 * 1024, // Convert to bytes
      },
    });
    // The parsed request data, built as the request is processed
    const requestData = {};

    // Handle file uploads
    busboy.on('file', (name, file) => {
      let fileBuffer = Buffer.from('');
      // Handle incoming data
      file.on('data', (data) => {
        // Concatenate each chunk of data into the buffer.
        // Future performance enhancement (should issues arise): keep the _buffer_ in memory
        // and stream the data elsewhere (e.g. to S3) later on.
        fileBuffer = Buffer.concat([fileBuffer, data]);
      }).on('close', () => {
        // Reached the end of the file data
        requestData[name] = fileBuffer.toString('utf8');
      }).on('limit', () => {
        // File exceeded the size limit
        reject(new Error(`File size limit exceeded: ${maxFileSizeMb}MB`));
      });
    });

    // Handle other fields as JSON, falling back to a string on error
    busboy.on('field', (name, val) => {
      let parsedValue;
      try {
        parsedValue = JSON.parse(val);
      } catch (error) {
        // Not valid JSON, treat as string
        parsedValue = val;
      }
      requestData[name] = parsedValue;
    });

    // Handle the end of the request
    busboy.on('close', () => {
      resolve(requestData);
    });

    busboy.on('error', (error) => {
      reject(new Error(`Invalid request: ${error.message}`));
    });

    request.body.pipe(busboy);
  });
}

export function isMultipartFormData(headers) {
  // Check if the content-type header exists and starts with "multipart/form-data"
  const contentType = headers['content-type'] || headers['Content-Type'];
  return contentType && contentType.startsWith('multipart/form-data');
}

/**
 * Wrap a function with multipart/form-data middleware that extracts the request data. Only acts
 * on requests with the multipart/form-data Content-Type.
 *
 * @param {UniversalFunction} func - The universal function.
 * @returns {UniversalFunction} A universal function with the added middleware.
 */
export function multipartFormData(func) {
  return async (request, context) => {
    // Only act on requests which use the multipart/form-data Content-Type
    const { pathInfo: { headers } } = context;
    if (isMultipartFormData(headers) && !isObject(context.multipartFormData)) {
      const {
        MULTIPART_FORM_FILE_COUNT_LIMIT = 5,
        MULTIPART_FORM_MAX_FILE_SIZE_MB = 20, // Defaults to a 20MB max, per file
      } = context.env;
      try {
        // Parse the request body and store it in the context
        context.multipartFormData = await getData(
          request,
          headers,
          MULTIPART_FORM_FILE_COUNT_LIMIT,
          MULTIPART_FORM_MAX_FILE_SIZE_MB,
        );
      } catch (e) {
        const { log = console } = context;
        const message = `Error parsing request body: ${e.message}`;
        log.error(message, e);
        return new Response('', {
          status: 400,
          headers: {
            'x-error': message,
          },
        });
      }
      // Return a new request, following existing pattern of the body-data-wrapper
      return func(new Request(request.url, request.init), context);
    }
    // Otherwise, pass the request on as-is
    return func(request, context);
  };
}
