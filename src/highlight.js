import core from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import lisp from 'highlight.js/lib/languages/lisp';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import nix from 'highlight.js/lib/languages/nix';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const highlighter = core.newInstance();
for (const [name, grammar] of Object.entries({ bash, c, cpp, css, diff, go, ini, java, javascript, json, lisp, lua, markdown, nix, python, ruby, rust, sql, typescript, xml, yaml })) {
  highlighter.registerLanguage(name, grammar);
}
highlighter.registerAliases(['emacs-lisp', 'elisp'], { languageName: 'lisp' });
highlighter.registerAliases(['shell', 'shell-script'], { languageName: 'bash' });

export const MAX_HIGHLIGHT_BLOCK_LENGTH = 50_000;
export const MAX_HIGHLIGHT_DOCUMENT_LENGTH = 200_000;

// Highlight only declared, bundled languages. Bound work during each live render.
// Null tells the renderer to use its normal escaped plain-text output.
export function createCodeHighlighter() {
  let remaining = MAX_HIGHLIGHT_DOCUMENT_LENGTH;
  return (source, language = '') => {
    const name = language.toLowerCase();
    if (!source || source.length > MAX_HIGHLIGHT_BLOCK_LENGTH || source.length > remaining || !highlighter.getLanguage(name)) return null;
    remaining -= source.length;
    try {
      return highlighter.highlight(source, { language: name, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  };
}
