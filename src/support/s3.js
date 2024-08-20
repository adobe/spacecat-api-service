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

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Wrapper function to enable access to S3 capabilities via the context.
 * When wrapped with this function, the client is available as context.s3.s3Client
 *
 * @param {UniversalAction} fn
 * @returns {function(object, UniversalContext): Promise<Response>}
 */
export function s3ClientWrapper(fn) {
  return async (request, context) => {
    if (!context.s3) {
      // Create an S3 client and add it to the context
      const { region } = context.runtime;
      const {
        S3_BUCKET_NAME: bucket,
      } = context.env;

      context.s3 = {
        s3Client: new S3Client({ region }),
        s3Bucket: bucket,
        getSignedUrl,
        GetObjectCommand,
        PutObjectCommand,
      };
    }
    return fn(request, context);
  };
}
