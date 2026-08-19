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

/**
 * Shared LLM caller for the Market Discovery feature (POC — elmo Visibility
 * Overview dashboard). Ported from the brand_audit app's `lib/llm.js`:
 * Bedrock (Claude) primary, Azure OpenAI fallback. Reads secrets from `env`
 * (the Universal runtime context), never `process.env` directly.
 */

async function callBedrock(env, { messages, maxTokens }) {
  const token = env?.AWS_BEARER_TOKEN_BEDROCK;
  const region = env?.BEDROCK_REGION || 'us-west-2';
  const model = env?.BEDROCK_MODEL || 'us.anthropic.claude-opus-4-6-v1';

  if (!token) {
    return null; // signal to fall back to Azure
  }

  let system;
  const claudeMessages = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = m.content;
    } else {
      claudeMessages.push({ role: m.role, content: m.content });
    }
  }

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: claudeMessages,
  };
  if (system) {
    body.system = system;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.message || data.error?.message || JSON.stringify(data);
    throw new Error(`Bedrock request failed (${res.status}): ${errMsg}`);
  }

  const text = data.content?.map((b) => (b.type === 'text' ? b.text : '')).join('') || '';
  if (!text) {
    throw new Error('Empty response from Bedrock Claude.');
  }
  return text;
}

async function callAzure(env, { messages, maxTokens }) {
  const azureBase = (env?.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const apiKey = env?.AZURE_OPENAI_KEY;
  const apiVersion = env?.AZURE_API_VERSION || '2024-12-01-preview';
  const deployment = env?.AZURE_COMPLETION_DEPLOYMENT || 'gpt-4o';

  if (!apiKey) {
    throw new Error('AZURE_OPENAI_KEY is not configured');
  }
  if (!azureBase) {
    throw new Error('AZURE_OPENAI_ENDPOINT is not configured');
  }

  const url = `${azureBase}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ max_completion_tokens: maxTokens, messages }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Azure OpenAI request failed.');
  }

  const text = data.choices?.[0]?.message?.content || '';
  if (!text) {
    throw new Error('Empty response from Azure OpenAI.');
  }
  return text;
}

export async function callLLM(env, { messages, options = {} }) {
  const { maxTokens = 4096 } = options;

  try {
    const result = await callBedrock(env, { messages, maxTokens });
    if (result) {
      return result;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Bedrock failed, falling back to Azure:', e.message);
  }

  return callAzure(env, { messages, maxTokens });
}

export async function callLLMJSON(env, { messages, options }) {
  const text = await callLLM(env, { messages, options });
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${e.message}\nResponse was: ${clean.slice(0, 200)}`);
  }
}
