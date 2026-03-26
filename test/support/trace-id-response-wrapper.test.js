/*
 * Copyright 2025 Adobe. All rights reserved.
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
import esmock from 'esmock';
import { Response } from '@adobe/fetch';

describe('traceIdResponseWrapper', () => {
  it('sets x-trace-id from context.traceId', async () => {
    const { traceIdResponseWrapper } = await esmock('../../src/support/trace-id-response-wrapper.js', {
      '@adobe/spacecat-shared-utils': { getTraceId: () => null },
    });

    const inner = async () => new Response('ok', { status: 200 });
    const wrapped = traceIdResponseWrapper(inner);
    const res = await wrapped({}, { traceId: 'ctx-trace' });

    expect(res.headers.get('x-trace-id')).to.equal('ctx-trace');
  });

  it('sets x-trace-id from getTraceId when context has none', async () => {
    const { traceIdResponseWrapper } = await esmock('../../src/support/trace-id-response-wrapper.js', {
      '@adobe/spacecat-shared-utils': { getTraceId: () => 'xray-1-2-3' },
    });

    const inner = async () => new Response('ok', { status: 200 });
    const wrapped = traceIdResponseWrapper(inner);
    const res = await wrapped({}, {});

    expect(res.headers.get('x-trace-id')).to.equal('xray-1-2-3');
  });

  it('does not set header when no trace id', async () => {
    const { traceIdResponseWrapper } = await esmock('../../src/support/trace-id-response-wrapper.js', {
      '@adobe/spacecat-shared-utils': { getTraceId: () => null },
    });

    const inner = async () => new Response('ok', { status: 200 });
    const wrapped = traceIdResponseWrapper(inner);
    const res = await wrapped({}, {});

    expect(res.headers.get('x-trace-id')).to.be.null;
  });
});
