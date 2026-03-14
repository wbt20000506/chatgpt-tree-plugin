const STORAGE_KEYS = {
  apiKey: "apiKey",
  apiType: "apiType",
  customEndpoint: "customEndpoint",
  selectedModel: "selectedModel",
  legacyGeminiApiKey: "cgpt_tree_gemini_api_key"
};

const API_TYPES = Object.freeze({
  OPENAI: "openai",
  GEMINI: "gemini",
  CLAUDE: "claude",
  DEEPSEEK: "deepseek",
  MIMO: "mimo",
  CUSTOM: "custom"
});

const DEFAULT_API_TYPE = API_TYPES.GEMINI;
const DEFAULT_ENDPOINTS = Object.freeze({
  [API_TYPES.OPENAI]: "https://api.openai.com/v1/chat/completions",
  [API_TYPES.GEMINI]: "https://generativelanguage.googleapis.com/v1beta",
  [API_TYPES.CLAUDE]: "https://api.anthropic.com/v1/messages",
  [API_TYPES.DEEPSEEK]: "https://api.deepseek.com/v1/chat/completions",
  [API_TYPES.MIMO]: "https://api.xiaomimimo.com/anthropic/v1/messages"
});

const MODEL_CANDIDATES = Object.freeze({
  [API_TYPES.OPENAI]: ["gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-4.1-mini"],
  [API_TYPES.GEMINI]: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"],
  [API_TYPES.CLAUDE]: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"],
  [API_TYPES.DEEPSEEK]: ["deepseek-chat", "deepseek-reasoner"],
  [API_TYPES.MIMO]: ["mimo-v2-flash", "mimo-v2-pro"],
  [API_TYPES.CUSTOM]: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini", "deepseek-chat"]
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setTitle({
    title: "ChatGPT Tree Panel"
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === "cgpt-tree:ping") {
    sendResponse({
      ok: true,
      source: "background",
      timestamp: Date.now()
    });
    return;
  }

  if (message.type === "cgpt-tree:call-ai") {
    void callAI(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("ChatGPT Tree Panel: AI request failed", error);
        sendResponse({
          ok: false,
          reason: "request_failed",
          message: error instanceof Error ? error.message : String(error || "")
        });
      });
    return true;
  }

  if (message.type === "cgpt-tree:validate-api") {
    void validateApi(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("ChatGPT Tree Panel: API validation failed", error);
        sendResponse({
          ok: false,
          available: false,
          reason: "network_error",
          message: error instanceof Error ? error.message : String(error || ""),
          fallback: "hard_algorithm"
        });
      });
    return true;
  }
});

async function callAI(payload) {
  const config = await loadApiConfig();
  if (!config.apiKey) {
    return {
      ok: false,
      reason: "missing_api_key",
      fallback: "hard_algorithm"
    };
  }

  if (config.apiType === API_TYPES.CUSTOM && !config.endpoint) {
    return {
      ok: false,
      reason: "missing_custom_endpoint",
      fallback: "hard_algorithm"
    };
  }

  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return {
      ok: false,
      reason: "empty_prompt",
      fallback: "hard_algorithm"
    };
  }

  const attemptResult = await callProviderWithFallbackModels(config, prompt);
  return attemptResult;
}

async function validateApi(payload) {
  const config = normalizeRuntimeConfig(payload);
  if (!config.apiKey) {
    return {
      ok: false,
      available: false,
      reason: "missing_api_key",
      fallback: "hard_algorithm"
    };
  }

  if (config.apiType === API_TYPES.CUSTOM && !config.endpoint) {
    return {
      ok: false,
      available: false,
      reason: "missing_custom_endpoint",
      fallback: "hard_algorithm"
    };
  }

  const result = await callProviderWithFallbackModels(config, "请只回复ok");
  return {
    ...result,
    available: Boolean(result?.ok)
  };
}

async function loadApiConfig() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const rawApiType = typeof stored[STORAGE_KEYS.apiType] === "string" ? stored[STORAGE_KEYS.apiType].trim() : "";
  const apiType = Object.values(API_TYPES).includes(rawApiType) ? rawApiType : DEFAULT_API_TYPE;
  const apiKey = resolveApiKey(stored).trim();
  const customEndpoint = typeof stored[STORAGE_KEYS.customEndpoint] === "string"
    ? stored[STORAGE_KEYS.customEndpoint].trim()
    : "";
  const selectedModel = typeof stored[STORAGE_KEYS.selectedModel] === "string"
    ? stored[STORAGE_KEYS.selectedModel].trim()
    : "";

  return {
    apiType,
    apiKey,
    endpoint: apiType === API_TYPES.CUSTOM ? customEndpoint : DEFAULT_ENDPOINTS[apiType],
    selectedModel
  };
}

