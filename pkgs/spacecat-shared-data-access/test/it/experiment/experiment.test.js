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
import { sanitizeIdAndAuditFields } from '../../../src/util/util.js';

use(chaiAsPromised);

function checkExperiment(experiment) {
  expect(experiment).to.be.an('object');
  expect(experiment.getId()).to.be.a('string');
  expect(experiment.getCreatedAt()).to.be.a('string');
  expect(experiment.getUpdatedAt()).to.be.a('string');
  expect(experiment.getEndDate()).to.be.a('string');
  expect(experiment.getExpId()).to.be.a('string');
  expect(experiment.getName()).to.be.a('string');
  expect(experiment.getStatus()).to.be.a('string');
  expect(experiment.getStartDate()).to.be.a('string');
  expect(experiment.getType()).to.be.a('string');
  expect(experiment.getUrl()).to.be.a('string');
  expect(experiment.getVariants()).to.be.an('array');
}

describe('Experiment IT', async () => {
  let sampleData;
  let Experiment;

  before(async () => {
    sampleData = await seedDatabase();

    const dataAccess = getDataAccess();
    Experiment = dataAccess.Experiment;
  });

  it('gets all experiments for a site', async () => {
    const site = sampleData.sites[0];

    const experiments = await Experiment.allBySiteId(site.getId());

    expect(experiments).to.be.an('array');
    expect(experiments.length).to.equal(3);

    experiments.forEach((experiment) => {
      expect(experiment.getSiteId()).to.equal(site.getId());
      checkExperiment(experiment);
    });
  });

  it('gets all experiments for a site and expId', async () => {
    const site = sampleData.sites[0];
    const expId = 'experiment-1';

    const experiments = await Experiment.allBySiteIdAndExpId(site.getId(), expId);

    expect(experiments).to.be.an('array');
    expect(experiments.length).to.equal(1);

    const experiment = experiments[0];
    expect(experiment.getSiteId()).to.equal(site.getId());
    checkExperiment(experiment);
  });

  it('returns empty array for a site with no experiments', async () => {
    const site = sampleData.sites[1];

    const experiments = await Experiment.allBySiteId(site.getId());

    expect(experiments).to.be.an('array');
    expect(experiments.length).to.equal(0);
  });

  it('finds one experiment by siteId, expId and url', async () => {
    const site = sampleData.sites[0];
    const expId = 'experiment-1';
    const url = 'https://example0.com/page-1';

    const experiment = await Experiment.findBySiteIdAndExpId(site.getId(), expId, url);

    checkExperiment(experiment);
    expect(experiment.getUrl()).to.equal(url);
  });

  it('adds a new experiment to a site', async () => {
    const site = sampleData.sites[0];
    const experimentData = {
      siteId: site.getId(),
      expId: 'experiment-4',
      name: 'Experiment 4',
      url: 'https://example0.com/page-4',
      status: 'ACTIVE',
      type: 'full',
      startDate: '2024-12-06T08:35:24.125Z',
      endDate: '2025-12-06T08:35:24.125Z',
      variants: [
        {
          label: 'Challenger 1',
          name: 'challenger-1',
          interactionsCount: 10,
          p_value: 'coming soon',
          split: 0.8,
          url: 'https://example0.com/page-4/variant-1',
          views: 100,
          metrics: [
            {
              selector: '.header .button',
              type: 'click',
              value: 2,
            },
          ],
        },
        {
          label: 'Challenger 2',
          name: 'challenger-2',
          interactionsCount: 20,
          p_value: 'coming soon',
          metrics: [],
          split: 0.8,
          url: 'https://example0.com/page-4/variant-2',
          views: 200,
        },
      ],
      updatedBy: 'scheduled-experiment-audit',
    };

    const addedExperiment = await Experiment.create(experimentData);

    checkExperiment(addedExperiment);

    expect(sanitizeIdAndAuditFields('Experiment', addedExperiment.toJSON())).to.eql(experimentData);
  });

  it('updates an existing experiment', async () => {
    const site = sampleData.sites[0];
    const expId = 'experiment-1';
    const url = 'https://example0.com/page-1';
    const updates = {
      name: 'Updated Experiment 1',
      url: 'https://example0.com/page-1/updated',
    };

    const experiment = await Experiment.findBySiteIdAndExpIdAndUrl(site.getId(), expId, url);
    experiment.setName(updates.name);
    experiment.setUrl(updates.url);

    await experiment.save();

    checkExperiment(experiment);
    expect(experiment.getName()).to.equal(updates.name);
    expect(experiment.getUrl()).to.equal(updates.url);
  });
});
