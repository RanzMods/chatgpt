// Anti-Fingerprint background service worker.
// Keeps the extension alive / non-interfering. No network access needed.
try {
  const version = chrome.runtime.getManifest().version;
  console.debug(`[anti-fingerprint] loaded v${version}`);
} catch {}