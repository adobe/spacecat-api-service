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

import { sendFile } from '../../../utils/slack/base.js';

export const DETAIL_ROW_LIMIT = 8;
export const REPORT_CHUNK_LIMIT = 2800;
export const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SITE_ID_ARG_RE = /^(siteId|site-id|site_id)=(.*)$/i;

const pad2 = (n) => String(n).padStart(2, '0');

export function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function getUtcYMD(date) {
  return {
    year: String(date.getUTCFullYear()),
    month: pad2(date.getUTCMonth() + 1),
    day: pad2(date.getUTCDate()),
  };
}

export function parseUtcDateArg(dateArg) {
  if (!DATE_RE.test(dateArg)) {
    return null;
  }
  const date = new Date(`${dateArg}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatUtcDate(date) !== dateArg) {
    return null;
  }
  return date;
}

export function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isFutureUtcDate(date, now = new Date()) {
  return startOfUtcDay(date) > startOfUtcDay(now);
}

export function parseStatusCommandArgs(args = []) {
  const parsed = {};

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const siteIdMatch = arg.match(SITE_ID_ARG_RE);
    if (siteIdMatch) {
      if (parsed.siteId) {
        return { error: ':warning: Duplicate siteId argument.' };
      }
      const siteId = siteIdMatch[2].trim();
      if (!siteId) {
        return { error: ':warning: siteId must not be empty.' };
      }
      if (!SITE_ID_RE.test(siteId)) {
        return { error: ':warning: Invalid siteId. Expected UUID.' };
      }
      parsed.siteId = siteId;
    } else if (DATE_RE.test(arg)) {
      if (parsed.dateArg) {
        return { error: ':warning: Duplicate date argument.' };
      }
      parsed.dateArg = arg;
    } else if (SITE_ID_RE.test(arg)) {
      if (parsed.siteId) {
        return { error: ':warning: Duplicate siteId argument.' };
      }
      parsed.siteId = arg;
    } else {
      return { error: ':warning: Unrecognized argument. Expected YYYY-MM-DD or siteId=<UUID>.' };
    }
  }

  return parsed;
}

function splitReportLine(line) {
  if (line.length <= REPORT_CHUNK_LIMIT) {
    return [line];
  }
  const parts = [];
  for (let start = 0; start < line.length; start += REPORT_CHUNK_LIMIT) {
    parts.push(line.slice(start, start + REPORT_CHUNK_LIMIT));
  }
  return parts;
}

export function appendLimitedDetails(lines, rows, renderRow, renderOmitted, fullLines = null) {
  const renderedRows = rows.map(renderRow);
  const visibleRows = renderedRows.slice(0, DETAIL_ROW_LIMIT);
  lines.push(...visibleRows);

  if (fullLines && fullLines !== lines) {
    fullLines.push(...renderedRows);
  }

  const omitted = rows.length - visibleRows.length;
  if (omitted > 0) {
    lines.push(renderOmitted(omitted));
  }
  return omitted;
}

export function appendStatusDetails(lines, fullLines, header, rows, renderRow, renderOmitted) {
  if (rows.length === 0) {
    return;
  }
  lines.push('', header);
  fullLines.push('', header);
  appendLimitedDetails(lines, rows, renderRow, renderOmitted, fullLines);
}

async function sayChunkedReport(slackContext, lines) {
  const { say } = slackContext;
  const fullText = lines.join('\n');
  if (fullText.length <= REPORT_CHUNK_LIMIT) {
    await say(fullText);
    return;
  }

  let chunk = '';
  for (const line of lines) {
    for (const part of splitReportLine(line)) {
      if (chunk && chunk.length + part.length + 1 > REPORT_CHUNK_LIMIT) {
        // eslint-disable-next-line no-await-in-loop
        await say(chunk);
        chunk = '';
      }
      chunk = chunk ? `${chunk}\n${part}` : part;
    }
  }
  if (chunk) {
    await say(chunk);
  }
}

export async function postReport(
  slackContext,
  lines,
  filename = 'status-report',
  title = 'Status Report',
  initialComment = 'Full status report',
  fullLines = lines,
) {
  await sayChunkedReport(slackContext, lines);

  const fullText = fullLines.join('\n');
  if (fullLines === lines || fullText === lines.join('\n')) {
    return;
  }

  const canUpload = slackContext.client?.files?.getUploadURLExternal
    && slackContext.client?.files?.completeUploadExternal
    && slackContext.channelId;
  if (!canUpload) {
    return;
  }

  try {
    await sendFile(
      slackContext,
      Buffer.from(fullText, 'utf8'),
      `${filename}.txt`,
      title,
      initialComment,
    );
  } catch (e) {
    await slackContext.say(`:warning: Full report upload failed: ${e.message}`);
  }
}
