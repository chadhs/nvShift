// Shared with the browser bundle; keep this module free of Node APIs.
const isDriveAbsolute = (value) => /^[a-z]:[\\/]/i.test(value);
const hasScheme = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value);
const isNetworkOrDevicePath = (value) => /^[\\/]{2}/.test(value) || /^\\\?\?\\/.test(value);
module.exports = { isDriveAbsolute, hasScheme, isNetworkOrDevicePath };
