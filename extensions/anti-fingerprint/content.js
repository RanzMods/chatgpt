(() => {
  'use strict';

  function def(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, {
        get: () => value,
        set: () => {},
        configurable: true,
      });
    } catch {}
  }

  // ---- navigator.webdriver (main automation flag) ----
  def(Navigator.prototype, 'webdriver', false);

  // ---- chrome.* object (missing in headless / automation builds) ----
  if (!window.chrome) {
    try {
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    } catch {}
  }
  if (!window.chrome.runtime) window.chrome.runtime = {};
  const chromeProto = Object.getPrototypeOf(window.chrome);
  def(chromeProto, 'loadTimes', () => ({}));
  def(chromeProto, 'csi', () => ({}));

  // ---- languages ----
  def(Navigator.prototype, 'language', 'en-US');
  def(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));

  // ---- platform / hardware / memory ----
  def(Navigator.prototype, 'platform', 'Win32');
  def(Navigator.prototype, 'hardwareConcurrency', 8);
  def(Navigator.prototype, 'deviceMemory', 8);
  def(Navigator.prototype, 'maxTouchPoints', 0);

  // ---- User-Agent Client Hints: strip HeadlessChrome brands ----
  const brands = [
    { brand: 'Chromium', version: '132' },
    { brand: 'Google Chrome', version: '132' },
    { brand: 'Not=A?Brand', version: '99' },
  ];
  Object.defineProperty(Navigator.prototype, 'userAgentData', {
    configurable: true,
    get() {
      return {
        brands: Object.freeze([...brands]),
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: 'x86',
          bitness: '64',
          brands: Object.freeze([...brands]),
          mobile: false,
          model: '',
          platform: 'Windows',
          platformVersion: '15.0.0',
          uaFullVersion: '132.0.6834.160',
          fullVersionList: Object.freeze([...brands]),
          wow64: false,
        }),
      };
    },
    set: () => {},
  });

  // ---- plugins / mimeTypes (non-automation profile) ----
  function fakeMime(type, desc, suffixes) {
    return { type, description: desc, suffixes, enabledPlugin: null };
  }
  function fakePlugin(name, filename, desc) {
    const obj = {
      name,
      filename,
      description: desc,
      length: 0,
      item: () => null,
      namedItem: () => null,
    };
    Object.defineProperty(obj, 'mimeTypes', { value: Object.freeze([]) });
    return obj;
  }
  Object.defineProperty(Navigator.prototype, 'plugins', {
    configurable: true,
    get: () =>
      Object.freeze([
        fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        fakePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
        fakePlugin('Chromium PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
      ]),
  });
  Object.defineProperty(Navigator.prototype, 'mimeTypes', {
    configurable: true,
    get: () =>
      Object.freeze([
        fakeMime('application/pdf', 'Portable Document Format', 'pdf'),
        fakeMime('text/pdf', 'Portable Document Format', 'pdf'),
      ]),
  });
  def(Navigator.prototype, 'pdfViewerEnabled', true);

  // ---- canvas readback: tiny per-draw noise so hashes differ across sessions ----
  const canvasProto = HTMLCanvasElement.prototype;
  const origToDataURL = canvasProto.toDataURL;
  canvasProto.toDataURL = function (...args) {
    try {
      if (this.width > 0 && this.height > 0) {
        const ctx = this.getContext('2d');
        const img = ctx && ctx.getImageData(0, 0, this.width, this.height);
        if (img) {
          const d = img.data;
          for (let i = 0; i < d.length; i += 64) {
            d[i] = (d[i] + 1) % 256;
          }
          ctx.putImageData(img, 0, 0);
        }
      }
    } catch {}
    return origToDataURL.apply(this, args);
  };

  // ---- WebGL: replace telltale vendor/renderer strings ----
  const VENDOR = 37445;
  const RENDERER = 37446;
  const rendererStr =
    'ANGLE (Google, Vulkan 1.3.0 (NVIDIA GeForce RTX 3060 (0x00002504)), OpenGL ES 3.0)';
  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === VENDOR) return 'Google Inc. (NVIDIA)';
      if (param === RENDERER) return rendererStr;
      return orig.apply(this, arguments);
    };
  };
  patchGL(WebGLRenderingContext.prototype);
  patchGL(WebGL2RenderingContext.prototype);
})();