(async function () {
  "use strict";

  const titleEl = document.getElementById("conversation-title");
  const badgeEl = document.getElementById("status-badge");
  const messageEl = document.getElementById("status-message");
  const enableButton = document.getElementById("enable-button");
  const refreshButton = document.getElementById("refresh-button");
  const SUPPORTED_TAB_RE = /^https:\/\/(chatgpt\.com|gemini\.google\.com)\//i;

  enableButton.addEventListener("click", async () => {
    enableButton.disabled = true;
    await updateStatus("open");
    enableButton.disabled = false;
  });

  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    await updateStatus();
    refreshButton.disabled = false;
  });

  await updateStatus();

  async function updateStatus(mode) {
    const tab = await getCurrentTab();
    if (!tab?.id || !SUPPORTED_TAB_RE.test(tab.url || "")) {
      setStatus({
        title: "未打开支持的对话页面",
        badge: "未检测到对话",
        message: "请先打开 chatgpt.com 或 gemini.google.com 的对话页面，再查看关闭状态。",
        enable: false,
        closed: false
      });
      return;
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: mode ? "cgpt-tree-set-conversation-status" : "cgpt-tree-get-conversation-status",
        mode
      });
    } catch (error) {
      setStatus({
        title: "未检测到对话树脚本",
        badge: "不可用",
        message: "当前页面还没有加载到对话树扩展，请刷新页面后再试。",
        enable: false,
        closed: false
      });
      return;
    }

    const closed = Boolean(response?.closed);
    const permanentClosed = Boolean(response?.permanentClosed);
    const title = response?.title
      ? response.title.replace(/\s+/g, " ").trim()
      : "当前对话";
    setStatus({
      title,
      badge: closed ? "此对话被关闭" : "此对话开启中",
      message: !response?.closable
        ? "这个页面不是一个已保存的对话，暂时不能单独关闭。"
        : closed
          ? permanentClosed
            ? "这个对话已被永久关闭，可在这里重新开启。"
            : "这个对话在本次访问中已关闭，下次重新进入会自动恢复。"
          : "这个对话当前正常显示对话树面板。",
      enable: closed,
      closed
    });
  }

  function setStatus(options) {
    titleEl.textContent = options.title;
    badgeEl.textContent = options.badge;
    badgeEl.classList.toggle("is-closed", Boolean(options.closed));
    badgeEl.classList.toggle("is-open", !options.closed);
    messageEl.textContent = options.message;
    enableButton.hidden = !options.enable;
  }

  async function getCurrentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }
})();
