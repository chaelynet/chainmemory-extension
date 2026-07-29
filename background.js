// ChainMemory v3.0.5 — background service worker

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Abrir el faucet al instalar (como v2.1.0)
    chrome.tabs.create({ url: 'https://faucet.chainmemory.ai' });
  } else if (details.reason === 'update') {
    console.log('ChainMemory updated to', chrome.runtime.getManifest().version);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openPopup') {
    if (chrome.action && chrome.action.openPopup) {
      try { chrome.action.openPopup(); } catch (e) {}
    }
  }
  return true;
});
