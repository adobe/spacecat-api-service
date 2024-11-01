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

/* eslint-disable import/no-unresolved */
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { expect } from 'chai';

export async function extractZip(data) {
  const zip = await JSZip.loadAsync(data);
  const files = {};
  // Iterate over all files in the zip
  await Promise.all(
    Object.keys(zip.files).map(async (filename) => {
      files[filename] = await zip.files[filename].async('nodebuffer');
    }),
  );
  return files;
}

export async function extractDocxContent(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);

  // The content of the document is in 'word/document.xml'
  const docXml = await zip.file('word/document.xml').async('text');

  // Parse the XML content
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXml, 'application/xml');

  // Extract text from the XML
  const paragraphs = xmlDoc.getElementsByTagName('w:t');
  let text = '';
  // eslint-disable-next-line no-plusplus
  for (let i = 0; i < paragraphs.length; i++) {
    text += `${paragraphs[i].textContent} `;
  }

  return text.trim(); // Return the extracted text
}

export async function extractAndVerifyDocxContent(extractedFiles, pathToDocxFile, textToVerify) {
  if (extractedFiles[pathToDocxFile]) {
    const docxContent = await extractDocxContent(extractedFiles[pathToDocxFile]);
    // Verify contents of the .docx file
    expect(docxContent).to.include(textToVerify);
  } else {
    throw new Error('The .docx was file missing from the archive');
  }
}
