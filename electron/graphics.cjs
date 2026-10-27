function configureGraphics(commandLine, platform = process.platform, env = process.env) {
  if (platform !== 'linux') return;
  const ozone = commandLine.getSwitchValue('ozone-platform');
  const wayland = ozone === 'wayland' || ((!ozone || ozone === 'auto') &&
    (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)));
  if (!wayland) return;
  // Chromium's Wayland surface factory cannot initialize Vulkan. Keep native
  // Wayland and GPU acceleration, but exclude this incompatible backend.
  const disabled = new Set(commandLine.getSwitchValue('disable-features').split(',').filter(Boolean));
  disabled.add('Vulkan');
  commandLine.appendSwitch('disable-features', [...disabled].join(','));
  // WebGPU's Vulkan/GL interop initializes Vulkan even when that feature is
  // disabled. Select its OpenGL ES adapter to avoid the separate Vulkan probe.
  commandLine.appendSwitch('use-webgpu-adapter', 'opengles');
}

module.exports = { configureGraphics };
