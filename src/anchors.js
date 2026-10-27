export function resolveAnchor(parsed, target) {
  if (target.kind === 'heading') return parsed.outline.find((heading) => heading.label === target.value)?.id;
  // Structured cloning a worker result does not preserve null prototypes.
  const anchor = Object.hasOwn(parsed.anchors ?? {}, target.value) ? parsed.anchors[target.value] : undefined;
  return anchor ?? parsed.outline.find((heading) => heading.id === target.value)?.id;
}
