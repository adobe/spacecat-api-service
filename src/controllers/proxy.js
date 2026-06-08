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

import { badRequest } from '@adobe/spacecat-shared-http-utils';

// Block requests to private/loopback/metadata addresses to prevent SSRF
const BLOCKED_HOST_RE = /^(localhost$|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/;

function ProxyController() {
  const getPreview = async (context) => {
    const rawUrl = new URL(context.request.url).searchParams.get('url');

    if (!rawUrl) {
      return badRequest('url query parameter is required');
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      return badRequest('Invalid URL');
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return badRequest('Only http and https URLs are supported');
    }

    if (BLOCKED_HOST_RE.test(targetUrl.hostname)) {
      return badRequest('URL hostname is not allowed');
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpaceCat/1.0)' },
      });
    } catch {
      return new Response('Failed to fetch URL', { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return new Response('URL does not return HTML', { status: 415 });
    }

    const html = await upstream.text();
    const baseTag = `<base href="${targetUrl.href}">`;
    const patched = /<head/i.test(html)
      ? html.replace(/(<head[^>]*>)/i, `$1${baseTag}`)
      : `${baseTag}${html}`;

    return new Response(patched, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };

  return { getPreview };
}

export default ProxyController;
