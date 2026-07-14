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

/**
 * Shared constants used across the application (HTTP status codes, headers, and enums).
 */

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';

export const STATUS_BAD_REQUEST = 400;
export const STATUS_ACCEPTED = 202;
export const STATUS_UNAUTHORIZED = 401;
export const STATUS_FORBIDDEN = 403;
export const STATUS_CREATED = 201;
export const STATUS_NO_CONTENT = 204;
export const STATUS_NOT_FOUND = 404;
export const STATUS_OK = 200;
export const STATUS_INTERNAL_SERVER_ERROR = 500;

export const X_PROMISE_TOKEN_HEADER = 'x-promise-token';

export const MISSING_X_PROMISE_TOKEN_MESSAGE = `Invalid request: missing required header: ${X_PROMISE_TOKEN_HEADER}`;

/** Error code for a non-IMS caller hitting an IMS-bearer gate with no x-promise-token. */
export const PROMISE_TOKEN_REQUIRED_ERROR_CODE = 'promiseTokenRequired';

/** Authoring types that use IMS promise-token auth (CS, CS_CW, AMS). */
export const PROMISE_BASED_AUTHORING_TYPES = [
  SiteModel.AUTHORING_TYPES.CS,
  SiteModel.AUTHORING_TYPES.CS_CW,
  SiteModel.AUTHORING_TYPES.AMS,
];

/**
 * Report types enum
 */
export const REPORT_TYPES = {
  OPTIMIZATION: 'optimization',
  PERFORMANCE: 'performance',
};
