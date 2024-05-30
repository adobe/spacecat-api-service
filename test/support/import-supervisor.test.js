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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import ImportSupervisor from '../../src/support/import-supervisor.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('Import Supervisor', () => {
  let importSupervisor;
  const urls = ['https://example.com/1', 'https://example.com/2'];

  beforeEach(() => {
    importSupervisor = new ImportSupervisor({
      dataAccess: sinon.stub(),
      sqs: sinon.stub(),
      s3Client: sinon.stub(),
      env: {},
      log: console,
    });
  });

  it('should throw when missing required services', async () => {
    expect(() => new ImportSupervisor({})).to.throw('Invalid services: dataAccess is required');

    expect(() => new ImportSupervisor({
      dataAccess: sinon.stub(),
    })).to.throw('Invalid services: sqs is required');
  });

  describe('startNewJob tests', () => {
    it('should initially return an empty job object', async () => {
      expect(await importSupervisor.startNewJob(urls)).to.deep.equal({});
    });
  });

  describe('getJobStatus tests', () => {
    it('should initially return an empty job object', async () => {
      expect(await importSupervisor.getJobStatus('jobId')).to.deep.equal({});
    });
  });

  describe('getJobArchive tests', () => {
    it('should initially return an empty object', async () => {
      expect(await importSupervisor.getJobArchive('jobId')).to.deep.equal({});
    });
  });
});
