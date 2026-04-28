(function (globalScope) {
  "use strict";

  const LOG_LEVELS = Object.freeze({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
  });

  function createDebugLogger(options = {}) {
    const source = String(options.source || "runtime");
    const maxEntries = Math.max(1, Math.min(1000, Number(options.maxEntries) || 300));
    let consoleEnabled = Boolean(options.consoleEnabled);
    let consoleLevel = normalizeLogLevel(options.consoleLevel || "warn");
    const entries = [];

    const logger = {
      debug: (event, payload) => pushLog("debug", event, payload),
      info: (event, payload) => pushLog("info", event, payload),
      warn: (event, payload) => pushLog("warn", event, payload),
      error: (event, payload) => pushLog("error", event, payload),
      clear,
      exportText,
      getEntries: () => entries.slice(),
      setConsoleEnabled: (enabled) => {
        consoleEnabled = Boolean(enabled);
      },
      setConsoleLevel: (level) => {
        consoleLevel = normalizeLogLevel(level);
      }
    };

    function pushLog(level, event, payload) {
      const normalizedLevel = normalizeLogLevel(level);
      const entry = {
        ts: new Date().toISOString(),
        level: normalizedLevel,
        source,
        event: String(event || "log"),
        payload: sanitizeLogPayload(payload)
      };
      entries.push(entry);
      while (entries.length > maxEntries) {
        entries.shift();
      }
      if (consoleEnabled && LOG_LEVELS[normalizedLevel] >= LOG_LEVELS[consoleLevel]) {
        const method = normalizedLevel === "debug" ? "log" : normalizedLevel;
        const consoleMethod = typeof console?.[method] === "function" ? console[method] : console.log;
        consoleMethod.call(console, "[CGPT-TREE][" + source + "][" + normalizedLevel + "] " + entry.event, entry.payload);
      }
      return entry;
    }

    function clear() {
      entries.length = 0;
    }

    function exportText(context = {}) {
      const redact = Boolean(context.redact);
      const diagnostics = redact
        ? redactLogPayload(sanitizeLogPayload(context.diagnostics || {}))
        : sanitizeLogPayload(context.diagnostics || {});
      const lines = [
        "AI Conversation Tree Debug Log",
        "Generated: " + new Date().toISOString(),
        "Source: " + source,
        redact ? "Redacted: true" : "Redacted: false",
        "",
        "Diagnostics:",
        stableJsonStringify(diagnostics),
        "",
        "Logs:"
      ];
      for (const entry of entries) {
        const payload = redact ? redactLogPayload(entry.payload) : entry.payload;
        lines.push("[" + entry.ts + "] " + entry.level.toUpperCase() + " " + entry.source + ":" + entry.event + " " + stableJsonStringify(payload));
      }
      return lines.join("\n");
    }

    return logger;
  }

  function createSingleAttributeMarker(attributeName) {
    const attr = String(attributeName || "").trim();
    let currentElement = null;

    return {
      clear,
      getCurrent: () => currentElement,
      mark
    };

    function mark(element, value = "true") {
      if (!attr) {
        return;
      }
      if (currentElement && currentElement !== element && typeof currentElement.removeAttribute === "function") {
        currentElement.removeAttribute(attr);
      }
      currentElement = element || null;
      if (currentElement && typeof currentElement.setAttribute === "function") {
        currentElement.setAttribute(attr, String(value));
      }
    }

    function clear() {
      if (currentElement && typeof currentElement.removeAttribute === "function") {
        currentElement.removeAttribute(attr);
      }
      currentElement = null;
    }
  }

  function serializeTreeForStorage(tree) {
    const source = tree && typeof tree === "object" ? tree : {};
    const output = {
      rootId: source.rootId || "root",
      version: Number.isFinite(source.version) ? source.version : 0,
      panelCollapsed: Boolean(source.panelCollapsed),
      panelPosition: normalizePanelPosition(source.panelPosition),
      searchQuery: typeof source.searchQuery === "string" ? source.searchQuery : "",
      linearSortEnabled: Boolean(source.linearSortEnabled),
      ignoredPromptIndices: normalizeIntegerArray(source.ignoredPromptIndices),
      ignoredSignatures: normalizeStringArray(source.ignoredSignatures),
      ignoredTitles: normalizeStringArray(source.ignoredTitles),
      nodes: {}
    };

    for (const [id, rawNode] of Object.entries(source.nodes || {})) {
      const node = rawNode && typeof rawNode === "object" ? rawNode : {};
      output.nodes[id] = {
        id,
        parentId: node.parentId ?? (id === output.rootId ? null : output.rootId),
        children: Array.isArray(node.children) ? node.children.filter(Boolean) : [],
        title: typeof node.title === "string" ? node.title : "",
        signature: typeof node.signature === "string" ? node.signature : id,
        askedAt: Number(node.askedAt) || 0,
        createdAt: Number(node.createdAt) || 0,
        collapsed: Boolean(node.collapsed),
        promptIndex: Number.isFinite(node.promptIndex) ? node.promptIndex : 0
      };
    }

    if (!output.nodes[output.rootId]) {
      output.nodes[output.rootId] = {
        id: output.rootId,
        parentId: null,
        children: [],
        title: "对话",
        signature: "root",
        askedAt: 0,
        createdAt: 0,
        collapsed: false,
        promptIndex: -1
      };
    }
    output.nodes[output.rootId].parentId = null;
    return output;
  }

  function hasPersistedVolatileTreeData(input) {
    for (const node of Object.values(input?.nodes || {})) {
      if (!node || typeof node !== "object") {
        continue;
      }
      if (typeof node.answer === "string" && node.answer) {
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(node, "updatedAt") || Object.prototype.hasOwnProperty.call(node, "lastSeenAt")) {
        return true;
      }
    }
    return false;
  }

  function normalizeLogLevel(level) {
    const value = String(level || "info").toLowerCase();
    return Object.prototype.hasOwnProperty.call(LOG_LEVELS, value) ? value : "info";
  }

  function sanitizeLogPayload(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: typeof value.stack === "string" ? value.stack.split("\n").slice(0, 8).join("\n") : ""
      };
    }
    if (typeof value !== "object") {
      return String(value);
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (depth >= 4) {
      return "[MaxDepth]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 60).map((item) => sanitizeLogPayload(item, depth + 1, seen));
    }
    if (value instanceof Map) {
      return sanitizeLogPayload(Object.fromEntries(Array.from(value.entries()).slice(0, 60)), depth + 1, seen);
    }
    if (value instanceof Set) {
      return sanitizeLogPayload(Array.from(value.values()).slice(0, 60), depth + 1, seen);
    }
    if (typeof Element !== "undefined" && value instanceof Element) {
      return {
        tagName: value.tagName,
        id: value.id || "",
        className: typeof value.className === "string" ? value.className.slice(0, 120) : ""
      };
    }

    const output = {};
    for (const key of Object.keys(value).slice(0, 80)) {
      output[key] = sanitizeLogPayload(value[key], depth + 1, seen);
    }
    return output;
  }

  function redactLogPayload(value, key = "") {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return redactStringValue(key, value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactLogPayload(item, key));
    }
    if (typeof value !== "object") {
      return String(value);
    }

    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactLogPayload(entryValue, entryKey);
    }
    return output;
  }

  function redactStringValue(key, value) {
    const normalizedKey = String(key || "").toLowerCase();
    if (!value) {
      return value;
    }
    if (["href", "url", "taburl"].includes(normalizedKey)) {
      return redactUrl(value);
    }
    if (["chatkey", "conversationid"].includes(normalizedKey)) {
      return summarizeSensitiveString("redacted-id", value);
    }
    if (["title", "text", "fulltext", "matchedpoint", "searchquery", "signature", "answersignature"].includes(normalizedKey)) {
      return summarizeSensitiveString("redacted-text", value);
    }
    if (normalizedKey === "useragent") {
      return "[redacted-user-agent]";
    }
    return value;
  }

  function redactUrl(value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      if (!parts.length) {
        return url.origin + "/";
      }
      return url.origin + "/" + parts[0] + "/[redacted]";
    } catch (error) {
      return summarizeSensitiveString("redacted-url", value);
    }
  }

  function summarizeSensitiveString(label, value) {
    const text = String(value || "");
    return "[" + label + ":len=" + text.length + ":hash=" + hashString(text) + "]";
  }

  function hashString(value) {
    const text = String(value || "");
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  function stableJsonStringify(value) {
    try {
      return JSON.stringify(sortJsonValue(value), null, 2);
    } catch (error) {
      return JSON.stringify({
        error: "failed_to_stringify",
        message: String(error?.message || error)
      }, null, 2);
    }
  }

  function sortJsonValue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Array.isArray(value) ? value.map(sortJsonValue) : value;
    }
    return Object.keys(value).sort().reduce((output, key) => {
      output[key] = sortJsonValue(value[key]);
      return output;
    }, {});
  }

  function normalizePanelPosition(input) {
    if (!input || typeof input !== "object") {
      return null;
    }
    const left = Number(input.left);
    const top = Number(input.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
    return {
      left: Math.max(0, Math.round(left)),
      top: Math.max(0, Math.round(top))
    };
  }

  function normalizeIntegerArray(input) {
    return Array.isArray(input)
      ? Array.from(new Set(input.filter((value) => Number.isInteger(value) && value >= 0)))
      : [];
  }

  function normalizeStringArray(input) {
    return Array.isArray(input)
      ? Array.from(new Set(input.filter((value) => typeof value === "string" && value.trim())))
      : [];
  }

  const api = {
    createDebugLogger,
    createSingleAttributeMarker,
    hasPersistedVolatileTreeData,
    serializeTreeForStorage
  };

  globalScope.CGPTTreeContentCore = Object.assign(globalScope.CGPTTreeContentCore || {}, api);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
