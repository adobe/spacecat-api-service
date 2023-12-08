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

import { extractBaseURLFromInput } from '../../../src/utils/slack/base.js';

describe('slackUtils.js', () => {
  it('extractBaseURLFromInput without path', async () => {
    const expected = 'adobe.com';

    expect(extractBaseURLFromInput('get site adobe.com', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <adobe.com|www.adobe.com>', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site adobe.com/', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <adobe.com/>', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site http://adobe.com', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <http://adobe.com|www.adobe.com>', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site https://adobe.com', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <https://adobe.com|www.adobe.com>', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site https://www.adobe.com', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <https://www.adobe.com|www.adobe.com>', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site https://www.adobe.com/', false)).to.equal(expected);
    expect(extractBaseURLFromInput('get site <https://www.adobe.com/>', false)).to.equal(expected);
  });

  it('extractDomainFromInput with path', async () => {
    const expected = 'adobe.com/some/path/w1th_numb3rs';

    expect(extractBaseURLFromInput('add site http://adobe.com/some/path/w1th_numb3rs', false), expected);
    expect(extractBaseURLFromInput('add site <http://adobe.com/some/path/w1th_numb3rs|adobe.com/some/path/w1th_numb3rs>', false), expected);
    expect(extractBaseURLFromInput('add site https://adobe.com/some/path/w1th_numb3rs', false), expected);
    expect(extractBaseURLFromInput('add site <https://adobe.com/some/path/w1th_numb3rs|adobe.com/some/path/w1th_numb3rs>', false), expected);
    expect(extractBaseURLFromInput('add site https://www.adobe.com/some/path/w1th_numb3rs', false), expected);
    expect(extractBaseURLFromInput('add site <https://www.adobe.com/some/path/w1th_numb3rs|www.adobe.com/some/path/w1th_numb3rs>', false), expected);
    expect(extractBaseURLFromInput('add site https://www.adobe.com/some/path/w1th_numb3rs/', false), `${expected}/`);
    expect(extractBaseURLFromInput('add site <https://www.adobe.com/some/path/w1th_numb3rs/>', false), `${expected}/`);
  });

  it('extractDomainFromInput with subdomain and path', async () => {
    const expected = 'business.adobe.com/some/path/w1th_numb3rs';

    expect(extractBaseURLFromInput('get site http://business.adobe.com/some/path/w1th_numb3rs', false), expected);
    expect(extractBaseURLFromInput('get site <http://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', false), expected);
    expect(extractBaseURLFromInput('get site https://business.adobe.com/some/path/w1th_numb3rs', false), expected);
    expect(extractBaseURLFromInput('get site <https://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>', false), expected);
    expect(extractBaseURLFromInput('add site https://business.adobe.com/some/path/w1th_numb3rs/', false), `${expected}/`);
    expect(extractBaseURLFromInput('add site <https://business.adobe.com/some/path/w1th_numb3rs/>', false), `${expected}/`);
  });

  it('extractDomainFromInput with subdomain, path and extension', async () => {
    const expected = 'personal.nedbank.co.za/borrow/personal-loans.html';

    expect(extractBaseURLFromInput('get site personal.nedbank.co.za/borrow/personal-loans.html', false), expected);
    expect(extractBaseURLFromInput('get site <personal.nedbank.co.za/borrow/personal-loans.html|personal.nedbank.co.za/borrow/personal-loans.html>', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.html', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.html|personal.nedbank.co.za/borrow/personal-loans.html>', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.html/', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.html/>', false), expected);
  });

  it('extractDomainFromInput with subdomain, path, selector and extension', async () => {
    const expected = 'personal.nedbank.co.za/borrow/personal-loans.plain.html';

    expect(extractBaseURLFromInput('get site personal.nedbank.co.za/borrow/personal-loans.plain.html', false), expected);
    expect(extractBaseURLFromInput('get site <personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html>', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html>', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html/', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html/>', false), expected);
  });

  it('extractDomainFromInput domain only', async () => {
    const expected = 'business.adobe.com';

    expect(extractBaseURLFromInput('get site http://business.adobe.com/some/path/w1th_numb3rs'), expected);
    expect(extractBaseURLFromInput('get site <http://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>'), expected);
    expect(extractBaseURLFromInput('get site https://business.adobe.com/some/path/w1th_numb3rs'), expected);
    expect(extractBaseURLFromInput('get site <https://business.adobe.com/some/path/w1th_numb3rs|business.adobe.com/some/path/w1th_numb3rs>'), expected);
    expect(extractBaseURLFromInput('add site https://business.adobe.com/some/path/w1th_numb3rs/'), expected);
    expect(extractBaseURLFromInput('add site <https://business.adobe.com/some/path/w1th_numb3rs/>'), expected);
  });

  it('extractDomainFromInput with trailing tokens', async () => {
    const expected = 'personal.nedbank.co.za/borrow/personal-loans.plain.html';

    expect(extractBaseURLFromInput('get site personal.nedbank.co.za/borrow/personal-loans.plain.html test', false), expected);
    expect(extractBaseURLFromInput('get site <personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html> test', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html www.acme.com', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html|personal.nedbank.co.za/borrow/personal-loans.plain.html> www.acme.com', false), expected);
    expect(extractBaseURLFromInput('get site https://personal.nedbank.co.za/borrow/personal-loans.plain.html/ extra acme.com/', false), expected);
    expect(extractBaseURLFromInput('get site <https://personal.nedbank.co.za/borrow/personal-loans.plain.html/> extra acme.com/ <acme.com/> <http://acme.com|acme.com>', false), expected);
  });
});
