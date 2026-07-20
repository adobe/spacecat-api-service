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

/* eslint-disable max-statements-per-line -- test expectations */

import { expect } from 'chai';
import { MetaResponseSchema } from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import { create } from '@bufbuild/protobuf';
import { defaultProtoJsonWrite, messageToJson } from '../../../src/support/ai-visibility/proto-json.js';

describe('ai-visibility proto-json', () => {
  it('exports default write options', () => {
    expect(defaultProtoJsonWrite.enumAsInteger).to.equal(true);
    expect(defaultProtoJsonWrite.useProtoFieldName).to.equal(false);
  });

  it('serializes MetaResponse via messageToJson', () => {
    const msg = create(MetaResponseSchema, {
      countries: [{
        country: 1,
        daily: [{ year: 2026, month: 1, day: 1 }],
        monthly: [],
        isComingSoon: false,
      }],
    });
    const json = messageToJson(MetaResponseSchema, msg);
    expect(json).to.be.an('object');
    expect(json.countries).to.be.an('array').with.lengthOf(1);
    expect(json.countries[0].country).to.equal(1);
    expect(json.countries[0].daily).to.be.an('array').with.lengthOf(1);
  });

  it('falls back to JSON clone for plain objects that are not proto-JSON decodable', () => {
    const plain = {
      countries: [{
        country: 1,
        daily: ['2026-05-01'],
        monthly: ['2026-05'],
        isComingSoon: false,
      }],
    };
    const json = messageToJson(MetaResponseSchema, plain);
    expect(json.countries[0].daily).to.deep.equal(['2026-05-01']);
  });

  it('uses empty object when message argument is null', () => {
    const json = messageToJson(MetaResponseSchema, null);
    expect(json).to.be.an('object');
    expect(json.countries === undefined || json.countries?.length === 0).to.equal(true);
  });

  it('merges optional JsonWriteOptions into defaults', () => {
    const msg = create(MetaResponseSchema, { countries: [] });
    const json = messageToJson(MetaResponseSchema, msg, { useProtoFieldName: true });
    expect(json).to.be.an('object');
  });
});
