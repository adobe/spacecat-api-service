/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { Response } from '@adobe/fetch';

export declare function createResponse(body: object, status?: number, headers?: object): Response;

export declare function ok(body?: string, headers?: object): Response;

export declare function created(body: object, headers?: object): Response;

export declare function accepted(body: object, headers?: object): Response;

export declare function noContent(headers?: object): Response;

export declare function badRequest(message?: string, headers?: object): Response;

export declare function notFound(message?: string, headers?: object): Response;

export declare function methodNotAllowed(message?: string, headers?: object): Response;

export declare function internalServerError(message?: string, headers?: object): Response;

export declare function found(location: string): Response;

export declare function unauthorized(message?: string, headers?: object): Response;

export declare function forbidden(message?: string, headers?: object): Response;

/**
 * Utility functions
 */
export function hashWithSHA256(input: string): string;
