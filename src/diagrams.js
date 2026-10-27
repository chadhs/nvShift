export async function loadDiagrams(container, diagrams, doc, render, isCurrent, onChange) {
  const theme = document.documentElement.dataset.theme;
  for (const diagram of diagrams) {
    if (!isCurrent()) return;
    const slot = container.querySelector(`[data-diagram-id="${diagram.id}"]`);
    if (!slot) continue;
    const resultImage = diagram.resultStart === undefined ? null
      : container.querySelector(`[data-image-start="${diagram.resultStart}"]`);
    const output = slot.querySelector('.diagram-output');
    const details = slot.querySelector('details');
    try {
      const result = await render(doc.id, doc.revision, diagram, theme);
      if (!isCurrent()) return;
      if (result.error) throw new Error(result.error);
      const image = new Image();
      image.alt = 'Mermaid diagram. Diagram text is available in Show source.';
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`;
      await image.decode();
      if (!isCurrent()) return;
      output.replaceChildren(image);
      slot.dataset.rendered = 'true';
      if (!slot.dataset.initialRender) details.open = false;
      slot.dataset.initialRender = 'true';
      if (resultImage) resultImage.hidden = true;
    } catch (error) {
      if (!isCurrent()) return;
      output.textContent = `Diagram unavailable: ${error.message}`;
      slot.dataset.rendered = 'false';
      details.open = true;
      if (resultImage) resultImage.hidden = false;
    }
    onChange();
  }
}
