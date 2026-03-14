"use strict";

const STORAGE_KEYS = {
  apiKey: "apiKey",
  apiType: "apiType",
  customEndpoint: "customEndpoint",
  selectedModel: "selectedModel",
  apiAvailable: "apiAvailable",
  legacyGeminiApiKey: "cgpt_tree_gemini_api_key"
};

const API_META = Object.freeze({
  openai: {
    keyLabel: "OpenAI API Key",
    keyPlaceholder: "请输入 OpenAI API Key",
    hint: "推荐模型：gpt-5.2 或 gpt-5-mini，也兼容 gpt-4.1 系列。"
  },
  gemini: {
    keyLabel: "Gemini API Key",
    keyPlaceholder: "请输入 Gemini API Key",
    hint: "推荐模型：gemini-2.5-flash，可手动填写其他 Gemini 模型。"
  },
  claude: {
    keyLabel: "Claude API Key",
    keyPlaceholder: "请输入 Claude API Key",
    hint: "推荐模型：claude-sonnet-4-20250514，也兼容 claude-3-7-sonnet-20250219。"
  },
  deepseek: {
    keyLabel: "DeepSeek API Key",
    keyPlaceholder: "请输入 DeepSeek API Key",
    hint: "推荐模型：deepseek-chat；如需推理模式可填写 deepseek-reasoner。"
  },
  mimo: {
    keyLabel: "MiMo API Key",
    keyPlaceholder: "请输入 MiMo API Key",
    hint: "使用小米 MiMo API 进行语义分析，端点：api.xiaomimimo.com。"
  },
  custom: {
    keyLabel: "自定义 API Key",
    keyPlaceholder: "请输入自定义服务 API Key",
    hint: "自定义接口需兼容 OpenAI Chat Completions 格式。"
  }
});

const DEFAULTS = Object.freeze({
  apiType: "gemini",
  apiKey: "",
  customEndpoint: "",
  selectedModel: ""
});

const apiTypeSelect = document.getElementById("api-type");
const modelInput = document.getElementById("model-input");
const apiKeyLabel = document.getElementById("api-key-label");
const apiKeyInput = document.getElementById("api-key");
const toggleApiKeyButton = document.getElementById("toggle-api-key");
const customEndpointField = document.getElementById("custom-endpoint-field");
const customEndpointInput = document.getElementById("custom-endpoint");
const hintEl = document.getElementById("hint");
const saveButton = document.getElementById("save");
const clearButton = document.getElementById("clear");
const statusEl = document.getElementById("status");
let persistTimer = null;

boot();

async function boot() {
  apiTypeSelect.addEventListener("change", handleApiTypeChange);
  apiTypeSelect.addEventListener("change", schedulePersistSettings);
  modelInput.addEventListener("input", schedulePersistSettings);
  apiKeyInput.addEventListener("input", schedulePersistSettings);
  customEndpointInput.addEventListener("input", schedulePersistSettings);
  toggleApiKeyButton.addEventListener("click", toggleApiKeyVisibility);
  saveButton.addEventListener("click", saveSettings);
  clearButton.addEventListener("click", clearSettings);
  await loadSettings();
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    const apiType = normalizeApiType(stored[STORAGE_KEYS.apiType]);
    const apiKey = resolveApiKey(stored);
    const customEndpoint = typeof stored[STORAGE_KEYS.customEndpoint] === "string"
      ? stored[STORAGE_KEYS.customEndpoint]
      : DEFAULTS.customEndpoint;
    const selectedModel = typeof stored[STORAGE_KEYS.selectedModel] === "string"
      ? stored[STORAGE_KEYS.selectedModel]
      : DEFAULTS.selectedModel;
    const apiAvailable = Boolean(stored[STORAGE_KEYS.apiAvailable]);

    apiTypeSelect.value = apiType;
    modelInput.value = selectedModel;
    apiKeyInput.value = apiKey;
    customEndpointInput.value = customEndpoint;
    syncApiTypeUI(apiType);

    if (apiKey && apiAvailable) {
      setStatus("已读取已保存的接口配置，API可用", "success");
    } else if (apiKey) {
      setStatus("已读取已保存的接口配置，请按保存重新验证", "warning");
    } else {
      setStatus("当前未配置 API Key，将使用硬算法", "warning");
    }
  } catch (error) {
    setStatus("读取设置失败", "error");
    console.warn("ChatGPT Tree Panel: failed to load API settings", error);
  }
}

