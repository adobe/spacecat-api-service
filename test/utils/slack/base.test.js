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

import * as chai from 'chai';
import sinon from 'sinon';
import fs from 'fs/promises';
import chaiAsPromised from 'chai-as-promised';

import { Blocks } from 'slack-block-builder';
import {
  extractURLFromSlackInput,
  FALLBACK_SLACK_CHANNEL,
  getSlackContext,
  postErrorMessage, sendFile,
  sendMessageBlocks,
  parseFlags,
  loadProfileConfig,
} from '../../../src/utils/slack/base.js';
import { DispatchActionOnCharacterEntered } from 'slack-block-builder/dist/internal/index.js';

chai.use(chaiAsPromised);
const { expect } = chai;

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

  describe('parseFlags', () => {
    it('should parse flags correctly', () => {
      const input = '--verbose --profile=default';
      const result = parseFlags(input);

      expect(result).to.deep.equal({
        verbose: true,
        profile: 'default',
      });
    });

    it('should handle single-word flags', () => {
      const input = '--debug';
      const result = parseFlags(input);

      expect(result).to.deep.equal({ debug: true });
    });

    it('should handle flags with spaces in values', () => {
      const input = '--name="John Doe"';
      const result = parseFlags(input);

      expect(result).to.deep.equal({ name: 'John Doe' });
    });

    it('should return an empty object for empty input', () => {
      expect(parseFlags('')).to.deep.equal({});
    });

    it('should handle multiple flags', () => {
      const input = '--profile=summit --verbose';
      const result = parseFlags(input);

      expect(result).to.deep.equal({
        profile: 'summit',
        verbose: true
      });
    });
  });

  describe('Messaging Functions', () => {
    let say;
    let client;

    beforeEach(() => {
      say = sinon.stub();
      client = {
        files: {
          uploadV2: sinon.stub().resolves(),
        },
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
        const additionalBlocks = [Blocks.Divider()];
        const options = { unfurl_links: false };

        await sendMessageBlocks(say, textSections, additionalBlocks, options);

        const expectedBlocks = [
          { type: 'section', text: { type: 'mrkdwn', text: 'Hello' } },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'World' },
            accessory: {
              type: 'button',
              text: {
                text: 'Click me',
                type: 'plain_text',
              },
            },
          },
          { type: 'divider' },
        ];

        expect(say.calledOnce).to.be.true;
        expect(say.firstCall.args[0]).to.deep.equal({ ...options, blocks: expectedBlocks });
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
        const channelId = 'foo';
        const file = 'some-file';
        const filename = 'some-filename';
        const threadTs = 'bar';

        await sendFile({ client, channelId, threadTs }, file, filename);

        expect(client.files.uploadV2.calledOnce).to.be.true;
        expect(client.files.uploadV2.firstCall.args[0]).to.deep.equal({
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

  describe('loadProfileConfig', () => {
    let fsStub;

    beforeEach(() => {
      fsStub = sinon.stub(fs, 'readFile');
    });

    afterEach(() => {
      fsStub.restore();
    });

    it('should load the correct profile configuration', async () => {
      const mockProfileData = JSON.stringify({
        default:  {
          audits: [
            "foo",
            "bar"
          ],
          imports: {},
          config: {},
          integrations: {},
        },
        other:  {
          audits: [
            "audit1",
            "audit2",
          ],
          imports: {},
          config: {},
          integrations: {},
        }
      });
      fsStub.resolves(mockProfileData);

      const result = await loadProfileConfig('default');

      expect(result).to.deep.equal({
        audits: [
          "foo",
          "bar"
        ],
        imports: {},
        config: {},
        integrations: {},
      });
    });

    it('should throw an error if profile does not exist', async () => {
      const mockProfileData = JSON.stringify({
        default:  {
          audits: [
            "foo",
            "bar"
          ],
          imports: {},
          config: {},
          integrations: {},
        },
        other:  {
          audits: [
            "audit1",
            "audit2",
          ],
          imports: {},
          config: {},
          integrations: {},
        }
      });
      fsStub.resolves(mockProfileData);

      await expect(loadProfileConfig('nonexistent'))
        .to.be.rejectedWith('Failed to load profile configuration for "nonexistent": Profile "nonexistent" not found in config/profile.json');
    });

    it('should throw an error if JSON file is invalid', async () => {
      fsStub.resolves('INVALID_JSON');

      await expect(loadProfileConfig('default'))
        .to.be.rejectedWith(`Failed to load profile configuration for "default": Unexpected token 'I', "INVALID_JSON" is not valid JSON`)
    });

    it('should throw an error if the file cannot be read', async () => {
      fsStub.rejects(new Error('File not found'));

      await expect(loadProfileConfig('default'))
        .to.be.rejectedWith('Failed to load profile configuration for "default": File not found');
    });
  });
});
