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

import {
  isValidUrl, detectBotBlocker, analyzeBotProtection, tracingFetch, SPACECAT_USER_AGENT,
} from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const COMMAND_ID = 'detect-bot-blocker';
const PHRASES = ['detect bot-blocker', 'detect bot blocker', 'check bot blocker'];

const PROBE_TIMEOUT_MS = 15000;

// Named User-Agent presets so a multi-word UA can be selected with a single token
// (the Slack arg parser splits on spaces, so a raw UA string cannot be passed inline).
const UA_PRESETS = {
  default: SPACECAT_USER_AGENT, // what detectBotBlocker uses (mobile Chrome + Spacecat/1.0)
  standard: SPACECAT_USER_AGENT,
  audit: 'Mozilla/5.0 (compatible; Spacecat-Audit/1.0)', // CWV liveness check UA
  bare: 'Spacecat/1.0', // the advertised allowlist token
  scraper: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Spacecat/1.0',
};

/**
 * Normalizes a fetch Response's headers into a plain lower-cased object so the
 * same analysis works for both the @adobe/fetch and native fetch clients.
 * @param {*} headers - Response headers (helix-fetch Headers, undici Headers, or plain).
 * @returns {Object} Plain object of header name -> value.
 */
function headersToObject(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.plain === 'function') {
    return headers.plain();
  }
  try {
    return Object.fromEntries(headers.entries());
  } catch {
    try {
      return Object.fromEntries(headers);
    } catch {
      return {};
    }
  }
}

/**
 * Issues a single bot-blocker probe with an explicit method / User-Agent / client,
 * then classifies the response with analyzeBotProtection. Used to diagnose whether a
 * site blocks a specific request shape (e.g. the CWV liveness HEAD + Spacecat-Audit/1.0)
 * versus the default probe shape.
 * @param {Object} params
 * @param {string} params.url - URL to probe.
 * @param {string} params.method - HTTP method (GET or HEAD).
 * @param {string} params.userAgent - User-Agent header to send.
 * @param {string} params.client - 'adobe' (tracingFetch/@adobe/fetch) or 'node' (native fetch).
 * @returns {Promise<Object>} { status, cfRay, server, analysis }.
 */
async function customProbe({
  url, method, userAgent, client,
}) {
  const useNative = client === 'node';
  const requestOptions = {
    method,
    redirect: 'manual',
    headers: { 'User-Agent': userAgent },
  };
  if (useNative) {
    requestOptions.signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  } else {
    requestOptions.timeout = PROBE_TIMEOUT_MS;
  }

  const fetchFn = useNative ? fetch : tracingFetch;
  const response = await fetchFn(url, requestOptions);
  const { status } = response;
  const headersObj = headersToObject(response.headers);

  let html = '';
  if (method !== 'HEAD') {
    try {
      html = await response.text();
    } catch {
      html = '';
    }
  }

  const analysis = analyzeBotProtection({ status, headers: headersObj, html });
  return {
    status,
    cfRay: headersObj['cf-ray'] || null,
    server: headersObj.server || null,
    analysis,
  };
}

