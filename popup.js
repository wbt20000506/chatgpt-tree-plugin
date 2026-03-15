(async function () {
  "use strict";

  const titleEl = document.getElementById("conversation-title");
  const badgeEl = document.getElementById("status-badge");
  const messageEl = document.getElementById("status-message");
  const enableButton = document.getElementById("enable-button");
  const refreshButton = document.getElementById("refresh-button");
  const SUPPORTED_TAB_RE = /^https:\/\/(chatgpt\.com|gemini\.google\.com)\//i;

  enableButton.addEventListener("click", async () => {
    await runWithButtonFeedback(enableButton, "开启中...", () => updateStatus("open"));
  });

  refreshButton.addEventListener("click", async () => {
    await runWithButtonFeedback(refreshButton, "重新检测中...", () => updateStatus());
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
      const injected = await ensureContentScriptInjected(tab.id);
      if (!injected) {
        setStatus({
          title: "未检测到对话树脚本",
          badge: "不可用",
          message: "当前页面还没有加载到对话树扩展，请刷新页面后再试。",
          enable: false,
          closed: false
        });
        return;
      }
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: mode ? "cgpt-tree-set-conversation-status" : "cgpt-tree-get-conversation-status",
          mode
        });
      } catch (secondError) {
        setStatus({
          title: "脚本注入失败",
          badge: "不可用",
          message: "已尝试重新注入对话树脚本，但当前页面仍未响应。请刷新页面后再试。",
          enable: false,
          closed: false
        });
        return;
      }
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

  async function runWithButtonFeedback(button, busyText, task) {
    const originalText = button.textContent;
    button.disabled = true;
    button.classList.add("is-busy");
    button.textContent = busyText;
    try {
      await task();
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.textContent = originalText;
    }
  }

  async function ensureContentScriptInjected(tabId) {
    if (!chrome.scripting?.executeScript || !chrome.scripting?.insertCSS) {
      return false;
    }
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"]
      });
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to inject CSS", error);
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["hard-algorithm.js", "content.js"]
      });
      return true;
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to inject scripts", error);
      return false;
    }
  }
})();
