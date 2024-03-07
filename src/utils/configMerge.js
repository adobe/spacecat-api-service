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

function isDuplicateJob(job1, job2) {
  return job1.group === job2.group && job1.type === job2.type;
}

function mergeJobsArray(targetJobs, sourceJobs) {
  const mergedJobs = [...targetJobs];

  sourceJobs.forEach((sourceJob) => {
    const duplicateIndex = mergedJobs.findIndex(
      (targetJob) => isDuplicateJob(targetJob, sourceJob),
    );
    if (duplicateIndex > -1) {
      // If duplicate based on 'group' and 'type', replace the existing job
      // to update 'interval' or other fields
      mergedJobs[duplicateIndex] = sourceJob;
    } else {
      // If not a duplicate, add the job to the merged array
      mergedJobs.push(sourceJob);
    }
  });

  return mergedJobs;
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

/* eslint-disable no-param-reassign */
function configMerge(target, source) {
  Object.keys(source).forEach((key) => {
    if (isObject(source[key])) {
      if (!target[key]) target[key] = {};
      configMerge(target[key], source[key]);
    } else if (Array.isArray(source[key]) && key === 'jobs') {
      // Special handling for jobs array
      if (!target[key]) target[key] = [];
      target[key] = mergeJobsArray(target[key], source[key]);
    } else if (Array.isArray(source[key])) {
      // General array merging logic (could be adapted for unique items
      // or concatenation based on requirements)
      target[key] = [...new Set([...(target[key] || []), ...source[key]])];
    } else {
      target[key] = source[key];
    }
  });
  return target;
}

export default configMerge;
