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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

import YAML from 'yaml';

/**
 * Bundles the multi-file OpenAPI spec into a single in-memory object. Walks
 * every $ref and inlines its target:
 *  - Cross-file refs (`./file.yaml#/...`) load the target file and inline.
 *  - Local refs (`#/...`) resolve against the document that issued them.
 *
 * The same JSON-pointer escapes apply (`~1` -> `/`, `~0` -> `~`).
 *
 * Bundling inlines every ref recursively so the output is a fully self-
 * contained spec safe to feed to AJV. Cycles are guarded with a per-resolve
 * visited set; a cyclic ref leaves the ref node in place (caller deals).
 */
export function bundleOpenApi(entryPath) {
  const cache = new Map();
  function load(absPath) {
    if (cache.has(absPath)) {
      return cache.get(absPath);
    }
    const parsed = YAML.parse(readFileSync(absPath, 'utf8'));
    cache.set(absPath, parsed);
    return parsed;
  }

  function followPointer(doc, pointer) {
    if (!pointer || pointer === '/') {
      return doc;
    }
    const segments = pointer.replace(/^\//, '').split('/').map(
      (s) => s.replaceAll('~1', '/').replaceAll('~0', '~'),
    );
    let cursor = doc;
    for (const seg of segments) {
      if (cursor == null || typeof cursor !== 'object') {
        return undefined;
      }
      cursor = cursor[seg];
    }
    return cursor;
  }

  /**
   * @param {any} value          node being processed
   * @param {string} baseDir     dir of the file `currentDoc` was loaded from
   * @param {object} currentDoc  the document owning local `#/...` refs
   * @param {Set<string>} visited keys of refs being resolved, for cycle break
   */
  function resolveRefs(value, baseDir, currentDoc, visited) {
    if (Array.isArray(value)) {
      return value.map((v) => resolveRefs(v, baseDir, currentDoc, visited));
    }
    if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') {
        const [filePart, pointerPart = ''] = value.$ref.split('#');
        let targetDoc;
        let targetDir;
        let refKey;
        if (filePart === '') {
          // local ref into the current document
          targetDoc = currentDoc;
          targetDir = baseDir;
          refKey = `<current>#${pointerPart}`;
        } else {
          const targetPath = resolvePath(baseDir, filePart);
          targetDoc = load(targetPath);
          targetDir = dirname(targetPath);
          refKey = `${targetPath}#${pointerPart}`;
        }
        if (visited.has(refKey)) {
          // cycle: drop the ref to break the loop (callers see {}).
          return {};
        }
        const followed = followPointer(targetDoc, pointerPart);
        const nextVisited = new Set(visited);
        nextVisited.add(refKey);
        return resolveRefs(followed, targetDir, targetDoc, nextVisited);
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = resolveRefs(v, baseDir, currentDoc, visited);
      }
      return out;
    }
    return value;
  }

  const absEntry = resolvePath(entryPath);
  const root = load(absEntry);
  return resolveRefs(root, dirname(absEntry), root, new Set());
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENAPI_ROOT = resolvePath(HERE, '..', '..', '..', 'docs', 'openapi');

/**
 * Convenience loader: bundles `docs/openapi/api.yaml` and returns the
 * fully-resolved spec. Cached at module level — bundling reads ~20 yaml files
 * and takes ~20ms; we don't want to repeat per `it()`.
 */
let cachedBundle;
export function loadBundledSpec() {
  if (!cachedBundle) {
    cachedBundle = bundleOpenApi(join(OPENAPI_ROOT, 'api.yaml'));
  }
  return cachedBundle;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Enumerates every operation in the spec whose `tags` include the given tag.
 * Returns `{ method, path, operationId, operation, responseSchema(status) }`
 * descriptors; `responseSchema` returns the `application/json` schema for the
 * given status code, or `undefined` if the operation has no JSON body for
 * that status (e.g. a 204 No Content).
 */
export function operationsForTag(spec, tag) {
  const out = [];
  const paths = spec?.paths || {};
  Object.entries(paths).forEach(([path, pathItem]) => {
    if (!pathItem || typeof pathItem !== 'object') {
      return;
    }
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') {
        return;
      }
      const tags = Array.isArray(op.tags) ? op.tags : [];
      if (!tags.includes(tag)) {
        return;
      }
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        operation: op,
        responseSchema(status) {
          const responses = op.responses || {};
          const r = responses[String(status)];
          return r?.content?.['application/json']?.schema;
        },
      });
    });
  });
  return out;
}
