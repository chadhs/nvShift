const { resolveLocalPath } = require('./local-paths.cjs');
const { documentFormat } = require('./formats.cjs');

function resolveDocumentLink(documentPath, value, options) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error('Invalid document link.');
  let target = value, fragment = null;
  const orgSearch = target.indexOf('::');
  if (orgSearch !== -1) {
    const search = target.slice(orgSearch + 2); target = target.slice(0, orgSearch);
    if (search.startsWith('#')) fragment = { kind: 'anchor', value: search.slice(1) };
    else if (search.startsWith('*')) fragment = { kind: 'heading', value: search.replace(/^\*+\s*/, '') };
    else throw new Error('Only heading and custom-ID link targets are supported.');
  } else {
    const hash = target.indexOf('#');
    if (hash !== -1) { fragment = { kind: 'anchor', value: target.slice(hash + 1) }; target = target.slice(0, hash); }
  }
  const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
  if (fragment) fragment.value = decode(fragment.value);
  const file = resolveLocalPath(documentPath, target, options);
  if (!documentFormat(file)) throw new Error('Links can open only .txt, .org, .md, or .markdown notes.');
  return { file, fragment };
}

module.exports = { resolveDocumentLink };
