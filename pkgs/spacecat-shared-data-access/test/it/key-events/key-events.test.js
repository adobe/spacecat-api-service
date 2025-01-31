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

use(chaiAsPromised);

function checkKeyEvent(keyEvent) {
  expect(keyEvent).to.be.an('object');
  expect(keyEvent.getId()).to.be.a('string');
  expect(keyEvent.getCreatedAt()).to.be.a('string');
  expect(keyEvent.getUpdatedAt()).to.be.a('string');
  expect(keyEvent.getSiteId()).to.be.a('string');
  expect(keyEvent.getName()).to.be.a('string');
  expect(keyEvent.getType()).to.be.a('string');
  expect(keyEvent.getTime()).to.be.a('string');
}

describe('KeyEvent IT', async () => {
  let sampleData;
  let KeyEvent;
  let Site;

  before(async () => {
    sampleData = await seedDatabase();

    const dataAccess = getDataAccess();
    KeyEvent = dataAccess.KeyEvent;
    Site = dataAccess.Site;
  });

  it('gets all key events for a site', async () => {
    const site = sampleData.sites[1];

    const keyEvents = await KeyEvent.allBySiteId(site.getId());

    expect(keyEvents).to.be.an('array');
    expect(keyEvents.length).to.equal(10);

    keyEvents.forEach((keyEvent) => {
      expect(keyEvent.getSiteId()).to.equal(site.getId());
      checkKeyEvent(keyEvent);
    });
  });

  it('adds a new key event for a site', async () => {
    const site = sampleData.sites[1];
    const keyEvent = await KeyEvent.create({
      siteId: site.getId(),
      name: 'keyEventName',
      type: 'PERFORMANCE',
      time: '2024-12-06T08:35:24.125Z',
    });

    checkKeyEvent(keyEvent);

    expect(keyEvent.getSiteId()).to.equal(site.getId());

    const siteWithKeyEvent = await Site.findById(site.getId());

    const keyEvents = await siteWithKeyEvent.getKeyEvents();
    expect(keyEvents).to.be.an('array');
    expect(keyEvents.length).to.equal(11);

    const lastKeyEvent = keyEvents[0];
    checkKeyEvent(lastKeyEvent);
    expect(lastKeyEvent.getId()).to.equal(keyEvent.getId());
  });

  it('removes a key event', async () => {
    const site = sampleData.sites[1];
    const keyEvents = await site.getKeyEvents();
    const keyEvent = keyEvents[0];

    await keyEvent.remove();

    const siteWithKeyEvent = await Site.findById(site.getId());

    const updatedKeyEvents = await siteWithKeyEvent.getKeyEvents();
    expect(updatedKeyEvents).to.be.an('array');
    expect(updatedKeyEvents.length).to.equal(keyEvents.length - 1);
  });
});
