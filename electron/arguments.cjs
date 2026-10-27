const { localFileURL } = require('./local-paths.cjs');

// Keep unsupported paths so the reader can explain why they cannot be opened.
function documentArguments(argv, packaged) {
  const args = argv.slice(1);
  if (!packaged) {
    // Electron can move Chromium flags before the app path in second-instance argv.
    const appIndex = args.findIndex((arg) => !arg.startsWith('-'));
    if (appIndex !== -1) args.splice(appIndex, 1);
  }
  const separator = args.indexOf('--');
  const argumentsToOpen = separator !== -1 ? args.slice(separator + 1) : args.filter((arg) => !arg.startsWith('-'));
  return argumentsToOpen.map((argument) => {
    if (/^file:/i.test(argument)) {
      try { return localFileURL(argument); } catch { /* File validation reports invalid input. */ }
    }
    return argument;
  });
}
const documentArgument = (argv, packaged) => documentArguments(argv, packaged)[0];
module.exports = { documentArgument, documentArguments };
