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

import { expect } from 'chai';
import sinon from 'sinon';

import {
  extractURLFromSlackInput,
  FALLBACK_SLACK_CHANNEL,
  getSlackContext,
  postErrorMessage, sendFile,
  sendMessageBlocks,
} from '../../../src/utils/slack/base.js';

describe('Base Slack Utils', () => {
  describe('extractBaseURLFromInput', () => {
    it('extractURLFromSlackInput when empty', async () => {
      expect(extractURLFromSlackInput('')).to.be.null;
    });

    it('extractURLFromSlackInput without path', async () => {
      const expected = 'adobe.com';

      expect(extractURLFromSlackInput('get site adobe.com', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <adobe.com|www.adobe.com>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site adobe.com/', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <adobe.com/>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site http://adobe.com', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <http://adobe.com|www.adobe.com>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://adobe.com', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://adobe.com|www.adobe.com>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://www.adobe.com', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://www.adobe.com|www.adobe.com>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://www.adobe.com/', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://www.adobe.com/>', false, false)).to.equal(expected);
    });

    it('extractURLFromSlackInput with path', async () => {
      const expected = 'adobe.com/some/path/w1th_numb3rs';

      expect(extractURLFromSlackInput('add site http://adobe.com/some/path/w1th_numb3rs', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site <http://adobe.com/some/path/w1th_numb3rs|adobe.com/some/path/w1th_numb3rs>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site https://adobe.com/some/path/w1th_numb3rs', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site <https://adobe.com/some/path/w1th_numb3rs|adobe.com/some/path/w1th_numb3rs>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site https://www.adobe.com/some/path/w1th_numb3rs', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site <https://www.adobe.com/some/path/w1th_numb3rs|www.adobe.com/some/path/w1th_numb3rs>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site https://www.adobe.com/some/path/w1th_numb3rs/', false, false)).to.equal(`${expected}/`);
      expect(extractURLFromSlackInput('add site <https://www.adobe.com/some/path/w1th_numb3rs/>', false, false)).to.equal(`${expected}/`);
    });

    it('extractURLFromSlackInput with subdomain and path', async () => {
      const expected = 'business.adobe.com/some/path/w1th_numb3rs';

      expect(extractURLFromSlackInput('get site http://business.adobe.com/some/path/w1th_numb3rs', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <http://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://business.adobe.com/some/path/w1th_numb3rs', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', false, false)).to.equal(expected);
      expect(extractURLFromSlackInput('add site https://business.adobe.com/some/path/w1th_numb3rs/', false, false)).to.equal(`${expected}/`);
      expect(extractURLFromSlackInput('add site <https://business.adobe.com/some/path/w1th_numb3rs/>', false, false)).to.equal(`${expected}/`);
    });

    it('extractURLFromSlackInput with subdomain, path and extension', async () => {
      const expected = 'https://personal.nedbank.co.za/borrow/personal-loans.html';

      expect(extractURLFromSlackInput('get site personal.nedbank.co.za/borrow/personal-loans.html', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <personal.nedbank.co.za/borrow/personal-loans.html|personal.nedbank.co.za/borrow/personal-loans.html>', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.html', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.html|personal.nedbank.co.za/borrow/personal-loans.html>', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.html/', false)).to.equal(`${expected}/`);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.html/>', false)).to.equal(`${expected}/`);
    });

    it('extractURLFromSlackInput with subdomain, path, selector and extension', async () => {
      const expected = 'https://personal.nedbank.co.za/borrow/personal-loans.plain.html';

      expect(extractURLFromSlackInput('get site personal.nedbank.co.za/borrow/personal-loans.plain.html', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html>', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html>', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html/', false)).to.equal(`${expected}/`);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html/>', false)).to.equal(`${expected}/`);
    });

    it('extractURLFromSlackInput domain only', async () => {
      const expected = 'business.adobe.com';

      expect(extractURLFromSlackInput('get site business.adobe.com/', true)).to.equal(expected);
      expect(extractURLFromSlackInput('get site http://business.adobe.com/some/path/w1th_numb3rs', true)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <http://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', true)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://business.adobe.com/some/path/w1th_numb3rs', true)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', true)).to.equal(expected);
      expect(extractURLFromSlackInput('add site https://business.adobe.com/some/path/w1th_numb3rs/', true)).to.equal(expected);
      expect(extractURLFromSlackInput('add site <https://business.adobe.com/some/path/w1th_numb3rs/>', true)).to.equal(expected);
    });

    it('extractURLFromSlackInput with trailing tokens', async () => {
      const expected = 'https://personal.nedbank.co.za/borrow/personal-loans.plain.html';

      expect(extractURLFromSlackInput('get site personal.nedbank.co.za/borrow/personal-loans.plain.html test', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html> test', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html www.acme.com', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html> www.acme.com', false)).to.equal(expected);
      expect(extractURLFromSlackInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html/ extra acme.com/', false)).to.equal(`${expected}/`);
      expect(extractURLFromSlackInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html/> extra acme.com/ <acme.com/> <http://acme.com|acme.com>', false)).to.equal(`${expected}/`);
    });
  });

  describe('Messaging Functions', () => {
    let say;
    let client;

    beforeEach(() => {
      say = sinon.stub();
      client = {
        fileUpload: sinon.stub().resolves(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    describe('postErrorMessage()', () => {
      it('sends an error message', async () => {
        const error = new Error('Test error');
        await postErrorMessage(say, error);

        expect(say.calledOnce).to.be.true;
        expect(say.firstCall.args[0]).to.equal(':nuclear-warning: Oops! Something went wrong: Test error');
      });
    });

    describe('sendMessageBlocks()', () => {
      it('sends a message with the specified blocks', async () => {
        const textSections = [
          { text: 'Hello' },
          { text: 'World', accessory: { type: 'button', text: 'Click me' } },
        ];
        const additionalBlocks = [{ type: 'divider' }];

        await sendMessageBlocks(say, textSections, additionalBlocks);

        const expectedBlocks = [
          { type: 'section', text: { type: 'mrkdwn', text: 'Hello' } },
          { type: 'section', text: { type: 'mrkdwn', text: 'World' }, accessory: { type: 'button', text: 'Click me' } },
          { type: 'divider' },
        ];

        expect(say.calledOnce).to.be.true;
        expect(say.firstCall.args[0]).to.deep.equal({ blocks: expectedBlocks });
      });

      it('sends a message with only the text sections if no additional blocks are provided', async () => {
        const textSections = [{ text: 'Only text' }];

        await sendMessageBlocks(say, textSections);

        const expectedBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Only text' } }];

        expect(say.calledOnce).to.be.true;
        expect(say.firstCall.args[0]).to.deep.equal({ blocks: expectedBlocks });
      });
    });

    describe('sendFile()', () => {
      it('sends a file', async () => {
        const file = 'some-file';
        const filename = 'some-filename';
        const channelId = 'foo';
        const threadTs = 'bar';

        await sendFile({ client, channelId, threadTs }, file, filename);

        expect(client.fileUpload.calledOnce).to.be.true;
        expect(client.fileUpload.firstCall.args[0]).to.deep.equal({
          channel_id: channelId,
          thread_ts: threadTs,
          file,
          filename,
          unfurl_links: false,
        });
      });
    });

    describe('getSlackContext()', async () => {
      it('fallbacks to default slack channel when no configured', async () => {
        const slackContext = await getSlackContext({ url: 'some-url', log: console });
        expect(slackContext).to.eql({ channel: FALLBACK_SLACK_CHANNEL });
      });
    });
  });
});
