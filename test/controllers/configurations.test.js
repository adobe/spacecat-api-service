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
});
