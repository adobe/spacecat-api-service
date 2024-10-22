/**
 * This fixture is a pre-bundled import.js transformation file which replaces the content of any
 * page that it processes with "Importer as a Service - custom import.js test content".
 */
var CustomImportScript = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../tools/importer/import-full-replacement.js
  var import_full_replacement_exports = {};
  __export(import_full_replacement_exports, {
    default: () => import_full_replacement_default
  });
  var import_full_replacement_default = {
    transformDOM: ({
      // eslint-disable-next-line no-unused-vars
      document,
      url,
      html,
      params
    }) => {
      const main = document.body;
      main.innerText = "Importer as a Service - custom import.js test content";
      return main;
    },
    generateDocumentPath: ({
      // eslint-disable-next-line no-unused-vars
      document,
      url,
      html,
      params
    }) => {
      let p = new URL(url).pathname;
      if (p.endsWith("/")) {
        p = `${p}index`;
      }
      return decodeURIComponent(p).toLowerCase().replace(/\.html$/, "").replace(/[^a-z0-9/]/gm, "-");
    }
  };
  return __toCommonJS(import_full_replacement_exports);
})();
