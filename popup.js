(async function () {
  "use strict";

  const titleEl = document.getElementById("conversation-title");
  const badgeEl = document.getElementById("status-badge");
  const messageEl = document.getElementById("status-message");
  const enableButton = document.getElementById("enable-button");
  const refreshButton = document.getElementById("refresh-button");
  const copyDebugLogButton = document.getElementById("copy-debug-log-button");
  const themeButtons = Array.from(document.querySelectorAll("[data-theme-value]"));
  const SUPPORTED_TAB_RE = /^https:\/\/(chatgpt\.com|gemini\.google\.com)\//i;
  const THEME_STORAGE_KEY = "cgpt_tree_theme_preference_v1";
  const contentCore = globalThis.CGPTTreeContentCore || null;
  const themeMediaQuery = getThemeMediaQuery();

  enableButton.addEventListener("click", async () => {
    await runWithButtonFeedback(enableButton, "开启中...", () => updateStatus("open"));
  });

  refreshButton.addEventListener("click", async () => {
    await runWithButtonFeedback(refreshButton, "重新检测中...", () => updateStatus());
  });

  copyDebugLogButton.addEventListener("click", async () => {
    await runWithButtonFeedback(copyDebugLogButton, "复制中...", copyDebugLog);
  });

  themeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      await setThemePreference(button.getAttribute("data-theme-value"));
    });
  });

  if (themeMediaQuery?.addEventListener) {
    themeMediaQuery.addEventListener("change", handleSystemThemeChange);
  } else if (themeMediaQuery?.addListener) {
    themeMediaQuery.addListener(handleSystemThemeChange);
  }

  await loadThemePreference();
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

  async function loadThemePreference() {
    const preference = normalizeThemePreference(await readStoredThemePreference());
    updateThemeButtons(preference);
  }

  async function setThemePreference(preference) {
    const normalizedPreference = normalizeThemePreference(preference);
    updateThemeButtons(normalizedPreference);
    await writeStoredThemePreference(normalizedPreference);
    await notifyCurrentTabThemeChanged(normalizedPreference);
  }

  async function readStoredThemePreference() {
    const storageArea = globalThis.chrome?.storage?.local;
    if (storageArea?.get) {
      try {
        const result = await storageArea.get(THEME_STORAGE_KEY);
        return result?.[THEME_STORAGE_KEY];
      } catch (error) {
        console.warn("ChatGPT Tree Panel: failed to read theme preference", error);
      }
    }
    try {
      return localStorage.getItem(THEME_STORAGE_KEY);
    } catch (error) {
      return "system";
    }
  }

  async function writeStoredThemePreference(preference) {
    const storageArea = globalThis.chrome?.storage?.local;
    if (storageArea?.set) {
      await storageArea.set({
        [THEME_STORAGE_KEY]: normalizeThemePreference(preference)
      });
      return;
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, normalizeThemePreference(preference));
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to write theme preference", error);
    }
  }

  async function notifyCurrentTabThemeChanged(preference) {
    const tab = await getCurrentTab();
    if (!tab?.id || !SUPPORTED_TAB_RE.test(tab.url || "")) {
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "cgpt-tree-theme-preference-changed",
        preference: normalizeThemePreference(preference)
      });
    } catch (error) {
      // The storage update is enough for the next page load; this message is only for instant refresh.
    }
  }

  function updateThemeButtons(preference) {
    const normalizedPreference = normalizeThemePreference(preference);
    const resolvedTheme = resolveThemeName(normalizedPreference, systemPrefersDark());
    document.body.setAttribute("data-theme-preference", normalizedPreference);
    document.body.setAttribute("data-theme", resolvedTheme);
    themeButtons.forEach((button) => {
      const selected = button.getAttribute("data-theme-value") === normalizedPreference;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function handleSystemThemeChange() {
    if (document.body.getAttribute("data-theme-preference") === "system") {
      updateThemeButtons("system");
    }
  }

  function normalizeThemePreference(value) {
    if (contentCore?.normalizeThemePreference) {
      return contentCore.normalizeThemePreference(value);
    }
    const normalized = String(value || "system").trim().toLowerCase();
    return normalized === "light" || normalized === "dark" || normalized === "system"
      ? normalized
      : "system";
  }

  function resolveThemeName(preference, prefersDark) {
    if (contentCore?.resolveThemeName) {
      return contentCore.resolveThemeName(preference, prefersDark);
    }
    const normalizedPreference = normalizeThemePreference(preference);
    if (normalizedPreference === "light" || normalizedPreference === "dark") {
      return normalizedPreference;
    }
    return prefersDark ? "dark" : "light";
  }

  function getThemeMediaQuery() {
    if (typeof window.matchMedia !== "function") {
      return null;
    }
    try {
      return window.matchMedia("(prefers-color-scheme: dark)");
    } catch (error) {
      return null;
    }
  }

  function systemPrefersDark() {
    return Boolean(themeMediaQuery?.matches);
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

  async function copyDebugLog() {
    const tab = await getCurrentTab();
    if (!tab?.id || !SUPPORTED_TAB_RE.test(tab.url || "")) {
      await copyText(buildPopupDebugText({
        reason: "unsupported_tab",
        tabUrl: tab?.url || "",
        title: tab?.title || ""
      }));
      messageEl.textContent = "当前不是支持的对话页面，已复制弹窗诊断信息。";
      return;
    }

    let response = await requestDebugLog(tab.id);
    if (!response?.ok) {
      const injected = await ensureContentScriptInjected(tab.id);
      if (injected) {
        response = await requestDebugLog(tab.id);
      }
    }

    const text = response?.text || buildPopupDebugText({
      reason: "content_script_unavailable",
      tabUrl: tab.url || "",
      title: tab.title || ""
    });
    await copyText(text);
    messageEl.textContent = response?.ok
      ? "脱敏调试日志已复制，可以直接粘贴给开发者排查。"
      : "页面脚本未响应，已复制弹窗诊断信息。";
  }

  async function requestDebugLog(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "cgpt-tree-get-debug-log"
      });
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error)
      };
    }
  }

  async function copyText(text) {
    const value = String(text || "");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function buildPopupDebugText(details) {
    return [
      "AI Conversation Tree Popup Debug",
      "Generated: " + new Date().toISOString(),
      JSON.stringify({
        details,
        userAgent: navigator.userAgent || ""
      }, null, 2)
    ].join("\n");
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
        files: ["content-core.js", "hard-algorithm.js", "content.js"]
      });
      return true;
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to inject scripts", error);
      return false;
    }
  }
})();
