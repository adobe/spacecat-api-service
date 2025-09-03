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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

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
    'updateSandboxConfig',
  ];

  let mockDataAccess;
  let configurationsController;
  let context;

  beforeEach(() => {
    mockDataAccess = {
      Configuration: {
        all: sandbox.stub().resolves(configurations),
        findLatest: sandbox.stub().resolves(configurations[1]),
        findByVersion: sandbox.stub().resolves(configurations[0]),
      },
    };

    context = {
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    configurationsController = ConfigurationsController(context);
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

  it('throws an error if context is not an object', () => {
    expect(() => ConfigurationsController())
      .to
      .throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => ConfigurationsController({ dataAccess: {} }))
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

  it('gets all configurations for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await configurationsController.getAll();
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view configurations');
  });

  it('gets latest configuration', async () => {
    const result = await configurationsController.getLatest();
    const configuration = await result.json();

    expect(mockDataAccess.Configuration.findLatest.calledOnce).to.be.true;

    expect(configuration).to.be.an('object');
    expect(configuration).to.deep.equal(ConfigurationDto.toJSON(configurations[1]));
  });

  it('gets latest configuration for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await configurationsController.getLatest();
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view configurations');
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

  it('gets an configuration by version for non admin users', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await configurationsController.getByVersion({ params: { version: 1 } });
    const error = await result.json();

    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can view configurations');
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

  describe('Sandbox Configuration Methods', () => {
    let mockCurrentConfig;
    let mockNewConfig;

    beforeEach(() => {
      // Reset admin access for sandbox configuration tests
      context.attributes.authInfo.withProfile({ is_admin: true });
      mockCurrentConfig = {
        getJobs: sandbox.stub().returns([]),
        getHandlers: sandbox.stub().returns({}),
        getQueues: sandbox.stub().returns({}),
        getSlackRoles: sandbox.stub().returns({}),
      };

      mockNewConfig = {
        getVersion: sandbox.stub().returns('2'),
        getJobs: sandbox.stub().returns([]),
        getHandlers: sandbox.stub().returns({}),
        getQueues: sandbox.stub().returns({}),
        getSlackRoles: sandbox.stub().returns({}),
      };

      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(mockCurrentConfig);
      mockDataAccess.Configuration.create = sandbox.stub().resolves(mockNewConfig);
    });

    describe('updateSandboxConfig', () => {
      it('should update sandbox configurations successfully', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
              'meta-tags': { expire: '15' },
            },
          },
        };

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(response).to.have.property('updatedConfigs');
        expect(response.updatedConfigs).to.deep.equal({
          cwv: { expire: '10' },
          'meta-tags': { expire: '15' },
        });
        expect(response).to.have.property('totalUpdated', 2);
        expect(response).to.have.property('newVersion', '2');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '10' } },
            'meta-tags': { sandbox: { expire: '15' } },
          },
          queues: {},
          slackRoles: {},
        });
      });

      it('should return bad request when sandboxConfigs is missing', async () => {
        const requestContext = {
          data: {},
        };

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error.message).to.include('sandboxConfigs object is required');
      });

      it('should return bad request when context.data is undefined', async () => {
        const requestContext = {};

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error.message).to.include('sandboxConfigs object is required');
      });

      it('should return bad request when sandboxConfigs is not an object', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: 'invalid',
          },
        };

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error.message).to.include('sandboxConfigs object is required');
      });

      it('should return forbidden for non-admin users', async () => {
        context.attributes.authInfo.withProfile({ is_admin: false });

        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
            },
          },
        };

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(403);
        expect(error.message).to.include('Only admins can update sandbox configurations');
      });

      it('should return not found when configuration does not exist', async () => {
        mockDataAccess.Configuration.findLatest.resolves(null);

        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
            },
          },
        };

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(404);
        expect(error.message).to.include('Configuration not found');
      });

      it('should return bad request when Configuration.create throws an error', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
            },
          },
        };

        mockDataAccess.Configuration.create.throws(new Error('Create failed'));

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const error = await result.json();

        expect(result.status).to.equal(400);
        expect(error.message).to.include('Error updating sandbox configuration: Create failed');
      });

      it('should handle when getHandlers returns null', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
            },
          },
        };

        // Mock getHandlers to return null to test the || {} fallback
        mockCurrentConfig.getHandlers.returns(null);

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '10' } },
          },
          queues: {},
          slackRoles: {},
        });
      });

      it('should handle when audit type does not exist in handlers', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              newAuditType: { enabled: true },
            },
          },
        };

        // Mock getHandlers to return handlers without the new audit type
        mockCurrentConfig.getHandlers.returns({
          cwv: { sandbox: { expire: '5' } },
        });

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '5' } },
            newAuditType: { sandbox: { enabled: true } },
          },
          queues: {},
          slackRoles: {},
        });
      });

      it('should handle when audit type exists but has no sandbox property', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              lhs: { timeout: '30' },
            },
          },
        };

        // Mock getHandlers to return handlers with audit type but no sandbox property
        mockCurrentConfig.getHandlers.returns({
          cwv: { sandbox: { expire: '5' } },
          lhs: { enabled: true }, // No sandbox property
        });

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '5' } },
            lhs: { enabled: true, sandbox: { timeout: '30' } },
          },
          queues: {},
          slackRoles: {},
        });
      });

      it('should handle when getHandlers returns undefined', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              cwv: { expire: '10' },
            },
          },
        };

        // Mock getHandlers to return undefined to test the || {} fallback
        mockCurrentConfig.getHandlers.returns(undefined);

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '10' } },
          },
          queues: {},
          slackRoles: {},
        });
      });

      it('should handle when audit type does not exist in current handlers', async () => {
        const requestContext = {
          data: {
            sandboxConfigs: {
              newAuditType: { timeout: '15' },
            },
          },
        };

        // Mock getHandlers to return handlers without the new audit type
        mockCurrentConfig.getHandlers.returns({
          cwv: { sandbox: { expire: '5' } },
          // newAuditType doesn't exist, so lines 120-122 will be executed
        });

        const result = await configurationsController.updateSandboxConfig(requestContext);
        const response = await result.json();

        expect(result.status).to.equal(200);
        expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
        expect(mockDataAccess.Configuration.create).to.have.been.calledWith({
          jobs: [],
          handlers: {
            cwv: { sandbox: { expire: '5' } },
            newAuditType: { sandbox: { timeout: '15' } }, // New audit type created
          },
          queues: {},
          slackRoles: {},
        });
      });
    });
  });
});
