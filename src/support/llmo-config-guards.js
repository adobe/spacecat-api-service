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

// llmo config fields only privileged callers may write.
export const PROVISIONING_OWNED_LLMO_FIELDS = ['cdnlogsFilter', 'cdnBucketConfig'];

/**
 * For non-privileged callers, restores the fields in PROVISIONING_OWNED_LLMO_FIELDS to their
 * stored values (or removes them when none was stored). Privileged callers get the object
 * unchanged. Input is not mutated.
 *
 * @param {object|undefined} incomingLlmo  llmo object from the request
 * @param {object|undefined} existingLlmo  llmo object already stored
 * @param {boolean} privileged             whether the caller may write these fields
 * @returns {object|undefined}             sanitized llmo object
 */
export function guardProvisioningLlmoFields(incomingLlmo, existingLlmo, privileged) {
  if (!incomingLlmo || privileged) {
    return incomingLlmo;
  }

  let sanitized = incomingLlmo;
  for (const field of PROVISIONING_OWNED_LLMO_FIELDS) {
    if (field in sanitized) {
      // Copy lazily, only when we actually need to change something.
      if (sanitized === incomingLlmo) {
        sanitized = { ...incomingLlmo };
      }
      const stored = existingLlmo?.[field];
      if (stored === undefined) {
        delete sanitized[field];
      } else {
        sanitized[field] = stored;
      }
    }
  }
  return sanitized;
}