function normalizeRuntimeConfig(input) {
  const rawApiType = typeof input?.apiType === "string" ? input.apiType.trim() : "";
  const apiType = Object.values(API_TYPES).includes(rawApiType) ? rawApiType : DEFAULT_API_TYPE;
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const customEndpoint = typeof input?.customEndpoint === "string" ? input.customEndpoint.trim() : "";
  const selectedModel = typeof input?.selectedModel === "string" ? input.selectedModel.trim() : "";

  return {
    apiType,
    apiKey,
    endpoint: apiType === API_TYPES.CUSTOM ? customEndpoint : DEFAULT_ENDPOINTS[apiType],
    selectedModel
  };
}

function resolveApiKey(stored) {
  const currentApiKey = typeof stored[STORAGE_KEYS.apiKey] === "string" ? stored[STORAGE_KEYS.apiKey] : "";
  if (currentApiKey.trim()) {
    return currentApiKey;
  }
  const legacyApiKey = typeof stored[STORAGE_KEYS.legacyGeminiApiKey] === "string"
    ? stored[STORAGE_KEYS.legacyGeminiApiKey]
    : "";
  return legacyApiKey;
}

const FAST_MODELS = Object.freeze({
  [API_TYPES.OPENAI]: ["gpt-5-mini", "gpt-4.1-mini"],
  [API_TYPES.GEMINI]: ["gemini-2.5-flash", "gemini-2.0-flash"],
  [API_TYPES.CLAUDE]: ["claude-3-5-haiku-20241022"],
  [API_TYPES.DEEPSEEK]: ["deepseek-chat"],
  [API_TYPES.MIMO]: ["mimo-v2-flash"],
  [API_TYPES.CUSTOM]: ["gpt-5-mini", "gpt-4.1-mini"]
});

async function callProviderWithFallbackModels(config, prompt) {
  const preferredModels = config.selectedModel
    ? [config.selectedModel]
    : (FAST_MODELS[config.apiType] || FAST_MODELS[API_TYPES.OPENAI]);
  const fallbackModels = MODEL_CANDIDATES[config.apiType] || MODEL_CANDIDATES[API_TYPES.OPENAI];
  const modelsToTry = Array.from(new Set(preferredModels.concat(fallbackModels).filter(Boolean)));

  let lastFailure = null;
  for (const model of modelsToTry) {
    const result = await callProvider(config, prompt, model);
    if (result.ok) {
      return {
        ...result,
        model
      };
    }
    lastFailure = result;
    if (!shouldTryNextModel(result)) {
      break;
    }
  }

  return lastFailure || {
    ok: false,
    reason: "unknown_error",
    fallback: "hard_algorithm"
  };
}

function shouldTryNextModel(result) {
  if (!result || result.ok) {
    return false;
  }

  if (result.reason !== "http_error") {
    return false;
  }

  const message = String(result.message || "").toLowerCase();
  return result.status === 404
    || result.status === 400
    || message.includes("model")
    || message.includes("not found")
    || message.includes("does not exist");
}

async function callProvider(config, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const request = buildProviderRequest(config, prompt, model);
    const response = await fetch(request.url, {
      ...request.options,
      signal: controller.signal
    });

    if (!response.ok) {
      const responseText = await safeReadText(response);
      return {
        ok: false,
        reason: "http_error",
        status: response.status,
        message: responseText.slice(0, 400),
        fallback: "hard_algorithm"
      };
    }

    const data = await response.json();
    const text = extractProviderText(config.apiType, data);
    if (!text) {
      return {
        ok: false,
        reason: "empty_response",
        fallback: "hard_algorithm"
      };
    }

    return {
      ok: true,
      text
    };
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        ok: false,
        reason: "timeout",
        message: "Request timed out after 15 seconds",
        fallback: "hard_algorithm"
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: error instanceof Error ? error.message : String(error || ""),
      fallback: "hard_algorithm"
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProviderRequest(config, prompt, model) {
  switch (config.apiType) {
    case API_TYPES.OPENAI:
    case API_TYPES.CUSTOM:
      return buildOpenAICompatibleRequest(config, prompt, model);
    case API_TYPES.DEEPSEEK:
      return buildDeepSeekRequest(config, prompt, model);
    case API_TYPES.GEMINI:
      return buildGeminiRequest(config, prompt, model);
    case API_TYPES.CLAUDE:
      return buildClaudeRequest(config, prompt, model);
    case API_TYPES.MIMO:
      return buildMiMoRequest(config, prompt, model);
    default:
      throw new Error("Unsupported apiType: " + config.apiType);
  }
}

function buildOpenAICompatibleRequest(config, prompt, model) {
  const resolvedModel = String(model || config.selectedModel || "gpt-5-mini").trim() || "gpt-5-mini";
  const body = {
    model: resolvedModel,
    messages: [
      {
        role: "system",
        content: "你是对话树结构分析器，只输出 JSON。"
      },
      {
        role: "user",
        content: prompt
      }
    ],
    response_format: {
      type: "json_object"
    }
  };

  // OpenAI's newer reasoning-capable chat models prefer max_completion_tokens.
  if (config.apiType === API_TYPES.OPENAI && prefersMaxCompletionTokens(resolvedModel)) {
    body.max_completion_tokens = 1024;
  } else {
    body.max_tokens = 1024;
  }

  if (!isStrictReasoningModel(resolvedModel)) {
    body.temperature = 0.1;
  }

  return {
    url: config.endpoint,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify(body)
    }
  };
}

