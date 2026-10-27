const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { isDriveAbsolute, hasScheme, isNetworkOrDevicePath } = require('./path-syntax.cjs');

function assertLocalPath(file, platform = process.platform) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid local file path.');
  if (isNetworkOrDevicePath(file)) throw new Error('Network-share and device paths are not supported. Choose a local file.');
  if (hasScheme(file) && !isDriveAbsolute(file)) throw new Error('Only local file paths are supported; drive-relative paths are not supported.');
  if (isDriveAbsolute(file) && platform !== 'win32') throw new Error('Windows drive paths require Windows.');
  // Windows interprets colons after the drive as alternate data streams.
  if (platform === 'win32' && file.slice(isDriveAbsolute(file) ? 2 : 0).includes(':')) throw new Error('Device and alternate-stream paths are not supported.');
  if (platform === 'win32' && file.split(/[\\/]/).some((part) => /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:[ .]|$)/i.test(part))) {
    throw new Error('Windows device names are not supported. Choose a local file.');
  }
  return file;
}

function localFileURL(value, platform = process.platform) {
  const url = new URL(value);
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) throw new Error('Only local file URLs are supported.');
  return assertLocalPath(fileURLToPath(url, { windows: platform === 'win32' }), platform);
}

function resolveLocalPath(documentPath, target, { platform = process.platform, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (/^file:\/\//i.test(target)) return localFileURL(target, platform);
  let local = target.replace(/^file:/i, '');
  try { local = decodeURIComponent(local); } catch { /* Preserve literal percent signs. */ }
  assertLocalPath(local, platform);
  const file = /^~[\\/]/.test(local) ? paths.join(home, local.slice(2)) : paths.resolve(paths.dirname(documentPath), local);
  return assertLocalPath(file, platform);
}

module.exports = { assertLocalPath, localFileURL, resolveLocalPath };
