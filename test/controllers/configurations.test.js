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

import ConfigurationsController from '../../src/controllers/configuration.js';
import { ConfigurationDto } from '../../src/dto/configuration.js';

chai.use(chaiAsPromised);

const { expect } = chai;

describe('Configurations Controller', () => {
  const sandbox = sinon.createSandbox();
  const configurations = [
    {
      version: 'v1',
      jobs: [{
        group: 'reports',
        type: 'test',
        interval: 'daily',
      }],
      queues: { reports: 'sqs://some-reports-queue' },
    },
    {
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
      handlers: {
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
      },
      queues: {
        reports: 'sqs://some-reports-queue',
        audits: 'sqs://some-audits-queue',
      },
    },
  ].map((config) => ConfigurationDto.fromJson(config));

  const configurationFunctions = [
    'getAll',
    'getLatest',
    'getByVersion',
  ];

  let mockDataAccess;
  let configurationsController;

  beforeEach(() => {
    mockDataAccess = {
      getConfigurations: sandbox.stub()
        .resolves(configurations),
      getConfiguration: sandbox.stub()
        .resolves(configurations[1]),
      getConfigurationByVersion: sandbox.stub()
        .resolves(configurations.find((config) => config.getVersion() === 'v1')),
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

    expect(mockDataAccess.getConfigurations.calledOnce).to.be.true;
    expect(resultConfigurations).to.be.an('array').with.lengthOf(2);
    expect(resultConfigurations[0]).to.deep.equal(ConfigurationDto.toJSON(configurations[0]));
    expect(resultConfigurations[1]).to.deep.equal(ConfigurationDto.toJSON(configurations[1]));
  });

  it('gets latest configuration', async () => {
    const result = await configurationsController.getLatest();
    const configuration = await result.json();

    expect(mockDataAccess.getConfiguration.calledOnce).to.be.true;

    expect(configuration).to.be.an('object');
    expect(configuration).to.deep.equal(ConfigurationDto.toJSON(configurations[1]));
  });

  it('returns not found when no latest configuration is available', async () => {
    mockDataAccess.getConfiguration.resolves(null);

    const result = await configurationsController.getLatest();
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Configuration not found');
  });

  it('gets an configuration by version', async () => {
    const result = await configurationsController.getByVersion({ params: { version: 'v1' } });
    const configuration = await result.json();

    expect(mockDataAccess.getConfigurationByVersion.calledOnce).to.be.true;

    expect(configuration).to.be.an('object');
    expect(configuration).to.deep.equal(ConfigurationDto.toJSON(configurations[0]));
  });

  it('returns not found when a configuration is not found by version', async () => {
    mockDataAccess.getConfigurationByVersion.resolves(null);

    const result = await configurationsController.getByVersion({ params: { version: 'v4' } });
    const error = await result.json();

    expect(result.status).to.equal(404);
    expect(error).to.have.property('message', 'Configuration not found');
  });

  it('returns bad request if configuration version is not provided', async () => {
    const result = await configurationsController.getByVersion({ params: {} });
    const error = await result.json();

    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Configuration version required');
  });
});
