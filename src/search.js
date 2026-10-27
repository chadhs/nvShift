// Keep search inside the document and support matches spanning inline formatting.
export function createSearch(root, scroller, report) {
  let ranges = [];
  let query = '';
  let active = -1;
  function clear() {
    CSS.highlights.delete('search-results');
    CSS.highlights.delete('search-active');
    ranges = []; active = -1; query = '';
    report('');
  }
  function search(value, forward = true, rebuild = false, scroll = true) {
    if (!value) { clear(); return; }
    const previousActive = value === query ? active : -1;
    if (value !== query || rebuild) {
      clear(); query = value;
      const walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement.closest('.eyebrow, #metadata, .document-end, details:not([open]) pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const nodes = [];
      let text = '', node;
      while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.textContent; }
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'giu');
      let match;
      while ((match = pattern.exec(text)) && ranges.length < 1000) {
        const index = match.index;
        const needle = match[0];
        const start = nodes.findLast((item) => item.start <= index);
        const end = nodes.findLast((item) => item.start < index + needle.length);
        if (!start || !end) continue;
        const range = new Range();
        range.setStart(start.node, index - start.start);
        range.setEnd(end.node, index + needle.length - end.start);
        ranges.push(range);
      }
      CSS.highlights.set('search-results', new Highlight(...ranges));
    }
    if (!ranges.length) { report('0 matches'); return; }
    active = rebuild && previousActive >= 0 ? Math.min(previousActive, ranges.length - 1) : (active + (forward ? 1 : -1) + ranges.length) % ranges.length;
    CSS.highlights.set('search-active', new Highlight(ranges[active]));
    if (scroll) {
      const rect = ranges[active].getBoundingClientRect();
      scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
    }
    report(`${active + 1} / ${ranges.length}${ranges.length === 1000 ? '+' : ''}`);
  }
  return { search, clear, snapshot: () => ({ query, active }), restore(state) {
    clear();
    if (!state?.query) return;
    search(state.query, true, true, false);
    active = Math.max(0, Math.min(state.active ?? 0, ranges.length - 1));
    search(state.query, true, true, false);
  } };
}
