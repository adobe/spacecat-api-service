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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';
import { sanitizeIdAndAuditFields, sanitizeTimestamps, zeroPad } from '../../../src/util/util.js';

use(chaiAsPromised);

describe('Configuration IT', async () => {
  let sampleData;
  let Configuration;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [{
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/configuration/*',
      }],
    }];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    Configuration = dataAccess.Configuration;
  });

  it('gets all configurations', async () => {
    const configurations = await Configuration.all();

    expect(configurations).to.be.an('array');
    expect(configurations).to.have.lengthOf(sampleData.configurations.length);
    configurations.forEach((configuration, index) => {
      expect(
        sanitizeTimestamps(configuration.toJSON()),
      ).to.eql(
        sanitizeTimestamps(sampleData.configurations[index].toJSON()),
      );
    });
  });

  it('finds one configuration by version', async () => {
    const sampleConfiguration = sampleData.configurations[1];
    const configuration = await Configuration.findByVersion(
      sampleConfiguration.getVersion(),
    );

    expect(configuration).to.be.an('object');
    expect(
      sanitizeTimestamps(configuration.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleConfiguration.toJSON()),
    );
  });

  it('finds the latest configuration', async () => {
    const sampleConfiguration = sampleData.configurations[0];
    const configuration = await Configuration.findLatest();

    expect(configuration).to.be.an('object');
    expect(
      sanitizeTimestamps(configuration.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleConfiguration.toJSON()),
    );
  });

  it('updates a configuration', async () => {
    const configuration = await Configuration.findLatest();

    const data = {
      enabledByDefault: true,
      enabled: {
        sites: ['site1'],
        orgs: ['org1'],
      },
    };

    const expectedConfiguration = {
      ...configuration.toJSON(),
      handlers: {
        ...configuration.toJSON().handlers,
        test: data,
      },
      version: configuration.getVersion() + 1,
      versionString: zeroPad(configuration.getVersion() + 1, 10),
    };

    configuration.addHandler('test', data);

    await configuration.save();

    const updatedConfiguration = await Configuration.findLatest();
    expect(updatedConfiguration.getId()).to.not.equal(configuration.getId());
    expect(
      Date.parse(updatedConfiguration.record.createdAt),
    ).to.be.greaterThan(
      Date.parse(configuration.record.createdAt),
    );
    expect(
      Date.parse(updatedConfiguration.record.updatedAt),
    ).to.be.greaterThan(
      Date.parse(configuration.record.updatedAt),
    );
    expect(
      sanitizeIdAndAuditFields('Configuration', updatedConfiguration.toJSON()),
    ).to.eql(
      sanitizeIdAndAuditFields('Configuration', expectedConfiguration),
    );
  });
});
