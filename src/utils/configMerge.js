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

function mergeJobsArray(targetJobs, sourceJobs) {
  // Create a Map from targetJobs for efficient lookups
  const jobsMap = new Map(targetJobs.map((job) => [`${job.group}-${job.type}`, job]));

  // Iterate over sourceJobs to merge or add
  sourceJobs.forEach((sourceJob) => {
    const jobKey = `${sourceJob.group}-${sourceJob.type}`;
    jobsMap.set(jobKey, sourceJob); // This will overwrite if the key exists, or add if it doesn't
  });

  // Convert the Map values back to an array
  return [...jobsMap.values()];
}

/**
 * Merges two configuration objects together. The source object will overwrite
 * any existing properties in the target object. If a property is an object or
 * array, the merge is recursive. If a property is an array, the merge is
 * based on the array's contents.
 * @param {object} target - The target object
 * @param {object} source - The source object
 * @return {object} The merged object
 */

function configMerge(target, source) {
  const result = JSON.parse(JSON.stringify(target)); // Start with a deep clone of the target

  Object.keys(source).forEach((key) => {
    if (isObject(source[key])) {
      if (!result[key]) result[key] = {};
      result[key] = configMerge(result[key], source[key]); // Use result[key] to accumulate merge
    } else if (Array.isArray(source[key])) {
      if (key === 'jobs') {
        // Special handling for jobs array
        if (!result[key]) result[key] = [];
        result[key] = mergeJobsArray(result[key], source[key]);
      } else {
        // General array merging logic
        result[key] = [...new Set([...(result[key] || []), ...source[key]])];
      }
    } else {
      result[key] = source[key];
    }
  });

  return result; // Return the new merged object
}

export default configMerge;
