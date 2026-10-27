const MAX_IMAGE_LINKS = 100;
const DOCUMENT_EXTENSIONS = ['org', 'md', 'markdown', 'txt'];
function documentFormat(file, txtSyntax = 'plain') {
  if (typeof file !== 'string') return null;
  const extension = /\.([^./\\]+)$/.exec(file)?.[1].toLowerCase();
  return extension === 'org' ? 'org' : ['md', 'markdown'].includes(extension) ? 'markdown'
    : extension === 'txt' ? (['plain', 'markdown', 'org'].includes(txtSyntax) ? txtSyntax : 'plain') : null;
}
const documentTitle = (name) => name.replace(/\.(?:org|md|markdown|txt)$/i, '');
module.exports = { MAX_IMAGE_LINKS, DOCUMENT_EXTENSIONS, documentFormat, documentTitle };
