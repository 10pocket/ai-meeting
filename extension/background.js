// アイコンを押したタブ (= いま表示しているタブ) を録画対象にして、録画ページを別タブで開く。
// getMediaStreamId はユーザー操作 (このクリック) の直後にしか呼べない。
chrome.action.onClicked.addListener(async tab => {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const q = new URLSearchParams({ streamId, title: tab.title || tab.url || '' });
  chrome.tabs.create({ url: chrome.runtime.getURL('recorder.html?' + q) });
});
