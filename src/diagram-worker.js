import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

const palettes = {
  light: ['#fcfbf8', '#30332f', '#eeede6', '#a35032'],
  dark: ['#202523', '#e2e4db', '#2a312d', '#dfa383'],
  'solarized-light': ['#fdf6e3', '#586e75', '#eee8d5', '#268bd2'],
  'solarized-dark': ['#002b36', '#93a1a1', '#073642', '#268bd2'],
};
window.diagramWorker.onRender(async ({ source, theme, requestId }) => {
  const stage = document.querySelector('#stage');
  try {
    // Configuration belongs to the viewer. Reject document configuration rather
    // than letting frontmatter or directives change layout/security settings.
    if (/%%\s*\{|^\s*---/m.test(source)) throw new Error('Mermaid configuration directives and frontmatter are not supported.');
    const [background, textColor, primaryColor, accent] = palettes[theme] ?? palettes.light;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
      maxTextSize: 20000, maxEdges: 200, suppressErrorRendering: true,
      htmlLabels: false, flowchart: { htmlLabels: false },
      fontFamily: 'Arial, sans-serif', theme: 'base',
      themeVariables: { background, primaryColor, primaryTextColor: textColor,
        primaryBorderColor: accent, lineColor: textColor, textColor, edgeLabelBackground: primaryColor,
        secondaryColor: background, tertiaryColor: primaryColor,
        darkMode: theme.endsWith('dark') },
    });
    const { svg } = await mermaid.render(`diagram-${requestId}`, source, stage);
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'image', 'a', 'script', 'animate', 'set'],
      FORBID_ATTR: ['href', 'xlink:href'],
    });
    window.diagramWorker.complete({ requestId, svg: clean });
  } catch (error) {
    window.diagramWorker.complete({ requestId, error: String(error.message || 'Invalid Mermaid diagram.').slice(0, 500) });
  } finally { stage.replaceChildren(); }
});
