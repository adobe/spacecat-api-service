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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { PassThrough, Readable } from 'stream';
import FormData from 'form-data';
import { Response } from '@adobe/fetch';
import { multipartFormData } from '../../src/support/multipart-form-data.js';

use(chaiAsPromised);

describe('Multipart form data wrapper test', () => {
  let mockRequest;
  let mockContext;
  let exampleHandler;

  const defaultHeaders = {
    'x-api-key': 'b9ebcfb5-80c9-4236-91ba-d50e361db71d',
    'user-agent': 'Unit test',
  };

  /**
   * Creates a new mock request, which is (under the hood) just a stream.
   * @returns {{request: Request, context: object}}
   */
  const createMockFormDataRequest = (formData, headers) => {
    const req = new PassThrough();
    const combinedHeaders = {
      ...headers,
      ...formData.getHeaders(),
    };

    // Pipe the form-data into the request stream
    formData.pipe(req);
    return {
      request: {
        method: 'POST',
        url: 'https://space.cat',
        body: req,
      },
      context: {
        env: {},
        log: console,
        pathInfo: {
          headers: {
            ...combinedHeaders,
          },
        },
      },
    };
  };

  /**
   * Create a new Readable stream from a string.
   * @param str {string} The string to convert to a stream.
   * @return {Readable} The stream.
   */
  const createStream = (str) => Readable.from(str);

  /**
   * Creates a new mock request, which is (under the hood) just a stream.
   * @returns {{request: Request, context: object}}
   */
  const createMockMultipartRequest = (
    urls,
    options,
    importScriptStream,
    headers = defaultHeaders,
  ) => {
    const formData = new FormData();
    formData.append('urls', JSON.stringify(urls));
    if (options) {
      formData.append('options', JSON.stringify(options));
    }
    if (importScriptStream) {
      formData.append('importScript', importScriptStream);
    }

    return createMockFormDataRequest(formData, headers);
  };

  beforeEach(() => {
    const { request, context } = createMockMultipartRequest(
      ['https://example.com/section2/page4'],
      { enableJavascript: true },
    );
    mockRequest = request;
    mockContext = context;

    exampleHandler = sinon.spy(async (_, ctx) => {
      const { log, multipartFormData: data } = ctx;
      log.info(`Handling request ${JSON.stringify(data)}`);
      return new Response(`Processing URLs: ${JSON.stringify(data?.urls)}`);
    });
  });

  it('should parse multipart/form-data from the request', async () => {
    expect(mockContext.multipartFormData).to.be.undefined;

    await multipartFormData(exampleHandler)(mockRequest, mockContext);

    // multipartFormData should now be included in the context
    expect(exampleHandler.calledOnce).to.be.true;
    const firstCall = exampleHandler.getCall(0);

    // Check the context object passed to the handler
    const updatedContext = firstCall.args[1];
    expect(updatedContext.multipartFormData).to.be.an('object');
    expect(updatedContext.multipartFormData.urls).to.be.an('array');
    expect(updatedContext.multipartFormData.urls[0]).to.equal('https://example.com/section2/page4');

    expect(updatedContext.multipartFormData.options).to.be.an('object');
    expect(updatedContext.multipartFormData.options).to.deep.equal({ enableJavascript: true });
  });

  it('should parse a non-JSON field', async () => {
    const formData = new FormData();
    formData.append('stringData', 'Non-JSON value');
    const { request, context } = createMockFormDataRequest(formData, defaultHeaders);

    expect(mockContext.multipartFormData).to.be.undefined;

    await multipartFormData(exampleHandler)(request, context);

    // multipartFormData should now be included in the context
    expect(exampleHandler.calledOnce).to.be.true;
    const firstCall = exampleHandler.getCall(0);

    // Check the context object passed to the handler
    const updatedContext = firstCall.args[1];
    expect(updatedContext.multipartFormData).to.be.an('object');
    expect(updatedContext.multipartFormData.stringData).to.be.a('string');
    expect(updatedContext.multipartFormData.stringData).to.equal('Non-JSON value');
  });

  it('should handle a busboy error', async () => {
    expect(mockContext.multipartFormData).to.be.undefined;

    // Manually change boundary= in the content-type header to mess up busboy
    mockContext.pathInfo.headers['content-type'] = 'multipart/form-data; boundary=--------------------------12345';
    await multipartFormData(exampleHandler)(mockRequest, mockContext);

    // Handler should not have been called
    expect(exampleHandler.notCalled).to.be.true;
  });

  it('does not act on the request if context.multipartFormData is already set', async () => {
    mockContext.multipartFormData = {
      urls: ['https://space.cat'],
    };

    await multipartFormData(exampleHandler)(mockRequest, mockContext);

    // The multipartFormData provided in the context should not have been overwritten
    expect(exampleHandler.calledOnce).to.be.true;
    const secondParam = exampleHandler.getCall(0).args[1];
    expect(secondParam.multipartFormData).to.deep.equal(mockContext.multipartFormData);
  });

  it('should reject when the file upload exceeds the limit', async () => {
    const importScriptStream = createStream('Filler content to create a file > 10 bytes.');
    const { request, context } = createMockMultipartRequest(
      ['https://example.com'],
      {},
      importScriptStream,
    );
    const requestContext = {
      ...mockContext,
      ...context,
    };
    requestContext.env.MULTIPART_FORM_MAX_FILE_SIZE_MB = 10 / 1024 / 1024; // 10B
    const response = await multipartFormData(exampleHandler)(request, requestContext);
    expect(response.status).to.equal(400);
    expect(response.headers.get('x-error')).to.equal('Error parsing request body: File size limit exceeded: 0.0000095367431640625MB');
  });

  /**
   * This test is a bit more complex, as it involves multiple files in the request.
   * It's a good example of how to test multiple files being parsed from the request for the
   * crosswalk use case, where multiple files will be sent in the request.
   */
  it('should parse multiple files from the request', async () => {
    const formData = new FormData();
    formData.append('urls', JSON.stringify(['https://example.com/page1']));
    formData.append('importScript', createStream('import script'));
    formData.append('models', createStream('models'));
    formData.append('filters', createStream('filters'));
    formData.append('definitions', createStream('definitions'));
    formData.append('options', JSON.stringify({ type: 'xwalk' }));

    const { request, context } = createMockFormDataRequest(formData, {});

    const response = await multipartFormData(exampleHandler)(request, context);
    // multipartFormData should now be included in the context
    expect(exampleHandler.calledOnce).to.be.true;

    const firstCall = exampleHandler.getCall(0);

    const updatedContext = firstCall.args[1];
    expect(updatedContext.multipartFormData).to.be.an('object');
    expect(updatedContext.multipartFormData.urls).to.be.an('array');
    expect(updatedContext.multipartFormData.urls[0]).to.equal('https://example.com/page1');
    expect(updatedContext.multipartFormData.models.trim()).to.equal('models');
    expect(updatedContext.multipartFormData.filters.trim()).to.equal('filters');
    expect(updatedContext.multipartFormData.definitions.trim()).to.equal('definitions');
    expect(updatedContext.multipartFormData.options).to.be.an('object');
    expect(updatedContext.multipartFormData.options).to.deep.equal({ type: 'xwalk' });

    expect(response.status).to.equal(200);
  });
});
