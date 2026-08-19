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

// @ts-check

/**
 * @fileoverview Structured, requester-attributed logging for AIO/Semrush
 * prompt-delete events (SITES-50099). Every delete attempt for a single
 * prompt — whether it actually removed the prompt upstream, found it already
 * gone (idempotent success), or failed — produces ONE log line so "who
 * deleted which prompt, for which brand/market, and when" is answerable from
 * the log index alone. The payload is embedded as JSON in the message (the
 * same convention as upstream-log.js) rather than passed as a second
 * argument, so a CloudWatch Logs Insights / Splunk `parse @message` query can
 * reliably extract fields — `context.log` is bound `console.*`, which would
 * otherwise render an object argument as unquoted-key util.inspect text.
 */

const LABEL = 'Serenity prompt delete';

/**
 * @param {{ info: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} log
 * @param {object} event
 * @param {string | null} event.organizationId
 * @param {string | null | undefined} event.brandId
 * @param {string} event.semrushWorkspaceId
 * @param {string} event.semrushPromptId
 * @param {number | null} event.geoTargetId
 * @param {string | null} event.languageCode
 * @param {string} event.callerId - resolved caller id (see resolveCallerId).
 * @param {'deleted' | 'error'} event.outcome
 * @param {number} [event.status] - upstream HTTP status, error outcomes only.
 * @param {string} [event.message] - redacted upstream message, error outcomes only.
 */
export function logPromptDeleteEvent(log, event) {
  const {
    organizationId, brandId, semrushWorkspaceId, semrushPromptId, geoTargetId, languageCode,
    callerId, outcome, status, message,
  } = event;
  const payload = {
    organizationId,
    brandId,
    semrushWorkspaceId,
    semrushPromptId,
    geoTargetId,
    languageCode,
    callerId,
    outcome,
  };
  if (status !== undefined) {
    payload.status = status;
  }
  if (message) {
    payload.message = message;
  }
  const line = `${LABEL} ${JSON.stringify(payload)}`;
  // Optional chaining, matching the log?.info?.(...) defensiveness this call
  // site replaces: the delete already succeeded or failed by the time this
  // runs, so an audit-logging problem must never surface as a delete failure.
  if (outcome === 'error') {
    log?.error?.(line);
  } else {
    log?.info?.(line);
  }
}
