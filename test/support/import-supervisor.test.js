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
import chai from 'chai';
import ImportSupervisor from '../../src/support/import-supervisor.js';

const { expect } = chai;

describe('Import Supervisor', () => {
  it('should fail to create an import supervisor when required services are missing', () => {
    const services = {
      dataAccess: {},
      sqs: {},
      // Missing the s3 service
      env: {},
      log: console,
    };
    expect(() => new ImportSupervisor(services, {})).to.throw('Invalid services: s3 is required');

    services.s3 = {};
    delete services.dataAccess;
    // Now missing the dataAccess service
    expect(() => new ImportSupervisor(services, {})).to.throw('Invalid services: dataAccess is required');
  });
});
