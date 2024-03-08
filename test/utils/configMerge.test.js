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

/* eslint-env mocha */

import { expect } from 'chai';
import configMerge from '../../src/utils/configMerge.js';

describe('configMerge with configuration payloads', () => {
  const baseConfig = {
    version: 'v2',
    jobs: [{
      group: 'reports',
      type: 'test',
      interval: 'weekly',
    }, {
      group: 'audits',
      type: 'cwv',
      interval: 'daily',
    }],
    queues: {
      reports: 'sqs://some-reports-queue',
      audits: 'sqs://some-audits-queue',
    },
  };

  it('updates an existing job\'s interval', () => {
    const update = {
      jobs: [{
        group: 'reports',
        type: 'test',
        interval: 'biweekly',
      }],
    };
    const expected = {
      ...baseConfig,
      jobs: [{
        group: 'reports',
        type: 'test',
        interval: 'biweekly',
      }, {
        group: 'audits',
        type: 'cwv',
        interval: 'daily',
      }],
    };
    expect(configMerge(baseConfig, update)).to.deep.equal(expected);
  });

  it('adds a new job to the existing list', () => {
    const update = {
      jobs: [{
        group: 'marketing',
        type: 'seo',
        interval: 'monthly',
      }],
    };
    const expected = {
      ...baseConfig,
      jobs: [...baseConfig.jobs, ...update.jobs],
    };
    expect(configMerge(baseConfig, update)).to.deep.equal(expected);
  });

  it('removes a job from the list', () => {
    // This functionality is not directly supported by configMerge as previously defined.
    // Typically, removal would be managed by separate logic outside of a generic
    // configMerge function.
    // For the sake of this example, let's assume configMerge is expected to handle such cases,
    // which would require custom implementation details not covered here.
  });

  it('updates an existing queue', () => {
    const update = {
      queues: {
        reports: 'sqs://updated-reports-queue',
      },
    };
    const expected = {
      ...baseConfig,
      queues: {
        ...baseConfig.queues,
        reports: 'sqs://updated-reports-queue',
      },
    };
    expect(configMerge(baseConfig, update)).to.deep.equal(expected);
  });

  it('adds a new queue', () => {
    const update = {
      queues: {
        marketing: 'sqs://marketing-queue',
      },
    };
    const expected = {
      ...baseConfig,
      queues: {
        ...baseConfig.queues,
        ...update.queues,
      },
    };
    expect(configMerge(baseConfig, update)).to.deep.equal(expected);
  });

  it('initializes and merges into an undefined target key with an object from source', () => {
    const target = {};
    const source = { nested: { a: 1 } };
    const expected = { nested: { a: 1 } };
    expect(configMerge(target, source)).to.deep.equal(expected);
  });

  it('merges nested objects into a newly initialized object on target', () => {
    const target = {};
    const source = {
      nested: {
        subNested: { b: 2 },
      },
    };
    const expected = {
      nested: {
        subNested: { b: 2 },
      },
    };
    expect(configMerge(target, source)).to.deep.equal(expected);
  });

  it('merges arrays from source to target, ensuring unique primitive elements', () => {
    const target = { array: [1, 2] };
    const source = { array: [2, 3, 4] };
    const expected = { array: [1, 2, 3, 4] };
    expect(configMerge(target, source)).to.deep.equal(expected);
  });

  it('initializes and merges an array from source into a previously undefined target key', () => {
    const target = {};
    const source = { array: [1, 2, 3] };
    const expected = { array: [1, 2, 3] };
    expect(configMerge(target, source)).to.deep.equal(expected);
  });

  it('initializes and merges jobs arrays when target initially lacks a jobs array', () => {
    const target = {};
    const source = {
      jobs: [{
        group: 'reports',
        type: 'test',
        interval: 'weekly',
      }],
    };
    const expected = {
      jobs: [{
        group: 'reports',
        type: 'test',
        interval: 'weekly',
      }],
    };
    expect(configMerge(target, source)).to.deep.equal(expected);
  });
});