function DetectBotBlockerCommand(context) {
  const baseCommand = BaseCommand({
    id: COMMAND_ID,
    name: 'Detect Bot Blocker',
    description: 'Detects bot blocker technology on a website (Cloudflare, Imperva, Akamai, Fastly, CloudFront, HTTP/2 blocks). '
      + 'Optionally diagnose a specific request shape with method:/ua:/client: args.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} [method:GET|HEAD] [ua:default|audit|bare|scraper] [client:adobe|node]`,
  });

  const { log } = context;

  const formatResult = (result) => {
    const {
      crawlable, type, confidence, reason,
    } = result;
    const confidencePercent = (typeof confidence === 'number')
      ? `${(confidence * 100).toFixed(0)}%`
      : 'N/A%';
    const crawlableEmoji = crawlable ? ':white_check_mark:' : ':no_entry:';

    let confidenceEmoji = ':question:';
    if (confidence >= 0.95) {
      confidenceEmoji = ':muscle:';
    } else if (confidence >= 0.7) {
      confidenceEmoji = ':thinking_face:';
    }

    let typeLabel = type;
    if (type === 'cloudflare') {
      typeLabel = 'Cloudflare';
    } else if (type === 'imperva') {
      typeLabel = 'Imperva/Incapsula';
    } else if (type === 'akamai') {
      typeLabel = 'Akamai';
    } else if (type === 'fastly') {
      typeLabel = 'Fastly';
    } else if (type === 'cloudfront') {
      typeLabel = 'AWS CloudFront';
    } else if (type === 'http2-block') {
      typeLabel = 'HTTP/2 Stream Error';
    } else if (type === 'cloudflare-allowed') {
      typeLabel = 'Cloudflare (Allowed)';
    } else if (type === 'imperva-allowed') {
      typeLabel = 'Imperva (Allowed)';
    } else if (type === 'akamai-allowed') {
      typeLabel = 'Akamai (Allowed)';
    } else if (type === 'fastly-allowed') {
      typeLabel = 'Fastly (Allowed)';
    } else if (type === 'cloudfront-allowed') {
      typeLabel = 'AWS CloudFront (Allowed)';
    } else if (type === 'none') {
      typeLabel = 'No Blocker Detected';
    } else if (type === 'unknown') {
      typeLabel = 'Unknown';
    }

    let message = `${crawlableEmoji} *Crawlable:* ${crawlable ? 'Yes' : 'No'}\n`
      + `:shield: *Blocker Type:* ${typeLabel}\n`
      + `${confidenceEmoji} *Confidence:* ${confidencePercent}`;

    if (reason) {
      message += `\n:information_source: *Reason:* ${reason}`;
    }

    return message;
  };

  /**
   * Parses optional `method:`/`ua:`/`client:` tokens from the trailing args.
   * @param {string[]} tokens - args after the URL.
   * @returns {Object} { hasOverrides, method, client, uaKey, userAgent }.
   */
  const parseProbeOptions = (tokens) => {
    const opts = tokens.reduce((acc, token) => {
      const idx = token.indexOf(':');
      if (idx <= 0) {
        return acc;
      }
      return { ...acc, [token.slice(0, idx).toLowerCase()]: token.slice(idx + 1) };
    }, {});

    const hasOverrides = ['method', 'ua', 'client'].some((key) => key in opts);
    const method = (opts.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
    const client = (opts.client || 'adobe').toLowerCase() === 'node' ? 'node' : 'adobe';
    const uaKey = (opts.ua || 'default').toLowerCase();
    const userAgent = UA_PRESETS[uaKey] || SPACECAT_USER_AGENT;
    return {
      hasOverrides, method, client, uaKey, userAgent,
    };
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    if (!args.length) {
      await say(baseCommand.usage());
      return;
    }

    const baseURL = extractURLFromSlackInput(args[0]);
    if (!isValidUrl(baseURL)) {
      await say(':warning: Please provide a valid URL.');
      await say(baseCommand.usage());
      return;
    }

    const {
      hasOverrides, method, client, uaKey, userAgent,
    } = parseProbeOptions(args.slice(1));

    // Default behavior (no overrides): the standard detectBotBlocker probe.
    if (!hasOverrides) {
      await say(`:mag: Checking bot blocker for \`${baseURL}\`...`);
      try {
        const result = await detectBotBlocker({ baseUrl: baseURL });
        await say(`:robot_face: *Bot Blocker Detection Results for* \`${baseURL}\`\n\n${formatResult(result)}`);
      } catch (error) {
        log.error(`detect-bot-blocker command: failed for URL ${baseURL}`, error);
        await postErrorMessage(say, error);
      }
      return;
    }

    // Diagnostic mode: probe with an explicit request shape.
    await say(`:test_tube: Probing \`${baseURL}\` with client=${client} method=${method} ua=${uaKey}...`);
    try {
      const {
        status, cfRay, server, analysis,
      } = await customProbe({
        url: baseURL, method, userAgent, client,
      });
      const header = `:test_tube: *Bot Blocker Probe (custom)* for \`${baseURL}\`\n`
        + `:gear: client: \`${client}\` | method: \`${method}\` | ua: \`${userAgent}\`\n`
        + `:bar_chart: HTTP status: \`${status}\` | cf-ray: \`${cfRay || 'n/a'}\` | server: \`${server || 'n/a'}\`\n\n`;
      await say(header + formatResult(analysis));
    } catch (error) {
      log.error(`detect-bot-blocker command: custom probe failed for URL ${baseURL}`, error);
      await postErrorMessage(say, error);
    }
  };

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default DetectBotBlockerCommand;
