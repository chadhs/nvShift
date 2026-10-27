const TITLEBAR_HEIGHT = 64;
const colors = {
  light: { color: '#f5f4ef', symbolColor: '#30332f' },
  dark: { color: '#1b201e', symbolColor: '#e2e4db' },
  'solarized-light': { color: '#eee8d5', symbolColor: '#657b83' },
  'solarized-dark': { color: '#073642', symbolColor: '#839496' },
};

function titlebarOptions(platform = process.platform) {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 25 }, titleBarOverlay: true }
      : { titleBarOverlay: { ...colors.light, height: TITLEBAR_HEIGHT } }),
  };
}

function updateTitlebar(window, theme, platform = process.platform) {
  if (!Object.hasOwn(colors, theme)) throw new Error('Invalid window theme.');
  window.setBackgroundColor(colors[theme].color);
  if (platform !== 'darwin') window.setTitleBarOverlay({ ...colors[theme], height: TITLEBAR_HEIGHT });
}

module.exports = { titlebarOptions, updateTitlebar, TITLEBAR_HEIGHT };
