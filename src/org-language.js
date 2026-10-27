/** Original, deliberately bounded Org source highlighting for nvShift. BSD-3-Clause. */
import { StreamLanguage } from '@codemirror/language';

export const orgStreamParser = {
  name: 'org',
  startState: () => ({ block: null, heading: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol()) {
      state.heading = false;
      if (stream.match(/^\s*#\+end_\w+\b/i)) { state.block = null; stream.skipToEnd(); return 'meta'; }
      if (state.block) { stream.skipToEnd(); return 'string'; }
      const start = stream.match(/^\s*#\+begin_(\w+)\b/i);
      if (start) { state.block = start[1].toLowerCase(); stream.skipToEnd(); return 'meta'; }
      if (stream.match(/^\*+\s+/)) { state.heading = true; return 'heading'; }
      if (stream.match(/^\s*#\+[\w-]+(?:\[\])?:/)) { stream.skipToEnd(); return 'meta'; }
      if (stream.match(/^\s*#(?:\s|$)/)) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/^\s*:[\w_]+:/)) { stream.skipToEnd(); return 'meta'; }
      if (stream.match(/^(?:[ \t]*(?:[-+]|\d+[.)])|[ \t]+\*)[ \t]+/)) return 'list';
      if (stream.match(/^\s*\|/)) { stream.skipToEnd(); return 'punctuation'; }
      if (stream.match(/^\s*(?:SCHEDULED|DEADLINE|CLOSED):/)) return 'keyword';
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^(?:TODO|DONE|NEXT|WAITING|CANCELLED)\b/)) return 'keyword';
    if (stream.match(/^\[#[A-Z]\]/)) return 'atom';
    if (stream.match(/^\[(?: |X|x|-)\]/)) return 'atom';
    if (stream.match(/^\[\[[^\]\n]*(?:\]\[[^\]\n]*)?\]\]/)) return 'link';
    if (stream.match(/^(?:https?:\/\/|mailto:)[^\s\])]+/)) return 'link';
    if (stream.match(/^(?:<\d{4}-\d{2}-\d{2}[^>]*>|\[\d{4}-\d{2}-\d{2}[^\]]*\])/)) return 'atom';
    if (stream.match(/^\*[^*\s](?:[^*\n]*[^*\s])?\*(?=\s|[.,;:!?)]|$)/)) return 'strong';
    if (stream.match(/^\/[^/\s](?:[^/\n]*[^/\s])?\/(?=\s|[.,;:!?)]|$)/)) return 'emphasis';
    if (stream.match(/^_[^_\s](?:[^_\n]*[^_\s])?_(?=\s|[.,;:!?)]|$)/)) return 'emphasis';
    if (stream.match(/^[=~][^=~\n]+[=~]/)) return 'monospace';
    if (stream.match(/^\+[^+\s](?:[^+\n]*[^+\s])?\+(?=\s|[.,;:!?)]|$)/)) return 'strikethrough';
    if (stream.match(/^:[\w@#%:]+:(?=\s*$)/)) return 'tag';
    stream.next();
    return state.heading ? 'heading' : null;
  },
  languageData: { commentTokens: { line: '# ' } },
};

export const orgLanguage = StreamLanguage.define(orgStreamParser);
