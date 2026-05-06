/*
 * Copyright 2026 Adobe. All rights reserved.
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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

const BASE_URL = 'https://example.com';

function createMockSite({ language = '', region = '' } = {}) {
  let currentLanguage = language;
  let currentRegion = region;
  return {
    getLanguage: () => currentLanguage,
    getRegion: () => currentRegion,
    setLanguage: sinon.stub().callsFake((value) => { currentLanguage = value; }),
    setRegion: sinon.stub().callsFake((value) => { currentRegion = value; }),
    save: sinon.stub().resolves(),
  };
}

function createMockLog() {
  return { debug: sinon.stub(), warn: sinon.stub() };
}

describe('support/locale.js — ensureSiteLocale', () => {
  let sandbox;
  let detectLocaleStub;
  let ensureSiteLocale;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    detectLocaleStub = sandbox.stub();

    ({ ensureSiteLocale } = await esmock('../../src/support/locale.js', {
      '@adobe/spacecat-shared-utils': {
        detectLocale: detectLocaleStub,
        hasText: (v) => typeof v === 'string' && v.trim().length > 0,
      },
    }));
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns false when site is null', async () => {
    const result = await ensureSiteLocale(null, BASE_URL, createMockLog());
    expect(result).to.equal(false);
    expect(detectLocaleStub).to.not.have.been.called;
  });

  it('returns false when site lacks getLanguage', async () => {
    const site = { getRegion: () => '', setLanguage: () => {}, setRegion: () => {} };
    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());
    expect(result).to.equal(false);
    expect(detectLocaleStub).to.not.have.been.called;
  });

  it('returns false when site lacks getRegion', async () => {
    const site = { getLanguage: () => '', setLanguage: () => {}, setRegion: () => {} };
    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());
    expect(result).to.equal(false);
  });

  it('returns false when site lacks setLanguage', async () => {
    const site = { getLanguage: () => '', getRegion: () => '', setRegion: () => {} };
    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());
    expect(result).to.equal(false);
  });

  it('returns false when site lacks setRegion', async () => {
    const site = { getLanguage: () => '', getRegion: () => '', setLanguage: () => {} };
    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());
    expect(result).to.equal(false);
  });

  it('is a no-op when both language and region are already set', async () => {
    const site = createMockSite({ language: 'fr', region: 'FR' });
    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(false);
    expect(detectLocaleStub).to.not.have.been.called;
    expect(site.setLanguage).to.not.have.been.called;
    expect(site.setRegion).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
  });

  it('is a no-op when baseUrl is missing', async () => {
    const site = createMockSite();
    const result = await ensureSiteLocale(site, '', createMockLog());

    expect(result).to.equal(false);
    expect(detectLocaleStub).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
  });

  it('is a no-op when baseUrl is undefined', async () => {
    const site = createMockSite();
    const result = await ensureSiteLocale(site, undefined, createMockLog());

    expect(result).to.equal(false);
    expect(detectLocaleStub).to.not.have.been.called;
  });

  it('sets both language and region when site is empty and detection succeeds, then saves', async () => {
    const site = createMockSite();
    const log = createMockLog();
    detectLocaleStub.resolves({ language: 'de', region: 'DE' });

    const result = await ensureSiteLocale(site, BASE_URL, log);

    expect(result).to.equal(true);
    expect(detectLocaleStub).to.have.been.calledOnceWithExactly({ baseUrl: BASE_URL });
    expect(site.setLanguage).to.have.been.calledOnceWithExactly('de');
    expect(site.setRegion).to.have.been.calledOnceWithExactly('DE');
    expect(site.save).to.have.been.calledOnce;
  });

  it('sets only region when language is already set, then saves', async () => {
    const site = createMockSite({ language: 'en' });
    detectLocaleStub.resolves({ language: 'de', region: 'DE' });

    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(true);
    expect(site.setLanguage).to.not.have.been.called;
    expect(site.setRegion).to.have.been.calledOnceWithExactly('DE');
    expect(site.save).to.have.been.calledOnce;
  });

  it('sets only language when region is already set, then saves', async () => {
    const site = createMockSite({ region: 'US' });
    detectLocaleStub.resolves({ language: 'fr', region: 'FR' });

    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(true);
    expect(site.setLanguage).to.have.been.calledOnceWithExactly('fr');
    expect(site.setRegion).to.not.have.been.called;
    expect(site.save).to.have.been.calledOnce;
  });

  it('leaves site untouched when detectLocale throws', async () => {
    const site = createMockSite();
    const log = createMockLog();
    detectLocaleStub.rejects(new Error('Invalid baseUrl'));

    const result = await ensureSiteLocale(site, BASE_URL, log);

    expect(result).to.equal(false);
    expect(site.setLanguage).to.not.have.been.called;
    expect(site.setRegion).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
    expect(log.debug).to.have.been.calledOnce;
    expect(log.debug.firstCall.args[0]).to.include('Invalid baseUrl');
  });

  it('does not throw when log.debug is missing on the logger', async () => {
    const site = createMockSite();
    detectLocaleStub.rejects(new Error('boom'));

    const result = await ensureSiteLocale(site, BASE_URL, {});

    expect(result).to.equal(false);
    expect(site.save).to.not.have.been.called;
  });

  it('does not throw when log itself is missing', async () => {
    const site = createMockSite();
    detectLocaleStub.rejects(new Error('boom'));

    const result = await ensureSiteLocale(site, BASE_URL);

    expect(result).to.equal(false);
    expect(site.save).to.not.have.been.called;
  });

  it('does not save when detection returns empty values', async () => {
    const site = createMockSite();
    detectLocaleStub.resolves({ language: '', region: '' });

    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(false);
    expect(site.setLanguage).to.not.have.been.called;
    expect(site.setRegion).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
  });

  it('does not save when detection returns null', async () => {
    const site = createMockSite();
    detectLocaleStub.resolves(null);

    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(false);
    expect(site.save).to.not.have.been.called;
  });

  it('sets only the field that detection returns when the other is missing, then saves', async () => {
    const site = createMockSite();
    detectLocaleStub.resolves({ region: 'JP' });

    const result = await ensureSiteLocale(site, BASE_URL, createMockLog());

    expect(result).to.equal(true);
    expect(site.setLanguage).to.not.have.been.called;
    expect(site.setRegion).to.have.been.calledOnceWithExactly('JP');
    expect(site.save).to.have.been.calledOnce;
  });

  it('returns false and logs a warning when site.save fails', async () => {
    const site = createMockSite();
    site.save = sinon.stub().rejects(new Error('db down'));
    const log = createMockLog();
    detectLocaleStub.resolves({ language: 'es', region: 'ES' });

    const result = await ensureSiteLocale(site, BASE_URL, log);

    expect(result).to.equal(false);
    expect(site.setLanguage).to.have.been.calledOnceWithExactly('es');
    expect(site.setRegion).to.have.been.calledOnceWithExactly('ES');
    expect(site.save).to.have.been.calledOnce;
    expect(log.warn).to.have.been.calledOnce;
    expect(log.warn.firstCall.args[0]).to.include('db down');
  });

  it('does not throw when log.warn is missing during save failure', async () => {
    const site = createMockSite();
    site.save = sinon.stub().rejects(new Error('boom'));
    detectLocaleStub.resolves({ language: 'es', region: 'ES' });

    const result = await ensureSiteLocale(site, BASE_URL, {});

    expect(result).to.equal(false);
  });
});