async function saveSettings() {
  const apiType = normalizeApiType(apiTypeSelect.value);
  const apiKey = apiKeyInput.value.trim();
  const customEndpoint = customEndpointInput.value.trim();
  const selectedModel = modelInput.value.trim();

  if (apiType === "custom" && !customEndpoint) {
    setStatus("自定义兼容端点不能为空", "error");
    customEndpointInput.focus();
    return;
  }

  let validationTone = "success";
  let validationMessage = "已保存";
  let validation = { ok: false };

  try {
    if (apiKey) {
      setBusy(true);
      setStatus("正在验证 API 可用性...", "warning");
      validation = await validateApiConfig({
        apiType,
        apiKey,
        customEndpoint,
        selectedModel
      });

      if (validation.ok) {
        validationMessage = "已保存，API可用";
      } else {
        validationTone = "warning";
        validationMessage = "已保存，API不可用，将使用硬算法";
      }
    } else {
      validationMessage = "已保存，未填写API Key，将使用硬算法";
      validationTone = "warning";
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.apiType]: apiType,
      [STORAGE_KEYS.apiKey]: apiKey,
      [STORAGE_KEYS.customEndpoint]: customEndpoint,
      [STORAGE_KEYS.selectedModel]: selectedModel,
      [STORAGE_KEYS.apiAvailable]: Boolean(validation?.ok),
      [STORAGE_KEYS.legacyGeminiApiKey]: ""
    });

    setStatus(validationMessage, validationTone);
  } catch (error) {
    setStatus("保存设置失败", "error");
    console.warn("ChatGPT Tree Panel: failed to save API settings", error);
  } finally {
    setBusy(false);
  }
}

async function clearSettings() {
  apiKeyInput.value = "";
  customEndpointInput.value = "";
  modelInput.value = "";
  if (apiKeyInput.type !== "password") {
    apiKeyInput.type = "password";
    toggleApiKeyButton.classList.remove("is-visible");
    toggleApiKeyButton.setAttribute("aria-label", "显示 API Key");
    toggleApiKeyButton.setAttribute("title", "显示 API Key");
  }
  await persistSettings();
  setStatus("已清空 API 配置，重新排序将使用硬算法", "warning");
}

function handleApiTypeChange() {
  const apiType = normalizeApiType(apiTypeSelect.value);
  modelInput.value = "";
  apiKeyInput.value = "";
  if (apiKeyInput.type !== "password") {
    apiKeyInput.type = "password";
    toggleApiKeyButton.classList.remove("is-visible");
    toggleApiKeyButton.setAttribute("aria-label", "显示 API Key");
    toggleApiKeyButton.setAttribute("title", "显示 API Key");
  }
  syncApiTypeUI(apiType);
  setStatus("已切换模型类型，并清空模型名与 API Key，请重新填写后保存验证", "warning");
}

function toggleApiKeyVisibility() {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  toggleApiKeyButton.classList.toggle("is-visible", isHidden);
  toggleApiKeyButton.setAttribute("aria-label", isHidden ? "隐藏 API Key" : "显示 API Key");
  toggleApiKeyButton.setAttribute("title", isHidden ? "隐藏 API Key" : "显示 API Key");
}

function schedulePersistSettings() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    void persistSettings();
  }, 180);
}

async function persistSettings() {
  const apiType = normalizeApiType(apiTypeSelect.value);
  const apiKey = apiKeyInput.value.trim();
  const customEndpoint = customEndpointInput.value.trim();
  const selectedModel = modelInput.value.trim();

  await chrome.storage.local.set({
    [STORAGE_KEYS.apiType]: apiType,
    [STORAGE_KEYS.apiKey]: apiKey,
    [STORAGE_KEYS.customEndpoint]: customEndpoint,
    [STORAGE_KEYS.selectedModel]: selectedModel,
    [STORAGE_KEYS.apiAvailable]: false,
    [STORAGE_KEYS.legacyGeminiApiKey]: ""
  });

  setStatus(apiKey || selectedModel || customEndpoint ? "已自动保存当前配置，请按保存验证接口" : "当前未配置 API Key，将使用硬算法", apiKey ? "warning" : "warning");
}

function validateApiConfig(config) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "cgpt-tree:validate-api",
      payload: config
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("ChatGPT Tree Panel: API validation message failed", chrome.runtime.lastError);
        resolve({
          ok: false,
          available: false,
          reason: "runtime_error"
        });
        return;
      }
      resolve(response || {
        ok: false,
        available: false,
        reason: "empty_response"
      });
    });
  });
}

function syncApiTypeUI(apiType) {
  const meta = API_META[apiType] || API_META[DEFAULTS.apiType];
  apiKeyLabel.textContent = meta.keyLabel;
  apiKeyInput.placeholder = meta.keyPlaceholder;
  hintEl.textContent = meta.hint + " 未设置 API Key 时会自动回退到硬算法。";
  customEndpointField.classList.toggle("hidden", apiType !== "custom");
}

function normalizeApiType(value) {
  return Object.prototype.hasOwnProperty.call(API_META, value) ? value : DEFAULTS.apiType;
}

function resolveApiKey(stored) {
  const apiKey = typeof stored[STORAGE_KEYS.apiKey] === "string" ? stored[STORAGE_KEYS.apiKey].trim() : "";
  if (apiKey) {
    return apiKey;
  }
  const legacyGeminiKey = typeof stored[STORAGE_KEYS.legacyGeminiApiKey] === "string"
    ? stored[STORAGE_KEYS.legacyGeminiApiKey].trim()
    : "";
  return legacyGeminiKey;
}

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  apiTypeSelect.disabled = isBusy;
  modelInput.disabled = isBusy;
  apiKeyInput.disabled = isBusy;
  toggleApiKeyButton.disabled = isBusy;
  customEndpointInput.disabled = isBusy;
}

function setStatus(text, tone) {
  statusEl.textContent = text;
  statusEl.className = "status" + (tone ? " " + tone : "");
}