function buildDeepSeekRequest(config, prompt, model) {
  const resolvedModel = String(model || config.selectedModel || "deepseek-chat").trim() || "deepseek-chat";
  const body = {
    model: resolvedModel,
    max_tokens: resolvedModel === "deepseek-reasoner" ? 2048 : 1024,
    response_format: {
      type: "json_object"
    },
    messages: [
      {
        role: "system",
        content: "你是对话树结构分析器，只输出 JSON。"
      },
      {
        role: "user",
        content: prompt
      }
    ]
  };

  // DeepSeek's reasoning model does not support temperature/top_p style controls.
  if (resolvedModel !== "deepseek-reasoner") {
    body.temperature = 0.1;
  }

  return {
    url: config.endpoint,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify(body)
    }
  };
}

function buildGeminiRequest(config, prompt, model) {
  const resolvedModel = String(model || config.selectedModel || "gemini-2.5-flash").trim() || "gemini-2.5-flash";
  const endpoint = String(config.endpoint || DEFAULT_ENDPOINTS[API_TYPES.GEMINI]).trim().replace(/\/+$/, "");
  const url = /:generateContent$/.test(endpoint)
    ? endpoint
    : endpoint + "/models/" + encodeURIComponent(resolvedModel) + ":generateContent";

  return {
    url,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topK: 1,
          topP: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: "application/json"
        }
      })
    }
  };
}

function buildClaudeRequest(config, prompt, model) {
  const resolvedModel = String(model || config.selectedModel || "claude-sonnet-4-20250514").trim() || "claude-sonnet-4-20250514";
  return {
    url: config.endpoint,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 1024,
        temperature: 0.1,
        system: "你是对话树结构分析器，只输出 JSON。",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  };
}

function buildMiMoRequest(config, prompt, model) {
  // MiMo API 使用 api-key header（不是 x-api-key），格式类似 Claude
  const resolvedModel = String(model || config.selectedModel || "mimo-v2-flash").trim() || "mimo-v2-flash";
  return {
    url: config.endpoint,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 1024,
        temperature: 0.3,
        top_p: 0.95,
        stream: false,
        system: "你是对话树结构分析器，只输出 JSON。今天是 " + new Date().toLocaleDateString() + "。",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              }
            ]
          }
        ]
      })
    }
  };
}

function prefersMaxCompletionTokens(model) {
  return /^gpt-5(\b|[-.])/.test(model) || /^o[134]\b/.test(model);
}

function isStrictReasoningModel(model) {
  return model === "deepseek-reasoner" || model === "gpt-5-pro";
}

function extractProviderText(apiType, data) {
  switch (apiType) {
    case API_TYPES.OPENAI:
    case API_TYPES.DEEPSEEK:
    case API_TYPES.CUSTOM:
      return extractOpenAICompatibleText(data);
    case API_TYPES.GEMINI:
      return extractGeminiText(data);
    case API_TYPES.CLAUDE:
      return extractClaudeText(data);
    case API_TYPES.MIMO:
      return extractMiMoText(data);
    default:
      return "";
  }
}

function extractOpenAICompatibleText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item?.text === "string" ? item.text : "")
      .join("\n")
      .trim();
  }
  return "";
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("\n")
    .trim();
}

function extractClaudeText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  return content
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("\n")
    .trim();
}

function extractMiMoText(data) {
  // MiMo API 返回格式类似 Claude，使用 content 数组
  const content = Array.isArray(data?.content) ? data.content : [];
  return content
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("\n")
    .trim();
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "";
  }
}
