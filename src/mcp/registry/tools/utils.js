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

export const echoTool = {
  description: 'Echoes back the input string',
  inputSchema: z.object({
    message: z.string().describe('Message to echo back'),
  }).strict(),
  handler: async ({ message }) => ({
    content: [{ type: 'text', text: String(message) }],
  }),
};

export const characterCountTool = {
  description: 'Counts the number of characters, words, and sentences in a given text. Useful for comparing lengths of initial and recommended texts.',
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
};

/* c8 ignore end */
