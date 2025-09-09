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
      getEnabledSandboxAudits: () => [],
      getSandboxAuditConfig: () => null,
      getSandboxAudits: () => null,
      setSandboxAudits: () => {},
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
      getEnabledSandboxAudits: () => ['cwv', 'meta-tags'],
      getSandboxAuditConfig: (auditType) => {
        if (auditType === 'cwv') return { expire: '10' };
        if (auditType === 'meta-tags') return { expire: '15' };
        return null;
      },
      getSandboxAudits: () => ({
        enabledAudits: {
          cwv: { expire: '10' },
          'meta-tags': { expire: '15' },
        },
      }),
      setSandboxAudits: () => {},
      state: {
        sandboxAudits: {
          enabledAudits: {
            cwv: { expire: '10' },
            'meta-tags': { expire: '15' },
          },
        },
      },
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

  describe('updateSandboxConfig', () => {
    let mockConfig;

    beforeEach(() => {
      // Reset to admin access for all sandbox config tests
      context.attributes.authInfo.withProfile({ is_admin: true });

      // Create a config object with the required methods and state
      mockConfig = {
        state: {},
        updateSandboxAuditConfig: sandbox.stub(),
        getSandboxAudits: sandbox.stub().returns({ enabledAudits: {} }),
        setSandboxAudits: sandbox.stub(),
        save: sandbox.stub().resolves(mockConfig),
      };

      // Override the global mocks for this test suite
      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(mockConfig);

      // Recreate controller with updated context
      configurationsController = ConfigurationsController(context);
    });

    it('should return forbidden for non-admin users', async () => {
      context.attributes.authInfo.withProfile({ is_admin: false });

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: { cwv: { expire: '10' } } },
      });
      const error = await result.json();

      expect(result.status).to.equal(403);
      expect(error.message).to.include('Only admins can update sandbox configurations');
    });

    it('should return bad request when context.data is undefined', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });

      const result = await configurationsController.updateSandboxConfig({});
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error.message).to.include('sandboxConfigs object is required');
    });

    it('should return bad request when sandboxConfigs is missing', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });

      const result = await configurationsController.updateSandboxConfig({
        data: {},
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error.message).to.include('sandboxConfigs object is required');
    });

    it('should return bad request when sandboxConfigs is not an object', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: 'invalid' },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error.message).to.include('sandboxConfigs object is required');
    });

    it('should return not found when configuration does not exist', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });
      mockDataAccess.Configuration.findLatest.resolves(null);

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: { cwv: { expire: '10' } } },
      });
      const error = await result.json();

      expect(result.status).to.equal(404);
      expect(error.message).to.include('Configuration not found');
    });

    it('should update sandbox configurations successfully', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });
      const sandboxConfigs = {
        cwv: { expire: '10' },
        'meta-tags': { expire: '15' },
      };

      // Ensure the mock save method resolves successfully
      mockConfig.save = sandbox.stub().resolves();

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs },
      });
      const response = await result.json();

      expect(result.status).to.equal(200);
      expect(response).to.have.property('message', 'Sandbox configurations updated successfully');
      expect(response).to.have.property('updatedConfigs');
      expect(response.updatedConfigs).to.deep.equal(sandboxConfigs);
      expect(response).to.have.property('totalUpdated', 2);
      expect(mockConfig.updateSandboxAuditConfig).to.have.been.calledWith('cwv', { expire: '10' });
      expect(mockConfig.updateSandboxAuditConfig).to.have.been.calledWith('meta-tags', { expire: '15' });
      expect(mockConfig.save).to.have.been.called;
    });

    it('should handle errors during configuration update', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });
      mockConfig.save.rejects(new Error('Update failed'));

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: { cwv: { expire: '10' } } },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error.message).to.include('Error updating sandbox configuration: Update failed');
    });

    it('should handle errors during configuration save', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });
      mockConfig.save.rejects(new Error('Save failed'));

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: { cwv: { expire: '10' } } },
      });
      const error = await result.json();

      expect(result.status).to.equal(400);
      expect(error.message).to.include('Error updating sandbox configuration: Save failed');
    });

    it('should handle configuration with null sandbox audits', async () => {
      context.attributes.authInfo.withProfile({ is_admin: true });

      // Create a config with null sandbox audits to test our fix
      const configWithNullSandboxAudits = {
        updateSandboxAuditConfig: sandbox.stub(),
        getSandboxAudits: sandbox.stub().returns(null),
        setSandboxAudits: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockDataAccess.Configuration.findLatest.resolves(configWithNullSandboxAudits);
      configurationsController = ConfigurationsController(context);

      const result = await configurationsController.updateSandboxConfig({
        data: { sandboxConfigs: { cwv: { expire: '10' } } },
      });
      const response = await result.json();

      // Should succeed with null sandbox audits
      expect(result.status).to.equal(200);
      expect(configWithNullSandboxAudits.updateSandboxAuditConfig).to.have.been.calledWith('cwv', { expire: '10' });
      expect(configWithNullSandboxAudits.save).to.have.been.called;
      expect(response.message).to.equal('Sandbox configurations updated successfully');
    });
  });
});
