const CustomImportScript = (() => {
  const __defProp = Object.defineProperty;
  const __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  const __getOwnPropNames = Object.getOwnPropertyNames;
  const __hasOwnProp = Object.prototype.hasOwnProperty;
  const __export = (target, all) => {
    for (const name in all) __defProp(target, name, { get: all[name], enumerable: true });
  };
  const __copyProps = (to, from, except, desc) => {
    if (from && typeof from === 'object' || typeof from === 'function') {
      for (const key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  const __toCommonJS = (mod) => __copyProps(__defProp({}, '__esModule', { value: true }), mod);

  // default.import.js
  const default_import_exports = {};
  __export(default_import_exports, {
    default: () => default_import_default,
  });
  var default_import_default = {
    transformDOM: ({
      // eslint-disable-next-line no-unused-vars
      document,
      url,
      html,
      params,
    }) => {
      const main = document.body;
      WebImporter.DOMUtils.remove(main, [
        'header',
        '.header',
        'nav',
        '.nav',
        'footer',
        '.footer',
        'iframe',
        'noscript',
      ]);
      WebImporter.rules.createMetadata(main, document);
      WebImporter.rules.transformBackgroundImages(main, document);
      WebImporter.rules.adjustImageUrls(main, url, params.originalURL);
      WebImporter.rules.convertIcons(main, document);
      return main;
    },
    generateDocumentPath: ({
      // eslint-disable-next-line no-unused-vars
      document,
      url,
      html,
      params,
    }) => {
      let p = new URL(url).pathname;
      if (p.endsWith('/')) {
        p = `${p}index`;
      }
      return decodeURIComponent(p).toLowerCase().replace(/\.html$/, '').replace(/[^a-z0-9/]/gm, '-');
    },
  };
  return __toCommonJS(default_import_exports);
})();
