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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import nock from 'nock';
import { Blocks, Elements, Message } from 'slack-block-builder';
import HooksController from '../../src/controllers/hooks.js';
import { SiteDto } from '../../src/dto/site.js';

chai.use(sinonChai);
const { expect } = chai;

function getExpectedSlackMessage(baseURL, channel, source) {
  return Message()
    .channel(channel)
    .blocks(
      Blocks.Section().text(`I discovered a new site on Edge Delivery Services: *<${baseURL}|${baseURL}>*. Would you like me to include it in the Star Catalogue? (_source:_ *${source}*)`),
      Blocks.Actions().elements(
        Elements.Button().text('As Customer').actionId('approveSiteCandidate').primary(),
        Elements.Button().text('As Friends/Family').actionId('approveSiteCandidate').primary(),
        Elements.Button().text('Ignore').actionId('ignoreSiteCandidate').danger(),
      ),
    )
    .buildToObject();
}

describe('Hooks Controller', () => {
  let slackClient;
  let context;
  let hooksController;

  beforeEach('set up', () => {
    slackClient = {
      postMessage: sinon.mock(),
    };

    context = {
      dataAccess: {
        getSiteCandidateByBaseURL: sinon.stub(),
        addSite: sinon.stub(),
        upsertSiteCandidate: sinon.stub(),
        getSiteByBaseURL: sinon.stub(),
        siteCandidateExists: sinon.stub(),
      },
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
      },
      env: {
        INCOMING_WEBHOOK_SECRET_CDN: 'hook-secret-for-cdn',
        INCOMING_WEBHOOK_SECRET_RUM: 'hook-secret-for-rum',
        SLACK_SITE_DISCOVERY_CHANNEL_INTERNAL: 'channel-id',
      },
      slackClients: {
        WORKSPACE_INTERNAL_STANDARD: slackClient,
      },
    };

    hooksController = HooksController(context);
  });

  describe('Hook auth ', () => {
    it('return 404 if hook secret env for cdn was not set up', async () => {
      delete context.env.INCOMING_WEBHOOK_SECRET_CDN;

      const resp = await hooksController.processCDNHook(context);
      expect(resp.status).to.equal(404);
      expect(slackClient.postMessage.notCalled).to.be.true;
    });

    it('return 404 if hook secret env for rum was not set up', async () => {
      delete context.env.INCOMING_WEBHOOK_SECRET_RUM;

      const resp = await hooksController.processRUMHook(context);
      expect(resp.status).to.equal(404);
      expect(slackClient.postMessage.notCalled).to.be.true;
    });

    it('return 404 if cdn secret doesnt match', async () => {
      context.params = {
        hookSecret: 'wrong-secret',
      };

      const resp = await hooksController.processCDNHook(context);
      expect(resp.status).to.equal(404);
      expect(slackClient.postMessage.notCalled).to.be.true;
    });

    it('return 404 if rum secret doesnt match', async () => {
      context.params = {
        hookSecret: 'wrong-secret',
      };

      const resp = await hooksController.processRUMHook(context);
      expect(resp.status).to.equal(404);
      expect(slackClient.postMessage.notCalled).to.be.true;
    });
  });

  describe('URL sanitization checks', () => {
    async function assertInvalidCase(input) {
      context.params = { hookSecret: 'hook-secret-for-cdn' };
      context.data = {
        forwardedHost: input,
      };
      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
    }

    it('hostnames with path are not accepted', async () => {
      await assertInvalidCase('some.domain/some/path, some-fw-domain.com');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some.domain/some/path. Reason: Path/search params are not accepted');
    });

    it('hostnames with query params are not accepted', async () => {
      await assertInvalidCase('some.domain?param=value, some-fw-domain.com');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some.domain?param=value. Reason: Path/search params are not accepted');
    });

    it('hostnames in IPs are not accepted', async () => {
      await assertInvalidCase('https://112.12.12.112, some-fw-domain.com');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: https://112.12.12.112. Reason: Hostname is an IP address');
    });

    it('hostnames with suspected non-prod subdomains are not accepted', async () => {
      await assertInvalidCase('stage.some.domain, some-fw-domain.com');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: stage.some.domain. Reason: URL most likely contains a non-prod domain');
    });
  });

  describe('Site content checks', () => {
    beforeEach('set up', () => {
      context.params = { hookSecret: 'hook-secret-for-cdn' };
    });

    it('URLs with error responses are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect' });

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: URL is unreachable: https://some-domain.com');
    });

    it('URLs without valid plain.htmls are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com/index.plain.html')
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect' });

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: .plain.html is unreachable for https://some-domain.com/index.plain.html');
    });

    it('URLs with non-200 index plain.htmls are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com')
        .get('/index.plain.html')
        .reply(404);

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: .plain.html does not return 2XX for https://some-domain.com/index.plain.html');
    });

    it('URLs with redirects and returns non-200 plain.htmls are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(301, undefined, { location: 'https://some-domain.com/en/us' });
      nock('https://some-domain.com')
        .get('/en/us')
        .reply(200);

      nock('https://some-domain.com')
        .get('/en/us.plain.html')
        .reply(404);

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: .plain.html does not return 2XX for https://some-domain.com/en/us.plain.html');
    });

    it('plain.htmls with redirects are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com')
        .get('/index.plain.html')
        .reply(301, undefined, { location: 'https://some-domain.com/404-page-with-200-result' });

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: .plain.html does not return 2XX for https://some-domain.com/index.plain.html');
    });

    it('plain.htmls containing <head> are disregarded', async () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com')
        .get('/index.plain.html')
        .reply(200, '<html><head><title>some title</title></head><body>some body</body></html>');

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: .plain.html should not contain <head>');
    });
  });

  describe('Site candidate not processed ', () => {
    beforeEach('set up', () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com')
        .get('/index.plain.html')
        .reply(200);

      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };
      context.params = { hookSecret: 'hook-secret-for-cdn' };
    });

    it('candidate is disregarded if already added before', async () => {
      context.dataAccess.siteCandidateExists.resolves(true);

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(slackClient.postMessage.notCalled).to.be.true;
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: Site candidate previously evaluated');
    });

    it('candidate is disregarded if a site exists with same baseURL', async () => {
      context.dataAccess.siteCandidateExists.resolves(false);
      context.dataAccess.upsertSiteCandidate.resolves();
      context.dataAccess.getSiteByBaseURL.resolves(SiteDto.fromJson({ baseURL: 'https://some-domain.com' }));

      const resp = await (await hooksController.processCDNHook(context)).json();
      expect(resp).to.equal('CDN site candidate disregarded');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: Site candidate already exists in sites db');
    });
  });

  describe('Site candidate processed', () => {
    beforeEach('set up', () => {
      nock('https://some-domain.com')
        .get('/')
        .reply(200);
      nock('https://some-domain.com')
        .get('/index.plain.html')
        .reply(200);

      context.dataAccess.siteCandidateExists.resolves(false);
      context.dataAccess.upsertSiteCandidate.resolves();
      context.dataAccess.getSiteByBaseURL.resolves(null);
    });

    it('CDN candidate is processed and slack message sent', async () => {
      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };
      context.params = { hookSecret: 'hook-secret-for-cdn' };

      const resp = await (await hooksController.processCDNHook(context)).json();

      expect(resp).to.equal('CDN site candidate is successfully processed');
    });

    it('RUM candidate is processed and slack message sent', async () => {
      context.data = {
        domain: 'some-domain.com',
      };
      context.params = { hookSecret: 'hook-secret-for-rum' };

      const resp = await (await hooksController.processRUMHook(context)).json();

      expect(resp).to.equal('RUM site candidate is successfully processed');
      expect(slackClient.postMessage.calledOnceWith(getExpectedSlackMessage(
        'https://some-domain.com',
        context.env.SLACK_SITE_DISCOVERY_CHANNEL_INTERNAL,
        'RUM',
      ))).to.be.true;
    });

    it('Slack message sending fails for CDN candidate', async () => {
      context.data = {
        forwardedHost: 'some-domain.com, some-fw-domain.com',
      };
      context.params = { hookSecret: 'hook-secret-for-cdn' };

      slackClient.postMessage.rejects(new Error('Slack message failure'));

      const resp = await (await hooksController.processCDNHook(context)).json();

      expect(resp).to.equal('CDN site candidate disregarded');
      expect(context.log.warn).to.have.been.calledWith('Could not process the CDN site candidate: some-domain.com. Reason: Slack message failure');
    });

    it('Slack message sending fails for RUM candidate', async () => {
      context.data = {
        domain: 'some-domain.com',
      };
      context.params = { hookSecret: 'hook-secret-for-rum' };

      slackClient.postMessage.rejects(new Error('Slack message failure'));

      const resp = await (await hooksController.processRUMHook(context)).json();

      expect(resp).to.equal('RUM site candidate disregarded');
      expect(context.log.warn).to.have.been.calledWith('Could not process the RUM site candidate: some-domain.com. Reason: Slack message failure');
    });
  });
});
