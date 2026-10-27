import test from 'node:test';
import assert from 'node:assert/strict';
import { configureGraphics } from '../electron/graphics.cjs';

function configure(platform, env, initial = {}) {
  const switches = new Map(Object.entries(initial));
  configureGraphics({
    getSwitchValue: (name) => switches.get(name) || '',
    appendSwitch: (name, value) => switches.set(name, value),
  }, platform, env);
  return Object.fromEntries(switches);
}

test('Wayland avoids both Vulkan initialization paths and preserves other disabled features', () => {
  for (const [env, initial] of [
    [{}, { 'ozone-platform': 'wayland' }],
    [{ XDG_SESSION_TYPE: 'wayland' }, {}],
    [{ WAYLAND_DISPLAY: 'wayland-1' }, { 'ozone-platform': 'auto' }],
  ]) {
    const result = configure('linux', env, { ...initial, 'disable-features': 'ExistingFeature,Vulkan' });
    assert.equal(result['disable-features'], 'ExistingFeature,Vulkan');
    assert.equal(result['use-webgpu-adapter'], 'opengles');
    assert.equal(result['disable-gpu'], undefined);
    assert.equal(result['no-sandbox'], undefined);
  }
});

test('explicit X11, X11 sessions, macOS, and Windows retain their graphics settings', () => {
  const initial = { 'ozone-platform': 'x11', 'disable-features': 'ExistingFeature' };
  assert.deepEqual(configure('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1' }, initial), initial);
  assert.deepEqual(configure('linux', { XDG_SESSION_TYPE: 'x11' }), {});
  for (const platform of ['darwin', 'win32']) assert.deepEqual(configure(platform, { WAYLAND_DISPLAY: 'wayland-1' }), {});
});
