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

import { expect } from 'chai';

import { isSlackFileUrl, assertSlackFileUrl } from '../../../src/utils/slack/file-url.js';

describe('Slack file URL allowlist', () => {
  describe('accepts Slack-owned https hosts', () => {
    [
      'https://files.slack.com/files-pri/T123-F456/report.csv',
      'https://slack.com/files-pri/T123-F456/report.csv',
      'https://adobe.enterprise.slack.com/files-pri/T1-F2/x.csv',
      'https://FILES.SLACK.COM/files-pri/T1-F2/x.csv',
    ].forEach((url) => {
      it(`accepts ${url}`, () => {
        expect(isSlackFileUrl(url)).to.be.true;
      });
    });
  });

  describe('rejects everything else', () => {
    [
      // The VULN-39365 primitive: an attacker-controlled host harvesting the bot token.
      ['an attacker-controlled host', 'https://attacker.example.com/collect'],
      // Userinfo trick -- the real authority is evil.test, not files.slack.com.
      ['a userinfo-prefixed lookalike', 'https://files.slack.com@evil.test/collect'],
      ['a userinfo+password lookalike', 'https://files.slack.com:token@evil.test/collect'],
      // Suffix confusion -- these are NOT subdomains of slack.com.
      ['a suffix-confusion domain', 'https://files.slack.com.evil.test/collect'],
      ['a bare suffix-confusion domain', 'https://notslack.com/collect'],
      ['a hyphenated lookalike', 'https://files-slack.com/collect'],
      // Plaintext would put the bearer token on the wire.
      ['plaintext http to Slack', 'http://files.slack.com/files-pri/T1-F2/x.csv'],
      // SSRF against internal metadata / loopback.
      ['AWS IMDS', 'https://169.254.169.254/latest/meta-data/'],
      ['loopback', 'https://127.0.0.1/collect'],
      // Non-http(s) schemes.
      ['a file: URL', 'file:///etc/passwd'],
      ['a data: URL', 'data:text/plain;base64,aGk='],
      // Structurally invalid / absent input.
      ['a relative URL', '/files-pri/T1-F2/x.csv'],
      ['an empty string', ''],
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', { url: 'https://files.slack.com/x' }],
    ].forEach(([label, url]) => {
      it(`rejects ${label}`, () => {
        expect(isSlackFileUrl(url)).to.be.false;
      });
    });
  });

  describe('assertSlackFileUrl', () => {
    it('does not throw for a Slack-hosted URL', () => {
      expect(() => assertSlackFileUrl('https://files.slack.com/files-pri/T1-F2/x.csv')).to.not.throw();
    });

    it('throws for a non-Slack URL', () => {
      expect(() => assertSlackFileUrl('https://attacker.example.com/collect'))
        .to.throw('Refusing to download file: URL is not a Slack-hosted https URL.');
    });

    it('does not leak the rejected URL into the error message', () => {
      // The message reaches Slack and the logs; the URL is attacker-controlled.
      try {
        assertSlackFileUrl('https://attacker.example.com/collect?leak=secret');
        expect.fail('expected assertSlackFileUrl to throw');
      } catch (e) {
        expect(e.message).to.not.contain('attacker.example.com');
        expect(e.message).to.not.contain('leak=secret');
      }
    });
  });
});
