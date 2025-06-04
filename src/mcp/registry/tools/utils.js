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

/* c8 ignore start */

import { z } from 'zod';

export default {
  characterCount: {
    annotations: {
      title: 'Character Count',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: ''
      + '<use_case>Use this tool to count the number of characters, words and sententences in a given text.</use_case>\n'
      + '<important_notes>'
      + '1. This tool counts all characters, including spaces and punctuation.\n'
      + '2. Words are counted as sequences of characters separated by spaces.\n'
      + '3. Sentences are counted by splitting the text on periods, exclamation marks, or question marks followed by a space or end of string.\n'
      + '</important_notes>\n',
    inputSchema: z.object({
      text: z.string().describe('The text to analyze'),
    }).strict(),
    handler: async ({ text }) => {
      if (!text) {
        return {
          content: [{ type: 'text', text: 'Error: Text is required' }],
        };
      }

      try {
        const charCount = text.length;
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        // Count sentences by splitting on period, exclamation mark, or question mark
        // followed by a space or end of string
        const sentences = text.split(/[.!?]+(?:\s+|$)/).filter(Boolean);
        const sentenceCount = sentences.length;

        return {
          content: [{
            type: 'text',
            text: `Text '${text}' has: ${charCount} characters, ${wordCount} words, and ${sentenceCount} sentences`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error counting text elements: ${error.message}` }],
        };
      }
    },
  },
  encodeBase64: {
    annotations: {
      title: 'Encode Base64',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: ''
      + '<use_case>Use this tool to encode a string to base64 format.</use_case>\n'
      + '<important_notes>'
      + '1. The input text will be encoded to base64 format.\n'
      + '2. The output will be a base64-encoded string that can be decoded back to the original text using the decode tool.\n'
      + '</important_notes>\n',
    inputSchema: z.object({
      text: z.string().describe('The text to encode'),
    }).strict(),
    handler: async ({ text }) => ({
      content: [{ type: 'text', text: Buffer.from(text).toString('base64') }],
    }),
  },
  decodeBase64: {
    annotations: {
      title: 'Decode Base64',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: ''
      + '<use_case>Use this tool to decode a base64-encoded string back to its original text.</use_case>\n'
      + '<important_notes>'
      + '1. The input text must be a valid base64-encoded string.\n'
      + '2. The output will be the original text before it was encoded to base64.\n'
      + '</important_notes>\n',
    inputSchema: z.object({
      text: z.string().describe('The base64 text to decode'),
    }).strict(),
    handler: async ({ text }) => ({
      content: [{ type: 'text', text: Buffer.from(text, 'base64').toString('utf-8') }],
    }),
  },
};

/* c8 ignore end */
