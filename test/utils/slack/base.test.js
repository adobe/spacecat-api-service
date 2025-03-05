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

import { expect, use } from 'chai';
import sinon from 'sinon';
import fs from 'fs';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';

import path from 'path';

import { Blocks } from 'slack-block-builder';
import {
  extractURLFromSlackInput,
  FALLBACK_SLACK_CHANNEL,
  getSlackContext,
  postErrorMessage, sendFile,
  sendMessageBlocks,
  loadProfileConfig,
  parseCSV,
  fetchFile,
} from '../../../src/utils/slack/base.js';

use(chaiAsPromised);

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

  describe('fetchFile', () => {
    const baseUrl = 'https://fake-url.com';
    const filePath = '/file.csv';
    const fileUrl = `${baseUrl}${filePath}`;
    const token = 'test-bot-token';
    const file = {
      url_private: fileUrl,
      mimetype: 'text/csv',
    };

    afterEach(() => {
      nock.cleanAll();
    });

    it('should return file content when file is downloaded successfully', async () => {
      const mockData = Buffer.from('test1,test2\nvalue1,value2', 'utf-8');

      nock(baseUrl)
        .get(filePath)
        .reply(200, mockData);

      const result = await fetchFile(file, token);
      expect(result).to.equal(mockData.toString('utf-8').trim());
    });

    it('should return a Buffer for non-text files', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02]);

      nock(baseUrl)
        .get(filePath)
        .reply(200, binaryContent);

      const result = await fetchFile(
        { url_private: fileUrl, mimetype: 'application/octet-stream', name: 'non-text-file' },
        token,
      );
      expect(result).to.be.instanceOf(Buffer);
      expect(result.equals(binaryContent)).to.be.true;
    });

    it('should throw an error when authentication fails with 401', async () => {
      nock(baseUrl).get(filePath).reply(401);

      try {
        await fetchFile(file, token);
        throw new Error('Test failed: Expected error was not thrown');
      } catch (error) {
        expect(error.message).to.equal(
          'Authentication failed: Invalid Slack token.',
        );
      }
    });

    it('should throw an error when token lacks the permissions', async () => {
      nock(baseUrl).get(filePath).reply(403);

      try {
        await fetchFile(file, token);
        throw new Error('Test failed: Expected error was not thrown');
      } catch (error) {
        expect(error.message).to.equal('Access denied: Missing files:read permission.');
      }
    });

    it('should throw an error when the file is not found (404)', async () => {
      nock(baseUrl).get(filePath).reply(404);

      try {
        await fetchFile(file, token);
        throw new Error('Test failed: Expected error was not thrown');
      } catch (error) {
        expect(error.message).to.equal(`File not found at: ${fileUrl}.`);
      }
    });

    it('should throw an error when the file is empty', async () => {
      nock(baseUrl).get(filePath).reply(200, '');

      try {
        await fetchFile(file, token);
        throw new Error('Test failed: Expected error was not thrown');
      } catch (error) {
        expect(error.message).to.equal(
          'File download resulted in empty or invalid data.',
        );
      }
    });
  });

  describe('parseCSV', () => {
    const baseUrl = 'https://fake-url.com';
    const filePath = '/file.csv';
    const fileUrl = `${baseUrl}${filePath}`;
    const token = 'test-bot-token';
    const file = {
      url_private: fileUrl,
      mimetype: 'text/csv',
      name: 'file.csv',
    };

    afterEach(() => {
      nock.cleanAll();
    });

    it('should correctly fetch and parse a CSV file', async () => {
      const fileContent = fs.readFileSync('test/fixtures/onboarding.csv', 'utf-8');

      nock(baseUrl)
        .get(filePath)
        .reply(200, fileContent);

      const records = await parseCSV(file, token);

      expect(records).to.deep.equal([
        ['https://www.foo.com', '12345@AdobeOrg'],
        ['https://www.bar.com', '12345@AdobeOrg'],
      ]);
    });

    it('should throw an error when the file download fails due to a network error', async () => {
      nock(baseUrl)
        .get(filePath)
        .replyWithError('Network failure');

      try {
        await parseCSV({ url_private: fileUrl }, token);
        throw new Error('Test failed: Error was not thrown');
      } catch (error) {
        expect(error.message).to.include('CSV processing failed');
      }
    });

    it('should throw an error when CSV data has fewer than 2 columns', async () => {
      nock(baseUrl)
        .get(filePath)
        .reply(200, 'invalid_data');

      try {
        await parseCSV(file, token);
        throw new Error('Test failed: Error was not thrown');
      } catch (error) {
        expect(error.message).to.equal(
          'CSV format invalid: Each row must have at least 2 columns.',
        );
      }
    });

    it('should throw an error when CSV parsing results in invalid data', async () => {
      const invalidCsvContents = ['\n\n\n', ' '];

      for (const content of invalidCsvContents) {
        nock(baseUrl).get(filePath).reply(200, content);

        try {
          // eslint-disable-next-line no-await-in-loop
          await parseCSV(file, token);
          throw new Error('Test failed: Error was not thrown');
        } catch (error) {
          expect(error.message).to.equal(
            'CSV processing failed: CSV parsing resulted in empty or invalid data.',
          );
        }
      }
    });
  });

  describe('loadProfileConfig', () => {
    let fsStub;

    beforeEach(() => {
      fsStub = sinon.stub(fs, 'readFileSync');
    });

    afterEach(() => {
      fsStub.restore();
    });

    it('should load the correct profile configuration', () => {
      const mockProfileData = JSON.stringify({
        default: {
          audits: {
            foo: {},
            bar: {},
          },
          imports: {
            'import-foo': {},
            'import-bar': {},
          },
          config: {},
          integrations: {},
        },
        other: {
          audits: ['audit1', 'audit2'],
          imports: {},
          config: {},
          integrations: {},
        },
      });

      fsStub.returns(mockProfileData);

      const result = loadProfileConfig('default');

      expect(result).to.deep.equal({
        audits: {
          foo: {},
          bar: {},
        },
        imports: {
          'import-foo': {},
          'import-bar': {},
        },
        config: {},
        integrations: {},
      });

      expect(result.audits).to.deep.equal({ foo: {}, bar: {} });
      expect(result.imports).to.deep.equal({
        'import-foo': {},
        'import-bar': {},
      });
    });

    it('should throw an error if profile does not exist', () => {
      const mockProfileData = JSON.stringify({
        default: {
          audits: {
            foo: {},
            bar: {},
          },
          imports: {},
          config: {},
          integrations: {},
        },
        other: {
          audits: ['audit1', 'audit2'],
          imports: {},
          config: {},
          integrations: {},
        },
      });

      const profileConfigPath = path.resolve(process.cwd(), 'static/onboard/profiles.json');

      fsStub.returns(mockProfileData);

      expect(() => loadProfileConfig('nonexistent'))
        .to.throw(`Failed to load profile configuration for "nonexistent": Profile "nonexistent" not found in ${profileConfigPath}`);
    });

    it('should throw an error if JSON file is invalid', () => {
      fsStub.returns('INVALID_JSON');

      expect(() => loadProfileConfig('default'))
        // eslint-disable-next-line quotes
        .to.throw(`Failed to load profile configuration for "default": Unexpected token 'I', "INVALID_JSON" is not valid JSON`);
    });

    it('should throw an error if the file cannot be read', () => {
      fsStub.throws(new Error('File not found'));

      expect(() => loadProfileConfig('default'))
        .to.throw('Failed to load profile configuration for "default": File not found');
    });
  });
});
