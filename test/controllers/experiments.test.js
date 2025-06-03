/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { Experiment, Site } from '@adobe/spacecat-shared-data-access';
import ExperimentSchema from '@adobe/spacecat-shared-data-access/src/models/experiment/experiment.schema.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon, { stub } from 'sinon';

import ExperimentsController from '../../src/controllers/experiments.js';
import { ExperimentDto } from '../../src/dto/experiment.js';

use(chaiAsPromised);

const siteId = '3f1c3ab1-9ad0-4231-ac87-8159acf52cb6';

describe('Experiments Controller', () => {
  const sandbox = sinon.createSandbox();

  const experimentFunctions = [
    'getExperiments',
  ];

  const mockExperiments = [
    {
      siteId,
      expId: 'experiment-test1',
      name: 'Experiment Test 1',
      url: 'https://example0.com/page-1',
      status: 'active',
      type: 'full',
      variants: [
        {
          label: 'Challenger 1',
          name: 'challenger-1',
          interactionsCount: 40,
          p_value: 0.333232,
          split: 0.5,
          url: 'https://example0.com/page-1/variant-1',
          views: 1100,
          metrics: [
            {
              selector: '.header .button',
              type: 'click',
              value: 40,
            }],
        },
        {
          label: 'Control',
          name: 'control',
          interactionsCount: 0,
          p_value: 0.339323,
          metrics: [],
          split: 0.5,
          url: 'https://example0.com/page-1',
          views: 1090,
        },
      ],
      startDate: new Date().toISOString(),
      endDate: new Date(new Date().setDate(new Date().getDate() + 10)).toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'unit-test',
      conversionEventName: 'convert',
      conversionEventValue: 'addToCart',
    },
    {
      siteId,
      expId: 'experiment-test2',
      name: 'Experiment Test 2',
      url: 'https://example0.com/page-2',
      status: 'active',
      type: 'AB',
      variants: [
        {
          label: 'Challenger 1',
          name: 'challenger-1',
          interactionsCount: 20,
          p_value: 0.7233,
          split: 0.6,
          url: 'https://example0.com/page-2/variant-1',
          views: 1000,
          metrics: [
            {
              selector: '.cta',
              type: 'click',
              value: 20,
            }],
        },
        {
          label: 'Control',
          name: 'control',
          interactionsCount: 2,
          p_value: 0.782392,
          metrics: [],
          split: 0.4,
          url: 'https://example0.com/page-2',
          views: 800,
        },
      ],
      startDate: new Date().toISOString(),
      endDate: new Date(new Date().setDate(new Date().getDate() + 5)).toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'unit-test',
      conversionEventName: 'click',
      conversionEventValue: '.cta',
    },
  ].map((experiment) => new Experiment(
    { entities: { experiment: {} } },
    {
      log: console,
      getCollection: stub().returns({
        schema: ExperimentSchema,
        findById: stub(),
      }),
    },
    ExperimentSchema,
    experiment,
    console,
  ));

  const mockDataAccess = {
    Experiment: {
      all: sandbox.stub().resolves(mockExperiments),
      allBySiteId: sandbox.stub().resolves(mockExperiments),
    },
    Site: {
      findById: sandbox.stub().resolves({
        siteId,
      }),
    },
  };

  let experimentsController;
  let context;

  beforeEach(() => {
    context = {
      params: {
        siteId,
      },
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    experimentsController = ExperimentsController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    experimentFunctions.forEach((funcName) => {
      expect(experimentsController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(experimentsController).forEach((funcName) => {
      expect(experimentFunctions).to.include(funcName);
    });
  });

  it('throws an error if context is not an object', () => {
    expect(() => ExperimentsController()).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => ExperimentsController({ dataAccess: {} })).to.throw('Data access required');
  });

  describe('getExperiments', () => {
    it('returns bad request if site ID is missing', async () => {
      context.params.siteId = undefined;
      const result = await experimentsController.getExperiments(context);
      expect(result.status).to.equal(400);
    });

    it('returns all the experiments for the given siteId', async () => {
      const result = await experimentsController.getExperiments(context);

      expect(result.status).to.equal(200);
      const experimentsResult = await result.json();
      expect(experimentsResult).to.deep.equal(mockExperiments.map(
        (experiment) => ExperimentDto.toJSON(experiment),
      ));
    });

    it('returns bad request when site is not found', async () => {
      // Mock Site.findById to return null
      mockDataAccess.Site.findById.resolves(null);

      const response = await experimentsController.getExperiments({
        params: {
          siteId,
        },
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site not found');
      expect(mockDataAccess.Site.findById).to.have.been.calledWith(siteId);
    });

    it('returns forbidden when user does not have access to the organization', async () => {
      // Mock Site with Organization
      const mockOrg = {
        getImsOrgId: () => 'test-org-id',
      };

      const mockSite = {
        siteId,
        getOrganization: async () => mockOrg,
      };
      Object.setPrototypeOf(mockSite, Site.prototype);
      mockDataAccess.Site.findById.resolves(mockSite);

      // Create context with non-admin user without org access
      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);

      // Set organizations claim directly
      restrictedAuthInfo.claims = {
        organizations: [],
      };

      const restrictedContext = {
        params: {
          siteId,
        },
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: restrictedAuthInfo,
        },
      };

      const restrictedController = ExperimentsController(restrictedContext);
      const response = await restrictedController.getExperiments(restrictedContext);

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error).to.have.property('message', 'Only users belonging to the organization of the site can view its experiments');
      expect(mockDataAccess.Site.findById).to.have.been.calledWith(siteId);
    });
  });
});
