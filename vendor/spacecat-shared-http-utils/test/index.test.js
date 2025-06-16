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
import {
  accepted,
  badRequest,
  createResponse,
  created,
  forbidden,
  found,
  internalServerError,
  methodNotAllowed,
  noContent,
  notFound,
  ok,
  unauthorized,
} from '../src/index.js';

async function testMethod(response, expectedCode, expectedBody) {
  expect(response.status).to.equal(expectedCode);
  const responseBody = await (typeof expectedBody === 'string' ? response.text() : response.json());
  expect(responseBody).to.deep.equal(expectedBody);
}

describe('HTTP Response Functions', () => {
  it('createResponse should handle text/plain content type', async () => {
    const body = 'text body';
    const headers = { 'content-type': 'text/plain' };
    const response = await createResponse(body, 200, headers);
    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.equal('text/plain');
    const responseBody = await response.text();
    expect(responseBody).to.equal(body);
  });

  it('createResponse should handle application/json content type', async () => {
    const body = { success: true };
    const response = await createResponse(body);
    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.equal('application/json; charset=utf-8');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal(body);
  });

  it('ok should return a 200 OK response with default body', async () => {
    const response = await ok();
    await testMethod(response, 200, '');
  });

  it('ok should return a 200 OK response with custom body', async () => {
    const body = { success: true };
    const response = await ok(body);
    await testMethod(response, 200, body);
  });

  it('ok should return a 200 OK response with custom body and headers', async () => {
    const body = { success: true };
    const headers = { key: 'value' };
    const response = await ok(body, headers);
    await testMethod(response, 200, body);
    expect(response.headers.get('key')).to.equal('value');
  });

  it('created should return a 201 CREATED response with custom body', async () => {
    const body = { success: true };
    const response = await created(body);
    await testMethod(response, 201, body);
  });

  it('created should return a 200 OK response with custom body and headers', async () => {
    const body = { success: true };
    const headers = { key: 'value' };
    const response = await created(body, headers);
    await testMethod(response, 201, body);
    expect(response.headers.get('key')).to.equal('value');
  });

  it('accepted should return a 202 ACCEPTED response with custom body', async () => {
    const body = { status: 'ACCEPTED' };
    const response = await accepted(body);
    await testMethod(response, 202, body);
  });

  it('accepted should return a 200 OK response with custom body and headers', async () => {
    const body = { status: 'ACCEPTED' };
    const headers = { key: 'value' };
    const response = await accepted(body, headers);
    await testMethod(response, 202, body);
    expect(response.headers.get('key')).to.equal('value');
  });

  it('noContent should return a 204 No Content response with default headers', async () => {
    const response = await noContent();
    expect(response.status).to.equal(204);
    expect(response.headers.get('content-type')).to.equal('application/json; charset=utf-8');
    const responseBody = await response.text();
    expect(responseBody).to.equal('');
  });

  it('noContent should return a 204 No Content response with custom headers', async () => {
    const response = await noContent({ 'custom-header': 'value' });
    expect(response.status).to.equal(204);
    const responseBody = await response.text();
    expect(responseBody).to.equal('');
  });

  it('found should return a 302 Found response with correct location and body', async () => {
    const location = 'https://www.example.com';
    const response = await found(location);

    expect(response.status).to.equal(302);
    expect(response.headers.get('Location')).to.equal(location);
  });

  it('badRequest should return a 400 Bad Request response with default message and headers', async () => {
    const response = await badRequest();
    expect(response.status).to.equal(400);
    expect(response.headers.get('x-error')).to.equal('bad request');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'bad request' });
  });

  it('badRequest should return a 400 Bad Request response with custom message and headers', async () => {
    const response = await badRequest('Invalid input', { 'custom-header': 'value' });
    expect(response.status).to.equal(400);
    expect(response.headers.get('x-error')).to.equal('Invalid input');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'Invalid input' });
  });

  it('unauthorized should return a 401 Unauthorized response with custom message and headers', async () => {
    const response = await unauthorized('Unauthorized access', { 'custom-header': 'value' });
    expect(response.status).to.equal(401);
    expect(response.headers.get('x-error')).to.equal('Unauthorized access');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'Unauthorized access' });
  });

  it('forbidden should return a 403 Forbidden response with custom message and headers', async () => {
    const response = await forbidden('Forbidden access', { 'custom-header': 'value' });
    expect(response.status).to.equal(403);
    expect(response.headers.get('x-error')).to.equal('Forbidden access');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'Forbidden access' });
  });

  it('notFound should return a 404 Not Found response with default message and headers', async () => {
    const response = await notFound();
    expect(response.status).to.equal(404);
    expect(response.headers.get('x-error')).to.equal('not found');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'not found' });
  });

  it('notFound should return a 404 Not Found response with custom message and headers', async () => {
    const response = await notFound('Resource not found', { 'custom-header': 'value' });
    expect(response.status).to.equal(404);
    expect(response.headers.get('x-error')).to.equal('Resource not found');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'Resource not found' });
  });

  it('methodNotAllowed should return a 405 Method Not Allowed response with default message and headers', async () => {
    const response = await methodNotAllowed();
    expect(response.status).to.equal(405);
    expect(response.headers.get('x-error')).to.equal('method not allowed');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'method not allowed' });
  });

  it('methodNotAllowed should return a 405 Method Not Allowed response with custom message and headers', async () => {
    const response = await methodNotAllowed('This method is not allowed', { 'custom-header': 'value' });
    expect(response.status).to.equal(405);
    expect(response.headers.get('x-error')).to.equal('This method is not allowed');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'This method is not allowed' });
  });

  it('internalServerError should return a 500 Internal Server Error response with default message and headers', async () => {
    const response = await internalServerError();
    expect(response.status).to.equal(500);
    expect(response.headers.get('x-error')).to.equal('internal server error');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'internal server error' });
  });

  it('internalServerError should return a 500 Internal Server Error response with custom message and headers', async () => {
    const response = await internalServerError('Server error occurred', { 'custom-header': 'value' });
    expect(response.status).to.equal(500);
    expect(response.headers.get('x-error')).to.equal('Server error occurred');
    expect(response.headers.get('custom-header')).to.equal('value');
    const responseBody = await response.json();
    expect(responseBody).to.deep.equal({ message: 'Server error occurred' });
  });
});
