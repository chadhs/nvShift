import pathSyntax from './path-syntax.cjs';
const { isDriveAbsolute, hasScheme } = pathSyntax;
// Org inline images are links without a description.
export function orgImageTarget(reference) {
  if (typeof reference !== 'string' || reference.length > 8192) return null;
  const match = reference.match(/^\[\[([^\]\r\n]+)\]\]$/);
  if (!match) return null;
  const target = match[1];
  if (/^https?:\/\//i.test(target)) {
    try {
      return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(new URL(target).pathname) ? target : null;
    } catch { return null; }
  }
  const local = target.replace(/^file:/i, '');
  if ((hasScheme(local) && !isDriveAbsolute(local)) || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(local)) return null;
  return target;
}
