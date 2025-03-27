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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import ConfigurationsController from '../../src/controllers/configuration.js';
import { ConfigurationDto } from '../../src/dto/configuration.js';

use(chaiAsPromised);
use(sinonChai);

describe('Configurations Controller', () => {
  const sandbox = sinon.createSandbox();
  const configurations = [
    {
      getVersion: () => 1,
      getJobs: () => [{
        group: 'reports',
        type: 'test',
        interval: 'daily',
      }],
      getHandlers: () => {},
      getQueues: () => ({ reports: 'sqs://some-reports-queue' }),
      getSlackRoles: () => {},
    },
    {
      getVersion: () => 2,
      getJobs: () => [{
        group: 'reports',
        type: 'test',
        interval: 'weekly',
      }, {
        group: 'audits',
        type: 'cwv',
        interval: 'daily',
      }],
      getHandlers: () => ({
        404: {
          disabled: {
            sites: ['site1'],
            orgs: ['org1', 'org2'],
          },
          enabledByDefault: true,
          dependencies: [],
        },
        'broken-backlinks': {
          enabledByDefault: false,
          enabled: {
            sites: ['site2'],
            orgs: ['org2'],
          },
          dependencies: [],
        },
        cwv: {
          enabledByDefault: true,
        },
      }),
      getQueues: () => ({
        reports: 'sqs://some-reports-queue',
        audits: 'sqs://some-audits-queue',
      }),
      getSlackRoles: () => ({
        scrape: [
          'WSVT1K36Z',
          'S03CR0FDC2V',
        ],
      }),
    },
  ];

  const configurationFunctions = [
    'getAll',
    'getLatest',
    'getByVersion',
    'getLatestJobs',
    'createJobs',
    'getLatestJobsByType',
    'removeLatestJobsByType',
    'updateLatestJobsByType',
  ];

  let mockDataAccess;
  let configurationsController;

  beforeEach(() => {
    mockDataAccess = {
      Configuration: {
        all: sandbox.stub().resolves(configurations),
        findLatest: sandbox.stub().resolves(configurations[1]),
        findByVersion: sandbox.stub().resolves(configurations[0]),
      },
    };

    configurationsController = ConfigurationsController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    configurationFunctions.forEach((funcName) => {
      expect(configurationsController)
        .to
        .have
        .property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(configurationsController)
      .forEach((funcName) => {
        expect(configurationFunctions)
          .to
          .include(funcName);
      });
  });

  it('throws an error if data access is not an object', () => {
    expect(() => ConfigurationsController())
      .to
      .throw('Data access required');
  });

  it('gets all configurations', async () => {
    const result = await configurationsController.getAll();
    const resultConfigurations = await result.json();

    expect(mockDataAccess.Configuration.all.calledOnce).to.be.true;
    expect(resultConfigurations).to.be.an('array').with.lengthOf(2);
    expect(resultConfigurations[0]).to.deep.equal(ConfigurationDto.toJSON(configurations[0]));
    expect(resultConfigurations[1]).to.deep.equal(ConfigurationDto.toJSON(configurations[1]));
  });

  it('gets latest configuration', async () => {
    const result = await configurationsController.getLatest();
    const configuration = await result.json();

    expect(mockDataAccess.Configuration.findLatest.calledOnce).to.be.true;

    expect(configuration).to.be.an('object');
    expect(configuration).to.deep.equal(ConfigurationDto.toJSON(configurations[1]));
  });

  it('returns not found when no latest configuration is available', async () => {
    mockDataAccess.Configuration.findLatest.resolves(null);

    const result = await configurationsController.getLatest();
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Configuration not found');
  });

  it('gets an configuration by version', async () => {
    const result = await configurationsController.getByVersion({ params: { version: 1 } });
    const configuration = await result.json();

    expect(mockDataAccess.Configuration.findByVersion).to.have.been.calledOnceWith(1);

    expect(configuration).to.be.an('object');
    expect(configuration).to.deep.equal(ConfigurationDto.toJSON(configurations[0]));
  });

  it('returns not found when a configuration is not found by version', async () => {
    mockDataAccess.Configuration.findByVersion.resolves(null);

    const result = await configurationsController.getByVersion({ params: { version: 4 } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Configuration not found');
  });

  it('returns bad request if configuration version is not provided', async () => {
    const result = await configurationsController.getByVersion({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Configuration version required to be an integer');
  });

  describe('Job Management Functions', () => {
    beforeEach(() => {
      mockDataAccess.Configuration.update = sandbox.stub().resolves({
        ...configurations[0],
        getJobs: () => [
          ...configurations[0].getJobs(),
          { group: 'new', type: 'test', interval: 'hourly' },
        ],
      });
    });

    describe('getLatestJobs', () => {
      it('returns all jobs from latest configuration', async () => {
        const result = await configurationsController.getLatestJobs();
        const jobs = await result.json();

        expect(mockDataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(jobs).to.deep.equal(configurations[1].getJobs());
      });

      it('returns not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);
        const result = await configurationsController.getLatestJobs();

        expect(result.status).to.equal(404);
        expect(await result.json()).to.have.property('message', 'Configuration not found');
      });
    });

    describe('createJobs', () => {
      it('adds multiple jobs to latest configuration', async () => {
        const newJobs = [
          { group: 'new', type: 'test', interval: 'hourly' },
        ];

        const result = await configurationsController.createJobs({ body: newJobs });
        const updatedConfig = await result.json();

        expect(mockDataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(mockDataAccess.Configuration.update).to.have.been.calledOnce;
        expect(mockDataAccess.Configuration.update.firstCall.args[0]).to.have.property('jobs');
        expect(updatedConfig).to.be.an('object');
      });

      it('returns not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);
        const result = await configurationsController.createJobs({ body: [] });

        expect(result.status).to.equal(404);
        expect(await result.json()).to.have.property('message', 'Latest configuration not found');
      });

      it('validates job data', async () => {
        const invalidJobs = [{ group: 'test' }]; // Missing type and interval
        const result = await configurationsController.createJobs({ body: invalidJobs });

        expect(result.status).to.equal(400);
        expect(await result.json()).to.have.property('message').that.includes('Invalid job data');
      });

      it('validates jobs is an array', async () => {
        const result = await configurationsController.createJobs({ body: {} });

        expect(result.status).to.equal(400);
        expect(await result.json()).to.have.property('message', 'Jobs data must be an array');
      });
    });

    describe('getLatestJobsByType', () => {
      it('returns jobs filtered by type', async () => {
        const result = await configurationsController.getLatestJobsByType({ params: { type: 'cwv' } });
        const jobs = await result.json();

        expect(mockDataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(jobs).to.be.an('array').with.lengthOf(1);
        expect(jobs[0]).to.have.property('type', 'cwv');
      });

      it('returns empty array when no jobs match type', async () => {
        const result = await configurationsController.getLatestJobsByType({ params: { type: 'nonexistent' } });
        const jobs = await result.json();

        expect(jobs).to.be.an('array').with.lengthOf(0);
      });

      it('returns not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);
        const result = await configurationsController.getLatestJobsByType({ params: { type: 'test' } });

        expect(result.status).to.equal(404);
        expect(await result.json()).to.have.property('message', 'Latest configuration not found');
      });
    });

    describe('removeLatestJobsByType', () => {
      it('removes jobs of specified type', async () => {
        const result = await configurationsController.removeLatestJobsByType({ params: { type: 'cwv' } });
        const updatedConfig = await result.json();

        expect(mockDataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(mockDataAccess.Configuration.update).to.have.been.calledOnce;
        const updateArg = mockDataAccess.Configuration.update.firstCall.args[0];
        expect(updateArg.jobs).to.be.an('array');
        expect(updateArg.jobs.some((job) => job.type === 'cwv')).to.be.false;
        expect(updatedConfig).to.be.an('object');
      });

      it('returns not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);
        const result = await configurationsController.removeLatestJobsByType({ params: { type: 'test' } });

        expect(result.status).to.equal(404);
        expect(await result.json()).to.have.property('message', 'Latest configuration not found');
      });
    });

    describe('updateLatestJobsByType', () => {
      it('updates properties of jobs with specified type', async () => {
        const updateData = { interval: 'monthly' };
        const result = await configurationsController.updateLatestJobsByType({
          params: { type: 'cwv' },
          body: updateData,
        });

        expect(mockDataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(mockDataAccess.Configuration.update).to.have.been.calledOnce;

        const updateArg = mockDataAccess.Configuration.update.firstCall.args[0];
        const updatedJobs = updateArg.jobs;
        const cwvJob = updatedJobs.find((job) => job.type === 'cwv');
        expect(cwvJob).to.have.property('interval', 'monthly');

        const updatedConfig = await result.json();
        expect(updatedConfig).to.be.an('object');
      });

      it('returns not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);
        const result = await configurationsController.updateLatestJobsByType({
          params: { type: 'test' },
          body: { interval: 'daily' },
        });

        expect(result.status).to.equal(404);
        expect(await result.json()).to.have.property('message', 'Latest configuration not found');
      });

      it('validates update data is an object', async () => {
        const result = await configurationsController.updateLatestJobsByType({
          params: { type: 'cwv' },
          body: 'not-an-object',
        });

        expect(result.status).to.equal(400);
        expect(await result.json()).to.have.property('message', 'Update data must be an object');
      });
    });
  });
});
