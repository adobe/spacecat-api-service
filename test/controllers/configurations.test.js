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
  const configData1 = {
    version: 1,
    jobs: [{
      group: 'reports',
      type: 'test',
      interval: 'daily',
    }],
    handlers: {},
    queues: { reports: 'sqs://some-reports-queue' },
    slackRoles: {},
  };

  const configData2 = {
    version: 2,
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
        productCodes: ['ASO'],
      },
      'broken-backlinks': {
        enabledByDefault: false,
        enabled: {
          sites: ['site2'],
          orgs: ['org2'],
        },
        dependencies: [],
        productCodes: ['ASO'],
      },
      cwv: {
        enabledByDefault: true,
        productCodes: ['ASO'],
      },
    },
    queues: {
      reports: 'sqs://some-reports-queue',
      audits: 'sqs://some-audits-queue',
    },
    slackRoles: {
      scrape: [
        'WSVT1K36Z',
        'S03CR0FDC2V',
      ],
    },
  };

  const configurations = [
    {
      getVersion: () => configData1.version,
      getJobs: () => configData1.jobs,
      getHandlers: () => configData1.handlers,
      getQueues: () => configData1.queues,
      getSlackRoles: () => configData1.slackRoles,
      toJSON: () => configData1,
    },
    {
      getVersion: () => configData2.version,
      getJobs: () => configData2.jobs,
      getHandlers: () => configData2.handlers,
      getQueues: () => configData2.queues,
      getSlackRoles: () => configData2.slackRoles,
      toJSON: () => configData2,
      registerAudit: sandbox.stub(),
      unregisterAudit: sandbox.stub(),
      save: sandbox.stub().resolves(),
    },
  ];

  const configurationFunctions = [
    'getAll',
    'getLatest',
    'getByVersion',
    'registerAudit',
    'unregisterAudit',
    'updateQueues',
    'updateJob',
    'updateHandler',
    'updateConfiguration',
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
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
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

  it('gets latest configuration without handlers when handlers are null', async () => {
    const configWithoutHandlers = {
      ...configurations[1],
      getHandlers: () => null,
    };
    mockDataAccess.Configuration.findLatest.resolves(configWithoutHandlers);

    const result = await configurationsController.getLatest();
    const configuration = await result.json();

    expect(configuration).to.not.have.property('handlers');
    expect(configuration).to.have.property('version');
    expect(configuration).to.have.property('jobs');
  });

  it('gets latest configuration without slackRoles when slackRoles are null', async () => {
    const configWithoutSlackRoles = {
      ...configurations[1],
      getSlackRoles: () => null,
    };
    mockDataAccess.Configuration.findLatest.resolves(configWithoutSlackRoles);

    const result = await configurationsController.getLatest();
    const configuration = await result.json();

    expect(configuration).to.not.have.property('slackRoles');
    expect(configuration).to.have.property('version');
    expect(configuration).to.have.property('jobs');
  });

  it('validates latest configuration and returns 500 if validation fails', async () => {
    const invalidConfiguration = {
      ...configurations[1],
      toJSON: () => ({
        version: 2,
        handlers: null,
        jobs: null,
        queues: null,
      }),
    };
    mockDataAccess.Configuration.findLatest.resolves(invalidConfiguration);

    const result = await configurationsController.getLatest();
    const error = await result.json();

    expect(result.status).to.equal(500);
    expect(error).to.have.property('message');
    expect(error.message).to.include('Configuration data validation failed');
  });

  it('validates latest configuration and returns 500 if handlers are invalid', async () => {
    const invalidConfiguration = {
      ...configurations[1],
      toJSON: () => ({
        version: 2,
        handlers: {
          cwv: {
            enabledByDefault: true,
          },
        },
        jobs: [],
        queues: { audits: 'sqs://queue' },
      }),
    };
    mockDataAccess.Configuration.findLatest.resolves(invalidConfiguration);

    const result = await configurationsController.getLatest();
    const error = await result.json();

    expect(result.status).to.equal(500);
    expect(error).to.have.property('message');
    expect(error.message).to.include('Configuration data validation failed');
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

  it('registers an audit', async () => {
    const result = await configurationsController.registerAudit({
      data: {
        auditType: 'cwv',
        enabledByDefault: true,
        interval: 'weekly',
        productCodes: ['LLMO'],
      },
    });
    expect(result.status).to.equal(201);
  });

  it('register audit returns bad request if register audit throws an error', async () => {
    mockDataAccess.Configuration.findLatest.resolves({
      ...configurations[1],
      registerAudit: sandbox.stub().throws(new Error('Audit type missing')),
    });
    const result = await configurationsController.registerAudit({ data: {} });
    const error = await result.json();
    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audit type missing');
  });

  it('register audit returns forbidden if user is not an admin', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await configurationsController.registerAudit({
      data: {
        auditType: 'cwv',
        enabledByDefault: true,
        interval: 'weekly',
        productCodes: ['LLMO'],
      },
    });
    const error = await result.json();
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can register audits');
  });

  it('unregisters an audit', async () => {
    const result = await configurationsController.unregisterAudit({ params: { auditType: 'cwv' } });
    expect(result.status).to.equal(204);
  });

  it('unregister audit returns bad request if unregister audit throws an error', async () => {
    mockDataAccess.Configuration.findLatest.resolves({
      ...configurations[1],
      unregisterAudit: sandbox.stub().throws(new Error('Audit type missing')),
    });
    const result = await configurationsController.unregisterAudit({ params: {} });
    const error = await result.json();
    expect(result.status).to.equal(400);
    expect(error).to.have.property('message', 'Audit type missing');
  });

  it('unregister audit returns forbidden if user is not an admin', async () => {
    context.attributes.authInfo.withProfile({ is_admin: false });
    const result = await configurationsController.unregisterAudit({ params: { auditType: 'cwv' } });
    const error = await result.json();
    expect(result.status).to.equal(403);
    expect(error).to.have.property('message', 'Only admins can unregister audits');
  });

  describe('updateQueues', () => {
    it('updates queue configuration successfully', async () => {
      const queues = {
        audits: 'sqs://new-audit-queue',
        imports: 'sqs://new-import-queue',
        reports: 'sqs://new-report-queue',
        scrapes: 'sqs://new-scrape-queue',
      };
      const updateQueues = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateQueues,
      });

      const result = await configurationsController.updateQueues({ data: queues });
      const configuration = await result.json();

      expect(result.status).to.equal(200);
      expect(updateQueues).to.have.been.calledOnceWith(queues);
      expect(configuration).to.be.an('object');
    });

    it('returns 403 if user is not an admin', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const result = await configurationsController.updateQueues({
        data: { audits: 'sqs://queue' },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only admins can update queue configuration');
    });

    it('returns 400 if queues configuration is not provided', async () => {
      const result = await configurationsController.updateQueues({ data: {} });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Queues configuration is required and cannot be empty');
    });

    it('returns 404 if configuration not found', async () => {
      mockDataAccess.Configuration.findLatest.resolves(null);
      const result = await configurationsController.updateQueues({
        data: { audits: 'sqs://queue' },
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Configuration not found');
    });

    it('returns 400 if updateQueues throws an error', async () => {
      const updateQueues = sandbox.stub().throws(new Error('Invalid queue URL'));
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateQueues,
      });

      const result = await configurationsController.updateQueues({
        data: { audits: 'invalid-url' },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Invalid queue URL');
    });
  });

  describe('updateJob', () => {
    it('updates job configuration successfully', async () => {
      const updateJob = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateJob,
      });

      const result = await configurationsController.updateJob({
        params: { jobType: 'cwv' },
        data: { interval: 'weekly', group: 'audits' },
      });
      const configuration = await result.json();

      expect(result.status).to.equal(200);
      expect(updateJob).to.have.been.calledOnceWith('cwv', { interval: 'weekly', group: 'audits' });
      expect(configuration).to.be.an('object');
    });

    it('returns 403 if user is not an admin', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const result = await configurationsController.updateJob({
        params: { jobType: 'cwv' },
        data: { interval: 'daily' },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only admins can update job configuration');
    });

    it('returns 400 if jobType is not provided', async () => {
      const result = await configurationsController.updateJob({
        params: {},
        data: { interval: 'daily' },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Job type is required');
    });

    it('returns 400 if job properties are not provided', async () => {
      const result = await configurationsController.updateJob({
        params: { jobType: 'cwv' },
        data: {},
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Job properties are required and cannot be empty');
    });

    it('returns 404 if configuration not found', async () => {
      mockDataAccess.Configuration.findLatest.resolves(null);
      const result = await configurationsController.updateJob({
        params: { jobType: 'cwv' },
        data: { interval: 'daily' },
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Configuration not found');
    });

    it('returns 400 if updateJob throws an error', async () => {
      const updateJob = sandbox.stub().throws(new Error('Job type "unknown" not found'));
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateJob,
      });

      const result = await configurationsController.updateJob({
        params: { jobType: 'unknown' },
        data: { interval: 'daily' },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Job type "unknown" not found');
    });
  });

  describe('updateHandler', () => {
    it('updates handler properties successfully', async () => {
      const updateHandlerProperties = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateHandlerProperties,
      });

      const result = await configurationsController.updateHandler({
        params: { handlerType: 'cwv' },
        data: { enabledByDefault: true, productCodes: ['SPACECAT_CORE'] },
      });
      const configuration = await result.json();

      expect(result.status).to.equal(200);
      expect(updateHandlerProperties).to.have.been.calledOnceWith('cwv', {
        enabledByDefault: true,
        productCodes: ['SPACECAT_CORE'],
      });
      expect(configuration).to.be.an('object');
    });

    it('returns 403 if user is not an admin', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const result = await configurationsController.updateHandler({
        params: { handlerType: 'cwv' },
        data: { enabledByDefault: true },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only admins can update handler configuration');
    });

    it('returns 400 if handlerType is not provided', async () => {
      const result = await configurationsController.updateHandler({
        params: {},
        data: { enabledByDefault: true },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Handler type is required');
    });

    it('returns 400 if handler properties are not provided', async () => {
      const result = await configurationsController.updateHandler({
        params: { handlerType: 'cwv' },
        data: {},
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Handler properties are required and cannot be empty');
    });

    it('returns 404 if configuration not found', async () => {
      mockDataAccess.Configuration.findLatest.resolves(null);
      const result = await configurationsController.updateHandler({
        params: { handlerType: 'cwv' },
        data: { enabledByDefault: true },
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Configuration not found');
    });

    it('returns 400 if updateHandlerProperties throws an error', async () => {
      const updateHandlerProperties = sandbox.stub().throws(new Error('Handler "unknown" not found'));
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateHandlerProperties,
      });

      const result = await configurationsController.updateHandler({
        params: { handlerType: 'unknown' },
        data: { enabledByDefault: true },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Handler "unknown" not found');
    });
  });

  describe('updateConfiguration', () => {
    it('updates configuration with handlers successfully', async () => {
      const updateConfiguration = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateConfiguration,
      });

      const configData = {
        handlers: {
          cwv: {
            enabledByDefault: true,
            productCodes: ['SPACECAT_CORE'],
          },
        },
      };

      const result = await configurationsController.updateConfiguration({ data: configData });
      const configuration = await result.json();

      expect(result.status).to.equal(200);
      expect(updateConfiguration).to.have.been.calledOnceWith(configData);
      expect(configuration).to.be.an('object');
    });

    it('updates configuration with jobs successfully', async () => {
      const updateConfiguration = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateConfiguration,
      });

      const configData = {
        jobs: [
          { group: 'audits', type: 'cwv', interval: 'weekly' },
        ],
      };

      const result = await configurationsController.updateConfiguration({ data: configData });

      expect(result.status).to.equal(200);
      expect(updateConfiguration).to.have.been.calledOnceWith(configData);
    });

    it('updates configuration with queues successfully', async () => {
      const updateConfiguration = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateConfiguration,
      });

      const configData = {
        queues: {
          audits: 'sqs://new-audit-queue',
        },
      };

      const result = await configurationsController.updateConfiguration({ data: configData });

      expect(result.status).to.equal(200);
      expect(updateConfiguration).to.have.been.calledOnceWith(configData);
    });

    it('updates configuration with multiple sections successfully', async () => {
      const updateConfiguration = sandbox.stub();
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateConfiguration,
      });

      const configData = {
        handlers: { cwv: { enabledByDefault: true, productCodes: ['SPACECAT_CORE'] } },
        jobs: [{ group: 'audits', type: 'cwv', interval: 'weekly' }],
        queues: { audits: 'sqs://audit-queue' },
      };

      const result = await configurationsController.updateConfiguration({ data: configData });

      expect(result.status).to.equal(200);
      expect(updateConfiguration).to.have.been.calledOnceWith(configData);
    });

    it('returns 403 if user is not an admin', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });
      const result = await configurationsController.updateConfiguration({
        data: { handlers: {} },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error).to.have.property('message', 'Only admins can update configuration');
    });

    it('returns 400 if configuration data is not provided', async () => {
      const result = await configurationsController.updateConfiguration({ data: {} });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Configuration data is required and cannot be empty');
    });

    it('returns 400 if no updatable fields are provided', async () => {
      const result = await configurationsController.updateConfiguration({
        data: { version: '1', slackRoles: {} },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'At least one of handlers, jobs, or queues must be provided');
    });

    it('returns 404 if configuration not found', async () => {
      mockDataAccess.Configuration.findLatest.resolves(null);
      const result = await configurationsController.updateConfiguration({
        data: { handlers: {} },
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error).to.have.property('message', 'Configuration not found');
    });

    it('returns 400 if updateConfiguration throws an error', async () => {
      const updateConfiguration = sandbox.stub().throws(new Error('Handlers must be a non-empty object'));
      mockDataAccess.Configuration.findLatest.resolves({
        ...configurations[1],
        updateConfiguration,
      });

      const result = await configurationsController.updateConfiguration({
        data: { handlers: {} },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error).to.have.property('message', 'Handlers must be a non-empty object');
    });
  });
});
