/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { fromJson, isMessage, toJson } from '@bufbuild/protobuf';

/** Default JSON serialization for gRPC Connect message objects (protobuf-es v2). */
export const defaultProtoJsonWrite = Object.freeze({
  enumAsInteger: true,
  useProtoFieldName: false,
});

/**
 * Serialize a protobuf message to a JSON-compatible plain object.
 * @param {import('@bufbuild/protobuf').DescMessage} schema
 * @param {object} message
 * @param {import('@bufbuild/protobuf').JsonWriteOptions} [options]
 * @returns {object}
 */
export function messageToJson(schema, message, options) {
  const merged = { ...defaultProtoJsonWrite, ...options };
  if (isMessage(message)) {
    return /** @type {object} */ (toJson(schema, message, merged));
  }
  const input = message == null ? {} : message;
  try {
    const resolved = fromJson(schema, input, { ignoreUnknownFields: true });
    return /** @type {object} */ (toJson(schema, resolved, merged));
  } catch {
    return /** @type {object} */ (JSON.parse(JSON.stringify(input)));
  }
}
