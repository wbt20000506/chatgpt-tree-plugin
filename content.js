(function () {
  "use strict";

  const RUNTIME_KEY = "__CGPT_TREE_RUNTIME__";
  const PANEL_ID = "cgpt-tree-panel";
  const CURRENT_ATTR = "data-cgpt-tree-current";
  const STORAGE_PREFIX = "cgpt_tree_state_v2:";
  const DISABLED_STORAGE_PREFIX = "cgpt_tree_disabled_v1:";
  const ROOT_PARENT_SIGNATURE = "__cgpt_tree_root__";
  const MAX_NODES = 180;
  const SCAN_DEBOUNCE_MS = 500;
  const SCAN_DEBOUNCE_MS_LARGE_TREE = 1200;
  // ChatGPT/Gemini often stream tokens continuously, which can keep a pure debounce
  // from ever firing. We throttle scans so new user turns appear promptly.
  const SCAN_THROTTLE_MS = 700;
  const SCAN_THROTTLE_MS_LARGE_TREE = 1200;
  const ACTIVE_DEBOUNCE_MS = 120;
  const SAVE_DEBOUNCE_MS = 180;
  const URL_POLL_MS = 900;
  const NODE_ROW_HEIGHT = 30;
  const NODE_INDENT = 26;
  const SCROLL_PADDING = 20;
  const GITHUB_COPILOT_TOP_BUFFER = 144;
  const TOP_OVERLAY_CACHE_TTL_MS = 1500;
  const ASSISTANT_MATCH_TEXT_MAX_CHARS = 4000;
  const SCROLL_CORRECTION_DELAY_MS = 180;
  const SCROLL_CORRECTION_MAX_ATTEMPTS = 2;
  const MANUAL_ACTIVE_NODE_HOLD_MS = 1600;
  const SITE_TYPE_CHATGPT = "chatgpt";
  const SITE_TYPE_GEMINI = "gemini";
  const SITE_TYPE_GITHUB_COPILOT = "github-copilot";
  const SITE_TYPE_UNKNOWN = "unknown";
  const EMPTY_TREE = Object.freeze({
    rootId: "root",
    panelCollapsed: false,
    panelPosition: null,
    searchQuery: "",
    linearSortEnabled: false,
    ignoredPromptIndices: [],
    ignoredSignatures: [],
    ignoredTitles: [],
    nodes: {
      root: {
        id: "root",
        parentId: null,
        children: [],
        title: "对话",
        answer: "",
        signature: "root",
        askedAt: 0,
        createdAt: 0,
        updatedAt: 0,
        collapsed: false,
        promptIndex: -1,
        lastSeenAt: 0
      }
    }
  });
  const hardAlgorithm = globalThis.CGPTTreeHardAlgorithm || null;
  const contentCore = globalThis.CGPTTreeContentCore || null;
  const logger = contentCore?.createDebugLogger
    ? contentCore.createDebugLogger({ source: "content", maxEntries: 500 })
    : null;
  const activeHighlightMarker = contentCore?.createSingleAttributeMarker
    ? contentCore.createSingleAttributeMarker(CURRENT_ATTR)
    : null;

  function debugLog(eventName, payload) {
    if (logger) {
      logger.debug(eventName, payload || {});
      return;
    }
    console.log("[CGPT-TREE]", eventName, payload || {});
  }

  const state = {
    chatKey: "",
    tree: null,
    activeNodeId: null,
    searchResults: [],
    searchIndex: -1,
    searchDraft: "",
    domNodeMap: new Map(),
    turnTextCache: new WeakMap(),
    assistantMarkdownCache: new WeakMap(),
    panel: null,
    body: null,
    searchInput: null,
    searchApplyButton: null,
    summary: null,
    resultBadge: null,
    toggleButton: null,
    undoButton: null,
    refreshButton: null,
    observer: null,
    urlTimer: null,
    scanTimer: null,
    scanDueAt: 0,
    saveTimer: null,
    activeTimer: null,
    scanInFlight: false,
    deferredScanDelay: null,
    deferredScanRequest: null,
    lastScanStartedAt: 0,
    renderedFingerprint: "",
    renderVersion: 0,
    treeStructureVersion: 0,
    lastScanFingerprint: "",
    lastSavedTreeFingerprint: "",
    needsStorageCompaction: false,
    highlightedPromptEl: null,
    topOverlayCache: {
      value: 0,
      measuredAt: 0,
      viewportWidth: 0
    },
    scanRequestId: 0,
    lastKnownUrl: location.href,
    exportFormat: "markdown",
    exportMarkdownMode: "with-answers",
    undoSnapshot: null,
    drag: {
      sourceId: null,
      jumpNodeId: null,
      targetId: null,
      invalidTargetId: null,
      pointerId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      dragging: false,
      ghostEl: null
    },
    panelDrag: {
      pointerId: null,
      startX: 0,
      startY: 0,
      originLeft: 0,
      originTop: 0,
      active: false
    },
    hoverTooltipEl: null,
    closeMenu: null,
    suppressClickUntil: 0,
    cleanupFns: [],
    suppressedTitleAttrs: [],
    suppressedSvgTitles: [],
    manualActiveNodeId: null,
    manualActiveUntil: 0,
    isConversationTemporarilyClosed: false,
    isConversationPermanentlyClosed: false,
    closeStateLoaded: false,
    workSuspended: false
  };

  const previousRuntime = globalThis[RUNTIME_KEY];
  if (previousRuntime && typeof previousRuntime.destroy === "function") {
    try {
      previousRuntime.destroy();
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to destroy previous runtime", error);
    }
  }

  globalThis[RUNTIME_KEY] = {
    destroy,
    diagnostics: () => ({
      href: location.href,
      siteType: state.siteType,
      chatKey: state.chatKey,
      workSuspended: state.workSuspended,
      isClosed: isConversationClosed(),
      hasObserver: Boolean(state.observer),
      hasPanel: Boolean(document.getElementById(PANEL_ID)),
      scanInFlight: state.scanInFlight,
      scanDueAt: state.scanDueAt || 0,
      lastScanStartedAt: state.lastScanStartedAt || 0,
      logCount: logger?.getEntries?.().length || 0
    })
  };

  boot();

  function isSupportedConversationRoute(siteType) {
    const path = String(location.pathname || "/");
    if (siteType === SITE_TYPE_CHATGPT) {
      return path === "/" || path.startsWith("/c/");
    }
    if (siteType === SITE_TYPE_GEMINI) {
      return path === "/app" || path.startsWith("/app/");
    }
    return false;
  }

  function removePanelUI() {
    document.querySelectorAll("#" + PANEL_ID + ", .cgpt-tree-hover-tooltip, .cgpt-tree-drag-ghost").forEach((node) => {
      if (node?.remove) {
        node.remove();
      }
    });
    clearActiveHighlight();
    state.panel = null;
    state.body = null;
    state.searchInput = null;
    state.searchApplyButton = null;
    state.summary = null;
    state.resultBadge = null;
    state.toggleButton = null;
    state.undoButton = null;
    state.refreshButton = null;
    state.closeMenu = null;
  }

  function boot() {
    resetScanState();
    removePanelUI();
    state.siteType = detectSiteType();
    state.chatKey = getChatKey();
    state.tree = loadTree();
    state.lastSavedTreeFingerprint = getPersistedTreeFingerprint(state.tree);
    logger?.info("boot", {
      href: location.href,
      siteType: state.siteType,
      chatKey: state.chatKey,
      supported: isSupportedConversationRoute(state.siteType)
    });
    bindRuntimeMessages();
    bindGlobalWatchers();
    void syncConversationClosedState();
    if (!isSupportedConversationRoute(state.siteType)) {
      setConversationWorkSuspended(true);
      logger?.info("boot-suspended-route", {
        href: location.href,
        siteType: state.siteType
      });
      return;
    }
    ensurePanel();
    setConversationWorkSuspended(false);
    scheduleScan(80);
  }

  function addCleanup(fn) {
    if (typeof fn === "function") {
      state.cleanupFns.push(fn);
    }
  }

  function destroy() {
    window.clearTimeout(state.scanTimer);
    window.clearTimeout(state.saveTimer);
    window.clearTimeout(state.activeTimer);
    window.clearInterval(state.urlTimer);
    state.scanTimer = null;
    state.saveTimer = null;
    state.activeTimer = null;
    state.urlTimer = null;
    resetScanState();

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    while (state.cleanupFns.length) {
      const fn = state.cleanupFns.pop();
      try {
        fn();
      } catch (error) {
        console.warn("ChatGPT Tree Panel: cleanup failed", error);
      }
    }

    if (state.drag.ghostEl?.isConnected) {
      state.drag.ghostEl.remove();
    }
    state.drag.ghostEl = null;

    if (state.hoverTooltipEl?.isConnected) {
      state.hoverTooltipEl.remove();
    }
    state.hoverTooltipEl = null;
    restoreSuppressedNativeTooltips();
    clearActiveHighlight();

    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.remove();
    }

    if (globalThis[RUNTIME_KEY]?.destroy === destroy) {
      delete globalThis[RUNTIME_KEY];
    }
  }

  function getChatKey() {
    if (contentCore?.getChatKeyFromLocation) {
      const key = contentCore.getChatKeyFromLocation(location);
      if (key === "chatgpt-new") {
        return key + "-" + Date.now();
      }
      return key;
    }
    const siteType = detectSiteType();
    const parts = (location.pathname || "/").split("/").filter(Boolean);
    if (siteType === SITE_TYPE_CHATGPT && parts[0] === "c" && parts[1]) {
      if (parts[1] === "new" || parts[1] === "c") {
        return "chatgpt-new-" + Date.now();
      }
      return parts[1];
    }
    if (siteType === SITE_TYPE_GEMINI) {
      if (parts[0] === "app" && parts[1]) {
        return "gemini-" + parts[1];
      }
      if (parts[0] === "u" && parts[2]) {
        return "gemini-" + parts[2];
      }
      return "gemini:" + [location.pathname || "/", location.search || "", location.hash || ""].join("");
    }
    if (siteType === SITE_TYPE_CHATGPT) {
      return "chatgpt-home";
    }
    const pathKey = [location.pathname || "/", location.search || "", location.hash || ""].join("");
    return siteType + ":" + (pathKey || "/");
  }

  function createTree() {
    const tree = JSON.parse(JSON.stringify(EMPTY_TREE));
    tree.version = 0;
    return tree;
  }

  function getStorageKey() {
    return STORAGE_PREFIX + state.chatKey;
  }

  function getPermanentCloseStorageKey(chatKey) {
    return DISABLED_STORAGE_PREFIX + (chatKey || state.chatKey || "unknown");
  }

  function shouldPersistTreeState() {
    return !/^chatgpt-(?:home|new)(?:-|$)/.test(String(state.chatKey || ""));
  }

  function loadTree() {
    state.needsStorageCompaction = false;
    if (!shouldPersistTreeState()) {
      return createTree();
    }
    try {
      const raw = window.localStorage.getItem(getStorageKey());
      if (!raw) {
        return createTree();
      }
      const parsed = JSON.parse(raw);
      const tree = normalizeTree(parsed);
      if (hasPersistedVolatileTreeData(parsed)) {
        state.needsStorageCompaction = true;
      }
      return tree;
    } catch (error) {
      logger?.warn("tree-load-failed", error);
      console.warn("ChatGPT Tree Panel: failed to load tree state", error);
      return createTree();
    }
  }

  function saveTree() {
    if (!shouldPersistTreeState()) {
      return;
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(flushTreeState, SAVE_DEBOUNCE_MS);
  }

  function flushTreeState() {
    if (!shouldPersistTreeState()) {
      return;
    }
    const persistedTree = serializeTreeForStorage(state.tree);
    const fingerprint = JSON.stringify(persistedTree);
    if (fingerprint === state.lastSavedTreeFingerprint && !state.needsStorageCompaction) {
      return;
    }
    try {
      window.localStorage.setItem(getStorageKey(), fingerprint);
      state.lastSavedTreeFingerprint = fingerprint;
      state.needsStorageCompaction = false;
    } catch (error) {
      logger?.warn("tree-save-failed", error);
      console.warn("ChatGPT Tree Panel: failed to save tree state", error);
    }
  }

  function getPersistedTreeFingerprint(tree) {
    return JSON.stringify(serializeTreeForStorage(tree));
  }

  function serializeTreeForStorage(tree) {
    if (contentCore?.serializeTreeForStorage) {
      return contentCore.serializeTreeForStorage(tree);
    }
    const output = JSON.parse(JSON.stringify(tree || createTree()));
    for (const node of Object.values(output.nodes || {})) {
      delete node.answer;
      delete node.updatedAt;
      delete node.lastSeenAt;
    }
    return output;
  }

  function hasPersistedVolatileTreeData(input) {
    if (contentCore?.hasPersistedVolatileTreeData) {
      return contentCore.hasPersistedVolatileTreeData(input);
    }
    return Object.values(input?.nodes || {}).some((node) => {
      return node && (
        (typeof node.answer === "string" && node.answer) ||
        Object.prototype.hasOwnProperty.call(node, "updatedAt") ||
        Object.prototype.hasOwnProperty.call(node, "lastSeenAt")
      );
    });
  }

  function normalizeTree(input) {
    const tree = createTree();
    tree.version = Number.isFinite(input?.version) ? input.version : 0;
    tree.panelCollapsed = Boolean(input && input.panelCollapsed);
    tree.panelPosition = normalizePanelPosition(input?.panelPosition);
    tree.searchQuery = typeof input?.searchQuery === "string" ? input.searchQuery : "";
    tree.linearSortEnabled = Boolean(input?.linearSortEnabled);
    tree.ignoredPromptIndices = Array.isArray(input?.ignoredPromptIndices)
      ? Array.from(new Set(input.ignoredPromptIndices.filter((value) => Number.isInteger(value) && value >= 0)))
      : [];
    tree.ignoredSignatures = Array.isArray(input?.ignoredSignatures)
      ? Array.from(new Set(input.ignoredSignatures.filter((value) => typeof value === "string" && value.trim())))
      : [];
    tree.ignoredTitles = Array.isArray(input?.ignoredTitles)
      ? Array.from(new Set(input.ignoredTitles.filter((value) => typeof value === "string" && value.trim())))
      : [];

    for (const [id, rawNode] of Object.entries(input?.nodes || {})) {
      tree.nodes[id] = {
        id,
        parentId: rawNode?.parentId ?? "root",
        children: Array.isArray(rawNode?.children) ? rawNode.children.filter(Boolean) : [],
        title: typeof rawNode?.title === "string" ? rawNode.title : "",
        answer: typeof rawNode?.answer === "string" ? rawNode.answer : "",
        signature: typeof rawNode?.signature === "string" ? rawNode.signature : id,
        askedAt: Number(rawNode?.askedAt) || 0,
        createdAt: Number(rawNode?.createdAt) || Date.now(),
        updatedAt: Number(rawNode?.updatedAt) || Date.now(),
        collapsed: Boolean(rawNode?.collapsed),
        promptIndex: Number.isFinite(rawNode?.promptIndex) ? rawNode.promptIndex : 0,
        lastSeenAt: Number(rawNode?.lastSeenAt) || 0
      };
    }

    if (!tree.nodes.root) {
      tree.nodes.root = createTree().nodes.root;
    }
    tree.nodes.root.parentId = null;
    rebuildChildren(tree);
    return tree;
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

  function rebuildChildren(tree) {
    for (const node of Object.values(tree.nodes)) {
      node.children = [];
    }

    const nodes = Object.values(tree.nodes)
      .filter((node) => node.id !== tree.rootId)
      .sort((a, b) => {
        // 先按时间顺序（promptIndex）排序，再按createdAt排序
        const aIndex = typeof a.promptIndex === "number" ? a.promptIndex : -1;
        const bIndex = typeof b.promptIndex === "number" ? b.promptIndex : -1;
        if (aIndex !== bIndex) {
          return aIndex - bIndex;
        }
        return (a.createdAt - b.createdAt) || a.id.localeCompare(b.id);
      });

    for (const node of nodes) {
      const parent = tree.nodes[node.parentId] || tree.nodes.root;
      node.parentId = parent.id;
      if (!parent.children.includes(node.id)) {
        parent.children.push(node.id);
      }
    }
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = PANEL_ID;
      panel.innerHTML = [
        '<div class="cgpt-tree-header">',
        '  <div class="cgpt-tree-header-top" data-role="panel-drag-handle">',
        '    <div class="cgpt-tree-title">',
        '      <div class="cgpt-tree-title-line"><strong>对话树</strong><span class="cgpt-tree-drag-hint">可拖动</span></div>',
        "    </div>",
        '    <div class="cgpt-tree-header-corner-actions">',
        '      <button type="button" class="cgpt-tree-toggle-button" data-role="toggle-close-menu">关闭</button>',
        '      <button type="button" class="cgpt-tree-toggle-button" data-role="linear-sort" title="将所有节点按时间线性排序（会清空层级关系）">线性排序</button>',
        '      <button type="button" class="cgpt-tree-toggle-button" data-role="toggle">折叠</button>',
        "    </div>",
        "  </div>",
        '  <span class="cgpt-tree-summary">等待检测对话...</span>',
        '  <div class="cgpt-tree-close-menu cgpt-tree-hidden" data-role="close-menu">',
        '    <div class="cgpt-tree-close-copy">关闭当前对话树面板</div>',
        '    <div class="cgpt-tree-close-actions">',
        '      <button type="button" data-role="close-session">本次对话关闭直到下次访问</button>',
        '      <button type="button" data-role="close-permanent">本次对话永久关闭</button>',
        '      <button type="button" data-role="cancel-close">取消</button>',
        "    </div>",
        '    <div class="cgpt-tree-close-hint">永久关闭后，可在插件设置页重新开启。</div>',
        "  </div>",
        '  <div class="cgpt-tree-header-actions">',
        '    <button type="button" class="cgpt-tree-parent-button" data-role="go-parent" title="将当前活跃节点提升一级，设为上级问题的同级">设为上级问题</button>',
        '    <button type="button" data-role="set-child" title="将当前活跃节点降一级，设为前一个同级问题的下级">设为下级问题</button>',
        '    <button type="button" data-role="set-root" title="将当前活跃节点设为根问题（切断与父节点的关联）">设为根问题</button>',
        '    <button type="button" data-role="focus-active" title="跳转到最新问题">最新问题</button>',
        "  </div>",
        "</div>",
        '<div class="cgpt-tree-toolbar">',
        '  <div class="cgpt-tree-toolbar-row cgpt-tree-toolbar-search-row">',
        '    <input type="search" class="cgpt-tree-search" data-role="search" placeholder="搜索问题标题" />',
        '    <button type="button" class="cgpt-tree-search-button" data-role="search-apply" title="搜索（Enter）" aria-label="搜索">搜索</button>',
        '    <button type="button" data-role="search-prev" title="上一个匹配">上一个</button>',
        '    <button type="button" data-role="search-next" title="下一个匹配">下一个</button>',
        "  </div>",
        '  <div class="cgpt-tree-toolbar-row cgpt-tree-toolbar-action-row">',
        '    <div class="cgpt-tree-toolbar-group cgpt-tree-export-group">',
        '      <div class="cgpt-tree-export-selects">',
        '        <select class="cgpt-tree-export-select" data-role="export-format" aria-label="导出格式">',
        '          <option value="markdown">Markdown</option>',
        '          <option value="png">PNG</option>',
        '          <option value="svg">SVG</option>',
        '          <option value="jpg">JPG</option>',
        "        </select>",
        '        <select class="cgpt-tree-export-select cgpt-tree-export-mode-select" data-role="export-markdown-mode" aria-label="导出内容">',
        '          <option value="with-answers">完整对话</option>',
        '          <option value="questions-only">仅问题</option>',
        "        </select>",
        "      </div>",
        '      <div class="cgpt-tree-export-actions">',
        '        <button type="button" class="cgpt-tree-export-button" data-role="export" title="导出当前对话树">导出</button>',
        '        <button type="button" class="cgpt-tree-delete-button" data-role="delete-node" title="永久忽略当前问题，后续功能都不再考虑它">删除问题</button>',
        "      </div>",
        "    </div>",
        "  </div>",
        "</div>",
        '<div class="cgpt-tree-status">',
        '  <span class="cgpt-tree-result-badge">0 个匹配</span>',
        '  <div class="cgpt-tree-status-actions">',
        '    <button type="button" data-role="undo" title="返回上一状态">上一状态</button>',
        '    <button type="button" data-role="refresh" title="清除上一次分析结果，并重新排列当前对话树">重新排序</button>',
        "  </div>",
        "</div>",
        '<div class="cgpt-tree-body"></div>',
      ].join("");
      document.documentElement.appendChild(panel);
    }

    state.panel = panel;
    state.body = panel.querySelector(".cgpt-tree-body");
    state.searchInput = panel.querySelector('[data-role="search"]');
    state.searchApplyButton = panel.querySelector('[data-role="search-apply"]');
    state.summary = panel.querySelector(".cgpt-tree-summary");
    state.resultBadge = panel.querySelector(".cgpt-tree-result-badge");
    state.toggleButton = panel.querySelector('[data-role="toggle"]');
    state.undoButton = panel.querySelector('[data-role="undo"]');
    state.refreshButton = panel.querySelector('[data-role="refresh"]');
    state.closeMenu = panel.querySelector('[data-role="close-menu"]');
    panel.querySelector('[data-role="export-format"]').value = state.exportFormat;
    panel.hidden = false;

    bindPanelEvents();
    state.searchInput.value = state.tree.searchQuery || "";
    state.searchDraft = state.searchInput.value || "";
    updateSearchResults(false);
    applyPanelState();
    updateExportModeOptions();
    updateUndoButtonState();
    renderTree();
  }

  function bindPanelEvents() {
    if (state.panel.dataset.bound === "true") {
      return;
    }
    state.panel.dataset.bound = "true";

    const bindClick = (role, handler) => {
      const element = state.panel.querySelector('[data-role="' + role + '"]');
      if (element) {
        element.addEventListener("click", handler);
      }
      return element;
    };

    const dragHandle = state.panel.querySelector('[data-role="panel-drag-handle"]');
    if (dragHandle) {
      dragHandle.addEventListener("pointerdown", beginPanelDrag);
    }

    bindClick("toggle", () => {
      state.tree.panelCollapsed = !state.tree.panelCollapsed;
      applyPanelState();
    });

    bindClick("toggle-close-menu", () => {
      state.closeMenu.classList.toggle("cgpt-tree-hidden");
    });

    bindClick("linear-sort", () => {
      linearSortNodesByTime();
    });

    bindClick("cancel-close", () => {
      state.closeMenu.classList.add("cgpt-tree-hidden");
    });

    bindClick("close-session", () => {
      void setConversationClosedMode("temporary");
    });

    bindClick("close-permanent", () => {
      void setConversationClosedMode("permanent");
    });

    bindClick("refresh", () => {
      refreshConversationAnalysis();
    });

    bindClick("undo", () => {
      restorePreviousState();
    });

    bindClick("focus-active", () => {
      const latestNodeId = getLatestNodeId();
      if (latestNodeId) {
        jumpToNode(latestNodeId);
      }
    });

    bindClick("go-parent", () => {
      promoteActiveNodeOneLevel();
    });

    bindClick("set-child", () => {
      demoteActiveNodeOneLevel();
    });

    bindClick("set-root", () => {
      setActiveNodeAsRoot();
    });

    bindClick("expand-all", () => {
      setAllCollapsed(false);
    });

    bindClick("collapse-all", () => {
      setAllCollapsed(true);
    });

    bindClick("search-next", () => {
      moveSearch(1);
    });

    bindClick("search-prev", () => {
      moveSearch(-1);
    });

    const applySearchDraft = (direction) => {
      const nextQuery = (state.searchDraft || "").trim();
      const currentQuery = String(state.tree.searchQuery || "");
      if (nextQuery !== currentQuery) {
        state.tree.searchQuery = nextQuery;
        updateSearchResults(true);
        saveTree();
        renderTree();
        return;
      }
      moveSearch(typeof direction === "number" ? direction : 1);
    };

    state.searchInput.addEventListener("input", () => {
      state.searchDraft = state.searchInput.value || "";
      updateResultBadge();
    });

    state.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      applySearchDraft(event.shiftKey ? -1 : 1);
    });

    bindClick("search-apply", () => {
      const pendingQuery = (state.searchDraft || "").trim();
      const appliedQuery = String(state.tree.searchQuery || "").trim();
      if (pendingQuery === appliedQuery && appliedQuery) {
        state.tree.searchQuery = "";
        state.searchDraft = "";
        state.searchInput.value = "";
        updateSearchResults(false);
        saveTree();
        renderTree();
        return;
      }
      applySearchDraft(1);
    });

    state.panel.querySelector('[data-role="export-format"]').addEventListener("change", (event) => {
      state.exportFormat = normalizeExportFormat(event.target.value);
      event.target.value = state.exportFormat;
      updateExportModeOptions();
    });

    state.panel.querySelector('[data-role="export-markdown-mode"]').addEventListener("change", (event) => {
      state.exportMarkdownMode = event.target.value === "questions-only" ? "questions-only" : "with-answers";
    });

    bindClick("export", () => {
      void exportTree(state.exportFormat);
    });

    bindClick("delete-node", () => {
      void deleteActiveNodeForever();
    });

    window.addEventListener("pointermove", handleDragMove);
    addCleanup(() => window.removeEventListener("pointermove", handleDragMove));
    window.addEventListener("pointerup", handleDragEnd);
    addCleanup(() => window.removeEventListener("pointerup", handleDragEnd));
    window.addEventListener("pointercancel", handleDragEnd);
    addCleanup(() => window.removeEventListener("pointercancel", handleDragEnd));

  }

  function applyPanelState() {
    const collapsed = state.tree.panelCollapsed;
    applyStoredPanelPosition();
    state.panel.classList.toggle("cgpt-tree-collapsed", collapsed);
    state.body.classList.toggle("cgpt-tree-hidden", collapsed);
    state.panel.querySelector(".cgpt-tree-header-actions").classList.toggle("cgpt-tree-hidden", collapsed);
    state.panel.querySelector(".cgpt-tree-toolbar").classList.toggle("cgpt-tree-hidden", collapsed);
    state.panel.querySelector(".cgpt-tree-status").classList.toggle("cgpt-tree-hidden", collapsed);
    state.toggleButton.textContent = collapsed ? "展开" : "折叠";
    updateConversationVisibility();
    updateExportModeOptions();
    updateUndoButtonState();
    updateBusyControls();
    saveTree();
  }

  function captureUndoState() {
    state.undoSnapshot = {
      tree: JSON.parse(JSON.stringify(state.tree)),
      activeNodeId: state.activeNodeId || null
    };
    updateUndoButtonState();
  }

  function restorePreviousState() {
    if (!state.undoSnapshot) {
      return;
    }
    const snapshot = state.undoSnapshot;
    state.undoSnapshot = null;
    state.tree = normalizeTree(snapshot.tree);
    state.activeNodeId = snapshot.activeNodeId && state.tree.nodes[snapshot.activeNodeId]
      ? snapshot.activeNodeId
      : null;
    if (state.searchInput) {
      state.searchInput.value = state.tree.searchQuery || "";
      state.searchDraft = state.searchInput.value || "";
    }
    updateSearchResults(false);
    updateUndoButtonState();
    saveTree();
    renderTree();
  }

  function updateUndoButtonState() {
    if (!state.undoButton) {
      return;
    }
    state.undoButton.disabled = !state.undoSnapshot;
  }

  function updateBusyControls() {
    if (state.refreshButton) {
      const busy = Boolean(state.scanInFlight);
      state.refreshButton.disabled = busy;
      state.refreshButton.textContent = busy ? "重新排序中..." : "重新排序";
      state.refreshButton.classList.toggle("cgpt-tree-busy-button", busy);
    }
  }

  function bindGlobalWatchers() {
    const scheduleActiveViewportUpdate = () => {
      if (isConversationClosed()) {
        return;
      }
      if (!state.panel || !isSupportedConversationRoute(state.siteType)) {
        return;
      }
      window.clearTimeout(state.activeTimer);
      state.activeTimer = window.setTimeout(updateActiveNodeFromViewport, ACTIVE_DEBOUNCE_MS);
    };
    const handleResize = () => {
      if (!state.panel || !isSupportedConversationRoute(state.siteType)) {
        return;
      }
      resetTopOverlayCache();
      clampStoredPanelPosition();
      window.clearTimeout(state.activeTimer);
      state.activeTimer = window.setTimeout(() => renderTree(), ACTIVE_DEBOUNCE_MS);
    };
    const handlePageHide = () => {
      window.clearTimeout(state.saveTimer);
      flushTreeState();
    };
    const handlePopState = () => {
      if (location.href !== state.lastKnownUrl) {
        state.lastKnownUrl = location.href;
        handleConversationChange();
      }
    };
    const handleHashChange = () => {
      if (location.href !== state.lastKnownUrl) {
        state.lastKnownUrl = location.href;
        handleConversationChange();
      }
    };

    window.addEventListener("scroll", scheduleActiveViewportUpdate, { passive: true });
    addCleanup(() => window.removeEventListener("scroll", scheduleActiveViewportUpdate, { passive: true }));
    document.addEventListener("scroll", scheduleActiveViewportUpdate, { passive: true, capture: true });
    addCleanup(() => document.removeEventListener("scroll", scheduleActiveViewportUpdate, { passive: true, capture: true }));

    window.addEventListener("resize", handleResize);
    addCleanup(() => window.removeEventListener("resize", handleResize));

    window.addEventListener("pagehide", handlePageHide);
    addCleanup(() => window.removeEventListener("pagehide", handlePageHide));

    // 监听popstate和hashchange事件，确保第一时间捕获SPA导航
    window.addEventListener("popstate", handlePopState);
    addCleanup(() => window.removeEventListener("popstate", handlePopState));

    window.addEventListener("hashchange", handleHashChange);
    addCleanup(() => window.removeEventListener("hashchange", handleHashChange));

    state.urlTimer = window.setInterval(() => {
      if (location.href === state.lastKnownUrl) {
        return;
      }
      state.lastKnownUrl = location.href;
      handleConversationChange();
    }, URL_POLL_MS);
  }

  function bindRuntimeMessages() {
    if (!chrome?.runtime?.onMessage) {
      return;
    }
    const listener = (message, sender, sendResponse) => {
      if (message?.type === "cgpt-tree-get-conversation-status") {
        void getConversationStatusPayload().then((payload) => sendResponse(payload));
        return true;
      }
      if (message?.type === "cgpt-tree-get-debug-log") {
        sendResponse({
          ok: true,
          text: getDebugLogText()
        });
        return false;
      }
      if (message?.type === "cgpt-tree-clear-debug-log") {
        logger?.clear?.();
        logger?.info("debug-log-cleared", {
          href: location.href
        });
        sendResponse({
          ok: true
        });
        return false;
      }
      if (message?.type === "cgpt-tree-set-conversation-status") {
        void setConversationClosedMode(message.mode || "open")
          .then(() => getConversationStatusPayload())
          .then((payload) => sendResponse(payload));
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    addCleanup(() => chrome.runtime.onMessage.removeListener(listener));
  }

  function getDebugLogText() {
    if (!logger?.exportText) {
      return JSON.stringify(buildDebugDiagnostics(), null, 2);
    }
    logger.info("debug-log-exported", {
      href: location.href
    });
    return logger.exportText({
      redact: true,
      diagnostics: buildDebugDiagnostics()
    });
  }

  function buildDebugDiagnostics() {
    const nodeCount = Math.max(0, Object.keys(state.tree?.nodes || {}).length - 1);
    return {
      href: location.href,
      title: document.title || "",
      userAgent: navigator.userAgent || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollY: window.scrollY
      },
      siteType: state.siteType,
      chatKey: state.chatKey,
      supportedRoute: isSupportedConversationRoute(state.siteType),
      workSuspended: state.workSuspended,
      closed: isConversationClosed(),
      closeStateLoaded: state.closeStateLoaded,
      nodeCount,
      activeNodeId: state.activeNodeId || "",
      searchQuery: state.tree?.searchQuery || "",
      searchResultCount: state.searchResults.length,
      panel: {
        exists: Boolean(state.panel?.isConnected),
        hidden: Boolean(state.panel?.hidden),
        collapsed: Boolean(state.tree?.panelCollapsed)
      },
      scan: {
        inFlight: state.scanInFlight,
        dueAt: state.scanDueAt || 0,
        lastStartedAt: state.lastScanStartedAt || 0,
        lastFingerprintLength: String(state.lastScanFingerprint || "").length
      },
      storage: {
        shouldPersist: shouldPersistTreeState(),
        needsCompaction: state.needsStorageCompaction,
        lastFingerprintLength: String(state.lastSavedTreeFingerprint || "").length
      },
      hardAlgorithm: hardAlgorithm?.getDiagnostics ? hardAlgorithm.getDiagnostics() : null
    };
  }

  function observeConversation() {
    if (state.observer) {
      state.observer.disconnect();
    }

    state.observer = new MutationObserver((mutations) => {
      if (state.workSuspended || isConversationClosed()) {
        return;
      }
      if (state.panel && mutations.every((mutation) => state.panel.contains(mutation.target))) {
        return;
      }
      scheduleScan(getAdaptiveScanDelay(mutations));
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function handleConversationChange() {
    resetScanState();
    resetTopOverlayCache();
    clearActiveHighlight();
    state.siteType = detectSiteType();
    state.chatKey = getChatKey();
    state.tree = loadTree();
    state.lastSavedTreeFingerprint = getPersistedTreeFingerprint(state.tree);
    logger?.info("conversation-change", {
      href: location.href,
      siteType: state.siteType,
      chatKey: state.chatKey,
      supported: isSupportedConversationRoute(state.siteType)
    });

    if (!isSupportedConversationRoute(state.siteType)) {
      setConversationWorkSuspended(true);
      removePanelUI();
      return;
    }

    ensurePanel();
    setConversationWorkSuspended(false);
    state.activeNodeId = null;
    state.domNodeMap.clear();
    state.turnTextCache = new WeakMap();
    state.assistantMarkdownCache = new WeakMap();
    state.lastScanFingerprint = "";
    state.renderedFingerprint = "";
    state.isConversationTemporarilyClosed = false;
    // 强制清空面板DOM，确保旧树不残留
    if (state.body) {
      state.body.innerHTML = "";
    }
    if (state.searchInput) {
      state.searchInput.value = state.tree.searchQuery || "";
      state.searchDraft = state.searchInput.value || "";
    } else {
      state.searchDraft = String(state.tree.searchQuery || "");
    }
    updateSearchResults(false);
    state.closeStateLoaded = false;
    applyPanelState();
    renderTree();
    void syncConversationClosedState();
    scheduleScan(400);
  }

  function resetScanState() {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.scanInFlight = false;
    state.deferredScanDelay = null;
    state.deferredScanRequest = null;
    state.scanDueAt = 0;
    state.scanRequestId += 1;
    updateBusyControls();
  }

  function getScanThrottleIntervalMs() {
    const nodeCount = Math.max(0, Object.keys(state.tree?.nodes || {}).length - 1);
    return nodeCount > 24 ? SCAN_THROTTLE_MS_LARGE_TREE : SCAN_THROTTLE_MS;
  }

  function scheduleScan(delay) {
    if (state.workSuspended || isConversationClosed()) {
      return;
    }

    const now = Date.now();
    const desiredDelay = Math.max(0, Number.isFinite(delay) ? delay : 0);
    const throttleMs = getScanThrottleIntervalMs();
    const earliestAllowedAt = state.lastScanStartedAt ? (state.lastScanStartedAt + throttleMs) : now;
    const desiredAt = Math.max(now + desiredDelay, earliestAllowedAt);
    const finalDelay = Math.max(0, desiredAt - now);

    // Don't let a constant stream of mutations postpone scanning forever.
    // Keep the earliest scheduled scan; reschedule only if the new request is earlier.
    if (state.scanTimer != null && state.scanDueAt) {
      if (desiredAt >= state.scanDueAt) {
        return;
      }
      window.clearTimeout(state.scanTimer);
      state.scanTimer = null;
      state.scanDueAt = 0;
    }

    state.scanDueAt = desiredAt;
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = null;
      state.scanDueAt = 0;
      void scanConversation(false);
    }, finalDelay);
  }

  function queueDeferredScan(delay, request) {
    if (Number.isFinite(delay)) {
      state.deferredScanDelay = state.deferredScanDelay == null ? delay : Math.min(state.deferredScanDelay, delay);
    }
    state.deferredScanRequest = mergeScanRequest(state.deferredScanRequest, request);
  }

  function mergeScanRequest(currentRequest, nextRequest) {
    return {
      forceRender: Boolean(currentRequest?.forceRender || nextRequest?.forceRender),
      forceRefresh: Boolean(currentRequest?.forceRefresh || nextRequest?.forceRefresh)
    };
  }

  function flushDeferredScan() {
    const request = state.deferredScanRequest;
    const delay = state.deferredScanDelay;
    state.deferredScanRequest = null;
    state.deferredScanDelay = null;
    if (!request) {
      return;
    }
    const scheduleDelay = Number.isFinite(delay) ? delay : 0;
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      void scanConversation(request.forceRender, request.forceRefresh);
    }, scheduleDelay);
  }

  function getAdaptiveScanDelay(mutations) {
    const nodeCount = Math.max(0, Object.keys(state.tree.nodes || {}).length - 1);
    const hasStructuralMutation = (mutations || []).some((mutation) => {
      return mutation.type === "childList" &&
        ((mutation.addedNodes && mutation.addedNodes.length) || (mutation.removedNodes && mutation.removedNodes.length));
    });

    if (hasStructuralMutation) {
      return nodeCount > 24 ? SCAN_DEBOUNCE_MS_LARGE_TREE : SCAN_DEBOUNCE_MS;
    }

    return nodeCount > 24 ? 1200 : SCAN_DEBOUNCE_MS;
  }

  function refreshConversationAnalysis() {
    void runRefreshConversationAnalysis();
  }

  async function runRefreshConversationAnalysis() {
    captureUndoState();
    resetPendingScanWork();
    resetTreeForAlgorithmRebuild();
    saveTree();
    renderTree();
    updateBusyControls();
    try {
      await scanConversation(true, true);
    } finally {
      updateBusyControls();
    }
  }

  function resetPendingScanWork() {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.scanDueAt = 0;
    state.scanRequestId += 1;
    state.scanInFlight = false;
    state.deferredScanDelay = null;
    state.deferredScanRequest = null;
  }

  function resetTreeForAlgorithmRebuild() {
    const nextTree = createTree();
    nextTree.panelCollapsed = Boolean(state.tree?.panelCollapsed);
    nextTree.panelPosition = normalizePanelPosition(state.tree?.panelPosition);
    state.tree = nextTree;
    state.activeNodeId = null;
    state.manualActiveNodeId = null;
    state.manualActiveUntil = 0;
    state.domNodeMap.clear();
    state.searchResults = [];
    state.searchIndex = -1;
    if (state.searchInput) {
      state.searchInput.value = "";
      state.searchDraft = "";
    }
    updateSearchResults(false);
    state.renderedFingerprint = "";
    state.lastScanFingerprint = "";
  }

  async function scanConversation(forceRender, forceRefresh) {
    if (state.workSuspended || isConversationClosed()) {
      logger?.debug("scan-skipped-suspended", {
        workSuspended: state.workSuspended,
        closed: isConversationClosed()
      });
      return;
    }
    if (state.scanInFlight) {
      queueDeferredScan(0, {
        forceRender,
        forceRefresh
      });
      return;
    }
    state.lastScanStartedAt = Date.now();
    state.scanInFlight = true;
    updateBusyControls();
    const scanRequestId = ++state.scanRequestId;
    const scanStartedAt = performance.now();
    const phaseDurations = {};
    let entriesCount = 0;
    let skippedUnchanged = false;
    try {
      const rawEntries = extractPromptEntries(phaseDurations);
      const filterStartedAt = performance.now();
      const entries = filterIgnoredEntries(rawEntries);
      phaseDurations.filterMs = Math.round(performance.now() - filterStartedAt);
      entriesCount = entries.length;
      const fingerprintStartedAt = performance.now();
      const fingerprint = JSON.stringify(entries.map((entry) => [entry.analysisId, entry.signature, entry.answerSignature]));
      phaseDurations.fingerprintMs = Math.round(performance.now() - fingerprintStartedAt);
      if (!forceRender && !forceRefresh && fingerprint === state.lastScanFingerprint) {
        skippedUnchanged = true;
        updateActiveNodeFromViewport();
        return;
      }

      state.lastScanFingerprint = fingerprint;
      if (scanRequestId !== state.scanRequestId) {
        return;
      }
      const syncStartedAt = performance.now();
      syncTree(entries);
      phaseDurations.syncMs = Math.round(performance.now() - syncStartedAt);
      const searchStartedAt = performance.now();
      updateSearchResults(false);
      phaseDurations.searchMs = Math.round(performance.now() - searchStartedAt);
      const activeStartedAt = performance.now();
      updateActiveNodeFromViewport();
      phaseDurations.activeMs = Math.round(performance.now() - activeStartedAt);
      const renderStartedAt = performance.now();
      renderTree();
      phaseDurations.renderMs = Math.round(performance.now() - renderStartedAt);
    } catch (error) {
      logger?.error("scan-error", error);
      console.warn("ChatGPT Tree Panel: scan failed", error);
    } finally {
      const durationMs = Math.round(performance.now() - scanStartedAt);
      const logMethod = durationMs > 800 ? "warn" : "debug";
      logger?.[logMethod]?.("scan-finish", {
        durationMs,
        entriesCount,
        skippedUnchanged,
        forceRender: Boolean(forceRender),
        forceRefresh: Boolean(forceRefresh),
        nodeCount: Math.max(0, Object.keys(state.tree?.nodes || {}).length - 1),
        phaseDurations
      });
      state.scanInFlight = false;
      updateBusyControls();
      flushDeferredScan();
    }
  }

  function extractPromptEntries(phaseDurations) {
    const turnsStartedAt = performance.now();
    const turns = getConversationTurns();
    if (phaseDurations) {
      phaseDurations.turnsMs = Math.round(performance.now() - turnsStartedAt);
      phaseDurations.turnCount = turns.length;
    }
    if (hardAlgorithm?.extractPromptEntries) {
      const algorithmStartedAt = performance.now();
      const entries = hardAlgorithm.extractPromptEntries(turns).map((entry, index) => ({
        ...entry,
        originalPromptIndex: Number.isFinite(entry?.originalPromptIndex) ? entry.originalPromptIndex : index
      }));
      if (phaseDurations) {
        phaseDurations.algorithmMs = Math.round(performance.now() - algorithmStartedAt);
      }
      return entries;
    }
    return [];
  }

  function getIgnoredSignatureSet() {
    return new Set((state.tree?.ignoredSignatures || []).filter(Boolean));
  }

  function getIgnoredPromptIndexSet() {
    return new Set((state.tree?.ignoredPromptIndices || []).filter((value) => Number.isInteger(value) && value >= 0));
  }

  function getIgnoredTitleSet() {
    return new Set((state.tree?.ignoredTitles || []).filter(Boolean));
  }

  function normalizeIgnoredPromptTitle(text) {
    return normalizeTurnText("user", text || "").toLowerCase();
  }

  function filterIgnoredEntries(entries) {
    const ignoredPromptIndexSet = getIgnoredPromptIndexSet();
    const ignoredSet = getIgnoredSignatureSet();
    const ignoredTitleSet = getIgnoredTitleSet();
    if (!ignoredPromptIndexSet.size && !ignoredSet.size && !ignoredTitleSet.size) {
      return entries;
    }

    const entryBySignature = new Map();
    for (const entry of entries) {
      if (entry?.signature) {
        entryBySignature.set(entry.signature, entry);
      }
    }

    const visibleSignatures = new Set(
      entries
        .filter((entry) => entry?.signature && !ignoredSet.has(entry.signature))
        .map((entry) => entry.signature)
    );

    const titleMatchCounts = new Map();
    for (const entry of entries) {
      const normalizedTitle = normalizeIgnoredPromptTitle(entry?.title || entry?.fullText || "");
      if (!normalizedTitle) {
        continue;
      }
      titleMatchCounts.set(normalizedTitle, (titleMatchCounts.get(normalizedTitle) || 0) + 1);
    }

    return entries
      .filter((entry) => {
        if (!entry?.signature) {
          return false;
        }
        const normalizedTitle = normalizeIgnoredPromptTitle(entry.title || entry.fullText || "");
        const promptIndex = Number.isInteger(entry?.originalPromptIndex) ? entry.originalPromptIndex : -1;
        const shouldIgnoreByTitle = ignoredTitleSet.has(normalizedTitle) && titleMatchCounts.get(normalizedTitle) === 1;
        return !ignoredPromptIndexSet.has(promptIndex) && !ignoredSet.has(entry.signature) && !shouldIgnoreByTitle;
      })
      .map((entry) => {
        let parentSignature = entry.parentSignature || "";
        const visited = new Set();
        while (
          parentSignature &&
          parentSignature !== ROOT_PARENT_SIGNATURE &&
          ignoredSet.has(parentSignature) &&
          !visited.has(parentSignature)
        ) {
          visited.add(parentSignature);
          parentSignature = entryBySignature.get(parentSignature)?.parentSignature || "";
        }
        if (parentSignature && parentSignature !== ROOT_PARENT_SIGNATURE && !visibleSignatures.has(parentSignature)) {
          parentSignature = "";
        }
        return {
          ...entry,
          parentSignature
        };
      });
  }

  function findPromptParentMatch(promptText, answeredPrompts) {
    if (!answeredPrompts.length) {
      return null;
    }

    let bestPointMatch = null;

    for (let index = answeredPrompts.length - 1; index >= 0; index -= 1) {
      const candidate = answeredPrompts[index];
      if (!candidate?.answer) {
        continue;
      }

      const pointMatch = matchPromptToAnswerPoint(promptText, candidate.answer);
      if (!pointMatch) {
        continue;
      }

      const distance = answeredPrompts.length - 1 - index;
      const recencyBonus = Math.max(0, 4 - distance);
      const score = pointMatch.score + recencyBonus;
      if (!bestPointMatch || score > bestPointMatch.score) {
        bestPointMatch = {
          parentSignature: candidate.signature,
          point: pointMatch,
          score,
          mode: "point"
        };
      }
    }

    if (bestPointMatch) {
      return bestPointMatch;
    }

    const continuationMatch = findPromptContinuationParent(promptText, answeredPrompts);
    if (continuationMatch) {
      return continuationMatch;
    }

    return {
      parentSignature: ROOT_PARENT_SIGNATURE,
      point: { text: "", head: "", score: 0 },
      score: 0,
      mode: "root"
    };
  }

  function getConversationTurns() {
    if (state.siteType === SITE_TYPE_GEMINI) {
      return getGeminiConversationTurns();
    }
    return getChatGPTConversationTurns();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function detectSiteType() {
    const hostname = String(location.hostname || "").toLowerCase();
    if (hostname === "chatgpt.com") {
      return SITE_TYPE_CHATGPT;
    }
    if (hostname === "gemini.google.com") {
      return SITE_TYPE_GEMINI;
    }
    return SITE_TYPE_UNKNOWN;
  }

  function getChatGPTConversationTurns() {
    const main = document.querySelector("main");
    if (!main) {
      return [];
    }

    const conversationNodes = getVisibleTopLevelNodes([
      'article[data-testid^="conversation-turn-"]',
      'article[data-testid*="conversation-turn"]',
      'div[data-testid^="conversation-turn-"]',
      'div[data-testid*="conversation-turn"]',
      'article[data-turn]',
      'article[data-turn-id]'
    ].join(","), main);

    if (!conversationNodes.length) {
      // ChatGPT has changed its DOM structure multiple times; fall back to generic extraction.
      return getGenericConversationTurnsDeep([
        "main",
        '[role="main"]'
      ]);
    }

    const nodes = conversationNodes.filter((node) => {
      const role = getGenericRole(node);
      return role === "user" || role === "assistant";
    });

    return nodes
      .map((node) => createTurn(getGenericRole(node), getGenericTurnText(node), node))
      .filter(Boolean);
  }

  function getCopilotConversationTurns() {
    const primaryTurns = getVisibleTopLevelNodesDeep([
      'cib-chat-turn[source="user"]',
      'cib-chat-turn[source="bot"]',
      'cib-chat-turn[source="assistant"]',
      'cib-chat-turn[data-author="user"]',
      'cib-chat-turn[data-author="assistant"]'
    ].join(","));

    if (primaryTurns.length) {
      return primaryTurns
        .map((node) => createTurn(getCopilotRole(node), getCopilotTurnText(node), node))
        .filter(Boolean);
    }

    const candidates = getOrderedRoleCandidatesDeep([
      { role: "user", selector: 'cib-user-query, cib-user-message, [data-author="user"], [data-testid*="user-message"]' },
      { role: "assistant", selector: 'cib-message-group[source="bot"], cib-shared, cib-message, [data-author="assistant"], [data-testid*="assistant-message"]' },
      { role: "user", selector: '[class*="user-message"], [class*="userMessage"], [class*="request"]' },
      { role: "assistant", selector: '[class*="assistant-message"], [class*="assistantMessage"], [class*="bot-message"], [class*="response"]' }
    ]);

    if (candidates.length) {
      return candidates
        .map((item) => createTurn(item.role, getCopilotTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurnsDeep([
      "cib-serp",
      "cib-conversation",
      "main",
      '[role="main"]'
    ]);
  }

  function getGithubCopilotConversationTurns() {
    const primaryTurns = getOrderedRoleCandidatesDeep([
      { role: "user", selector: '[data-testid*="user-message"], [data-testid*="user_prompt"], [data-testid*="prompt-message"]' },
      { role: "assistant", selector: '[data-testid*="assistant-message"], [data-testid*="copilot-response"], [data-testid*="response-message"]' },
      { role: "user", selector: '[data-role="user"], [data-message-author-role="user"], [data-author="user"]' },
      { role: "assistant", selector: '[data-role="assistant"], [data-message-author-role="assistant"], [data-author="assistant"]' },
      { role: "user", selector: '[class*="userMessage"], [class*="user-message"], [class*="promptMessage"], [class*="request"]' },
      { role: "assistant", selector: '[class*="assistantMessage"], [class*="assistant-message"], [class*="copilotResponse"], [class*="responseMessage"]' }
    ]);

    if (primaryTurns.length) {
      return primaryTurns
        .map((item) => createTurn(item.role, getCopilotTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurnsDeep([
      '[data-testid*="copilot-chat"]',
      '[data-testid*="chat-messages"]',
      '[class*="copilotChat"]',
      '[class*="chatMessages"]',
      "main",
      '[role="main"]'
    ]);
  }

  function getGeminiConversationTurns() {
    const candidates = getOrderedRoleCandidatesDeep([
      { role: "user", selector: "user-query" },
      { role: "assistant", selector: "model-response" },
      { role: "user", selector: "message-content[user-query]" },
      { role: "assistant", selector: "message-content[model-response]" },
      { role: "user", selector: '[data-test-id*="user-query"], [data-testid*="user-query"]' },
      { role: "assistant", selector: '[data-test-id*="model-response"], [data-testid*="model-response"]' },
      { role: "user", selector: '[class*="user-query"], [class*="query-text"], [class*="userQuery"]' },
      { role: "assistant", selector: '[class*="model-response"], [class*="response-content"], [class*="modelResponse"]' }
    ]);

    if (candidates.length) {
      return candidates
        .map((item) => createTurn(item.role, getGenericTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurnsDeep([
      'chat-window',
      'conversation-container',
      '[data-test-id*="conversation"]',
      '[data-test-id*="conversation"], [data-testid*="conversation"]',
      '[class*="conversation-container"]',
      'main'
    ]);
  }

  function getTongyiConversationTurns() {
    const candidates = getOrderedRoleCandidates([
      { role: "user", selector: '[class*="questionItem"], [class*="question-item"], [class*="userQuestion"]' },
      { role: "assistant", selector: '[class*="answerItem"], [class*="answer-item"], [class*="assistantAnswer"]' },
      { role: "user", selector: '[data-role="user"], [data-message-author-role="user"]' },
      { role: "assistant", selector: '[data-role="assistant"], [data-message-author-role="assistant"]' },
      { role: "user", selector: '[class*="userMessage"], [class*="user-message"]' },
      { role: "assistant", selector: '[class*="assistantMessage"], [class*="assistant-message"]' }
    ]);

    if (candidates.length) {
      return candidates
        .map((item) => createTurn(item.role, getGenericTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurns([
      '[class*="chatContent"]',
      '[class*="conversation"]',
      '[class*="message-list"]',
      'main'
    ]);
  }

  function getDoubaoConversationTurns() {
    const candidates = getOrderedRoleCandidates([
      { role: "user", selector: '[data-testid*="user-message"], [data-testid*="question"], [data-testid*="query"]' },
      { role: "assistant", selector: '[data-testid*="assistant-message"], [data-testid*="answer"], [data-testid*="response"]' },
      { role: "user", selector: '[data-role="user"], [data-message-author-role="user"], [data-author="user"]' },
      { role: "assistant", selector: '[data-role="assistant"], [data-message-author-role="assistant"], [data-author="assistant"]' },
      { role: "user", selector: '[class*="userMessage"], [class*="user-message"], [class*="questionItem"], [class*="question-item"], [class*="queryItem"]' },
      { role: "assistant", selector: '[class*="assistantMessage"], [class*="assistant-message"], [class*="answerItem"], [class*="answer-item"], [class*="responseItem"]' }
    ]);

    if (candidates.length) {
      return candidates
        .map((item) => createTurn(item.role, getGenericTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurns([
      '[data-testid*="chat-content"]',
      '[data-testid*="conversation"]',
      '[class*="chatContent"]',
      '[class*="conversation"]',
      '[class*="message-list"]',
      'main'
    ]);
  }

  function getQianwenConversationTurns() {
    const candidates = getOrderedRoleCandidates([
      { role: "user", selector: '[data-testid*="user-message"], [data-testid*="question"], [data-testid*="query"]' },
      { role: "assistant", selector: '[data-testid*="assistant-message"], [data-testid*="answer"], [data-testid*="response"]' },
      { role: "user", selector: '[data-role="user"], [data-message-author-role="user"], [data-author="user"]' },
      { role: "assistant", selector: '[data-role="assistant"], [data-message-author-role="assistant"], [data-author="assistant"]' },
      { role: "user", selector: '[class*="questionItem"], [class*="question-item"], [class*="userMessage"], [class*="user-message"], [class*="queryItem"]' },
      { role: "assistant", selector: '[class*="answerItem"], [class*="answer-item"], [class*="assistantMessage"], [class*="assistant-message"], [class*="responseItem"]' }
    ]);

    if (candidates.length) {
      return candidates
        .map((item) => createTurn(item.role, getGenericTurnText(item.node), item.node))
        .filter(Boolean);
    }

    return getGenericConversationTurns([
      '[data-testid*="chat-content"]',
      '[data-testid*="conversation"]',
      '[class*="chatContent"]',
      '[class*="conversation"]',
      '[class*="message-list"]',
      'main'
    ]);
  }

  function getGenericConversationTurnsDeep(scopeSelectors) {
    const scopes = [];
    for (const selector of scopeSelectors) {
      const matches = getVisibleTopLevelNodesDeep(selector);
      scopes.push(...matches);
    }

    const nodes = dedupeNodes(scopes);
    const turns = [];
    for (const scope of nodes) {
      const descendants = getVisibleTopLevelNodesDeep([
        "cib-chat-turn",
        "cib-user-query",
        "cib-user-message",
        "cib-message-group",
        "cib-shared",
        "cib-message",
        '[data-message-author-role]',
        '[data-role]',
        '[data-author]',
        '[data-testid*="user-message"]',
        '[data-testid*="assistant-message"]'
      ].join(","), scope);
      for (const node of descendants) {
        const role = getCopilotRole(node) || getGenericRole(node);
        const turn = createTurn(role, getCopilotTurnText(node), node);
        if (turn) {
          turns.push(turn);
        }
      }
      if (turns.length) {
        return sortTurnsByDomOrder(turns);
      }
    }
    return [];
  }

  function getGenericConversationTurns(scopeSelectors) {
    const scopes = [];
    for (const selector of scopeSelectors) {
      const matches = getVisibleTopLevelNodes(selector);
      scopes.push(...matches);
    }

    const nodes = dedupeNodes(scopes);
    const turns = [];
    for (const scope of nodes) {
      const descendants = getVisibleTopLevelNodes([
        '[data-message-author-role]',
        '[data-role]',
        '[class*="questionItem"]',
        '[class*="answerItem"]',
        '[class*="user-message"]',
        '[class*="assistant-message"]',
        '[class*="userMessage"]',
        '[class*="assistantMessage"]',
        'user-query',
        'model-response'
      ].join(","), scope);
      for (const node of descendants) {
        const role = getGenericRole(node);
        const turn = createTurn(role, getGenericTurnText(node), node);
        if (turn) {
          turns.push(turn);
        }
      }
      if (turns.length) {
        return sortTurnsByDomOrder(turns);
      }
    }
    return [];
  }

  function getGenericRole(turn) {
    const source = String(
      turn.getAttribute("source") ||
      turn.getAttribute("data-source") ||
      turn.getAttribute("author") ||
      turn.getAttribute("data-author") ||
      ""
    ).toLowerCase();
    if (/(^|[^a-z])(user|human|me)([^a-z]|$)/.test(source)) {
      return "user";
    }
    if (/(^|[^a-z])(assistant|bot|copilot|bing)([^a-z]|$)/.test(source)) {
      return "assistant";
    }

    const direct = turn.getAttribute("data-message-author-role");
    if (direct === "user" || direct === "assistant") {
      return direct;
    }

    const dataRole = turn.getAttribute("data-role");
    if (dataRole === "user" || dataRole === "assistant") {
      return dataRole;
    }

    const nested = turn.querySelector("[data-message-author-role]");
    const nestedRole = nested?.getAttribute("data-message-author-role");
    if (nestedRole === "user" || nestedRole === "assistant") {
      return nestedRole;
    }

    const nestedRoleNode = turn.querySelector("[data-role]");
    const nestedDataRole = nestedRoleNode?.getAttribute("data-role");
    if (nestedDataRole === "user" || nestedDataRole === "assistant") {
      return nestedDataRole;
    }

    const tagName = String(turn.tagName || "").toLowerCase();
    if (tagName === "user-query") {
      return "user";
    }
    if (tagName === "model-response") {
      return "assistant";
    }

    const attrText = [
      turn.getAttribute("class"),
      turn.getAttribute("aria-label"),
      turn.getAttribute("data-testid"),
      turn.getAttribute("data-test-id")
    ].filter(Boolean).join(" ").toLowerCase();

    if (/(user|question|query|prompt)/.test(attrText)) {
      return "user";
    }
    if (/(assistant|answer|response|model)/.test(attrText)) {
      return "assistant";
    }

    const text = normalizeText(turn.innerText || turn.textContent || "").toLowerCase();
    if (text.startsWith("you said") || turn.querySelector('img[alt*="User"], [alt="User"]')) {
      return "user";
    }
    return "assistant";
  }

  function getCopilotRole(turn) {
    const source = String(
      turn.getAttribute("source") ||
      turn.getAttribute("data-source") ||
      turn.getAttribute("author") ||
      turn.getAttribute("data-author") ||
      turn.getAttribute("data-testid") ||
      turn.getAttribute("class") ||
      ""
    ).toLowerCase();
    if (/(^|[^a-z])(user|human|request|query)([^a-z]|$)/.test(source)) {
      return "user";
    }
    if (/(^|[^a-z])(assistant|bot|copilot|bing|response)([^a-z]|$)/.test(source)) {
      return "assistant";
    }

    const tagName = String(turn.tagName || "").toLowerCase();
    if (tagName === "cib-user-query" || tagName === "cib-user-message") {
      return "user";
    }
    if (tagName === "cib-shared" || tagName === "cib-message") {
      return "assistant";
    }

    return getGenericRole(turn);
  }

  function getGenericTurnText(turn) {
    const signature = getElementTextSignature(turn);
    const cached = state.turnTextCache.get(turn);
    if (cached?.signature === signature) {
      return cached.value;
    }

    const raw = extractElementTextDeep(turn);
    const value = raw
      .replace(/\b(ChatGPT can make mistakes\.? Check important info\.?)$/i, "")
      .replace(/\b(Gemini can make mistakes\.? Please double-check responses\.?)$/i, "")
      .replace(/\b(Previous response|Next response|Previous message|Next message)\b/gi, "")
      .trim();
    state.turnTextCache.set(turn, {
      signature,
      value
    });
    return value;
  }

  function getCopilotTurnText(turn) {
    const text = extractElementTextDeep(turn);
    return text
      .replace(/\b(Copilot can make mistakes\.? Please verify important information\.?)$/i, "")
      .replace(/\b(Previous response|Next response|Previous message|Next message)\b/gi, "")
      .trim();
  }

  function createTurn(role, text, promptEl) {
    const normalizedRole = role === "user" ? "user" : "assistant";
    const normalizedText = normalizeTurnText(normalizedRole, text);
    if (!normalizedText || !promptEl || state.panel?.contains(promptEl)) {
      return null;
    }
    const markdown = normalizedRole === "assistant"
      ? extractAssistantMarkdown(promptEl, normalizedText)
      : normalizedText;
    return {
      role: normalizedRole,
      text: normalizedText,
      markdown,
      promptEl,
      askedAt: normalizedRole === "user" ? extractPromptTimestamp(promptEl) : 0
    };
  }

  function extractAssistantMarkdown(root, fallbackText) {
    if (!root) {
      return fallbackText;
    }

    const signature = getElementTextSignature(root);
    const cached = state.assistantMarkdownCache.get(root);
    if (cached?.signature === signature) {
      return cached.value;
    }

    const markdown = extractAssistantMatchMarkdown(root).trim();
    const value = markdown || fallbackText;
    state.assistantMarkdownCache.set(root, {
      signature,
      value: truncateAssistantMatchText(value)
    });
    return truncateAssistantMatchText(value);
  }

  function extractAssistantMatchMarkdown(root) {
    const parts = [];
    const limit = {
      chars: 0,
      maxChars: ASSISTANT_MATCH_TEXT_MAX_CHARS
    };
    collectAssistantMatchMarkdown(root, parts, limit);
    return normalizeBlockMarkdownText(parts.join(""));
  }

  function collectAssistantMatchMarkdown(node, parts, limit) {
    if (!node || limit.chars >= limit.maxChars) {
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      appendAssistantMatchPart(parts, limit, String(node.textContent || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }

    const element = node;
    const tagName = String(element.tagName || "").toLowerCase();
    if (node.nodeType === Node.ELEMENT_NODE && shouldSkipTextElement(element)) {
      return;
    }

    if (/^h[1-6]$/.test(tagName)) {
      appendAssistantMatchPart(parts, limit, "\n" + "#".repeat(Number(tagName.slice(1))) + " ");
      collectAssistantChildrenMarkdown(node, parts, limit);
      appendAssistantMatchPart(parts, limit, "\n");
      return;
    }
    if (tagName === "strong" || tagName === "b") {
      appendAssistantMatchPart(parts, limit, "**");
      collectAssistantChildrenMarkdown(node, parts, limit);
      appendAssistantMatchPart(parts, limit, "**");
      return;
    }
    if (tagName === "li") {
      appendAssistantMatchPart(parts, limit, "\n- ");
      collectAssistantChildrenMarkdown(node, parts, limit);
      appendAssistantMatchPart(parts, limit, "\n");
      return;
    }
    if (tagName === "br") {
      appendAssistantMatchPart(parts, limit, "\n");
      return;
    }
    if (isBlockBoundaryElement(element)) {
      appendAssistantMatchPart(parts, limit, "\n");
      collectAssistantChildrenMarkdown(node, parts, limit);
      appendAssistantMatchPart(parts, limit, "\n");
      return;
    }

    collectAssistantChildrenMarkdown(node, parts, limit);
  }

  function collectAssistantChildrenMarkdown(node, parts, limit) {
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName && node.tagName.toLowerCase() === "slot") {
      const assignedNodes = node.assignedNodes ? node.assignedNodes({ flatten: true }) : [];
      if (assignedNodes.length) {
        for (const assignedNode of assignedNodes) {
          collectAssistantMatchMarkdown(assignedNode, parts, limit);
          if (limit.chars >= limit.maxChars) {
            return;
          }
        }
        return;
      }
    }

    if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
      collectAssistantMatchMarkdown(node.shadowRoot, parts, limit);
    }

    const children = node.childNodes || [];
    for (let index = 0; index < children.length; index += 1) {
      collectAssistantMatchMarkdown(children[index], parts, limit);
      if (limit.chars >= limit.maxChars) {
        return;
      }
    }
  }

  function appendAssistantMatchPart(parts, limit, value) {
    if (!value || limit.chars >= limit.maxChars) {
      return;
    }
    const remaining = limit.maxChars - limit.chars;
    const text = String(value).slice(0, remaining);
    parts.push(text);
    limit.chars += text.length;
  }

  function truncateAssistantMatchText(text) {
    const normalized = normalizeBlockMarkdownText(text);
    if (normalized.length <= ASSISTANT_MATCH_TEXT_MAX_CHARS) {
      return normalized;
    }
    return normalized.slice(0, ASSISTANT_MATCH_TEXT_MAX_CHARS).trim();
  }

  function getElementTextSignature(element) {
    const text = String(element?.textContent || "");
    return [
      text.length,
      text.slice(0, 96),
      text.slice(-96)
    ].join("|");
  }

  function extractMarkdownFromNode(node, context = {}) {
    if (!node) {
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.textContent || "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = String(element.tagName || "").toLowerCase();
    const childMarkdown = Array.from(node.childNodes || [])
      .map((child) => extractMarkdownFromNode(child, context))
      .join("");

    if (tagName === "pre") {
      const code = normalizeFenceContent(element.innerText || element.textContent || "");
      return "\n```text\n" + code + "\n```\n\n";
    }
    if (tagName === "code") {
      if (String(element.parentElement?.tagName || "").toLowerCase() === "pre") {
        return "";
      }
      return "`" + normalizeInlineMarkdownText(childMarkdown) + "`";
    }
    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      return "\n" + "#".repeat(level) + " " + normalizeInlineMarkdownText(childMarkdown) + "\n\n";
    }
    if (tagName === "li") {
      const prefix = context.orderedList ? (context.listIndex || 1) + ". " : "- ";
      return prefix + normalizeListItemText(childMarkdown) + "\n";
    }
    if (tagName === "ul") {
      return "\n" + Array.from(element.children).map((child) => extractMarkdownFromNode(child, { orderedList: false })).join("") + "\n";
    }
    if (tagName === "ol") {
      return "\n" + Array.from(element.children).map((child, index) => extractMarkdownFromNode(child, { orderedList: true, listIndex: index + 1 })).join("") + "\n";
    }
    if (tagName === "blockquote") {
      return "\n" + normalizeBlockMarkdownText(childMarkdown).split("\n").map((line) => "> " + line).join("\n") + "\n\n";
    }
    if (tagName === "br") {
      return "\n";
    }
    if (["p", "div", "section", "article"].includes(tagName)) {
      const normalized = normalizeBlockMarkdownText(childMarkdown);
      return normalized ? normalized + "\n\n" : "";
    }
    return childMarkdown;
  }

  function normalizeInlineMarkdownText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeBlockMarkdownText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  }

  function normalizeListItemText(text) {
    return normalizeBlockMarkdownText(text).replace(/\n+/g, " ").trim();
  }

  function normalizeFenceContent(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n$/, "")
      .trimEnd();
  }

  function extractPromptTimestamp(promptEl) {
    if (!promptEl) {
      return 0;
    }

    const candidateElements = [
      promptEl,
      promptEl.closest("article, section, div")
    ].filter(Boolean);

    const selectors = [
      "time",
      "[datetime]",
      "[data-testid*='time']",
      "[data-testid*='timestamp']",
      "[aria-label*='时间']",
      "[aria-label*='time']",
      "[title*=':']"
    ];

    for (const root of candidateElements) {
      const matches = [root, ...Array.from(root.querySelectorAll(selectors.join(",")))];
      for (const element of matches) {
        const timestamp = parseTimestampCandidate(element);
        if (timestamp) {
          return timestamp;
        }
      }
    }

    return 0;
  }

  function parseTimestampCandidate(element) {
    if (!element || typeof element.getAttribute !== "function") {
      return 0;
    }

    const attributeValues = [
      element.getAttribute("datetime"),
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent
    ].filter(Boolean);

    for (const value of attributeValues) {
      const parsed = parseTimestampText(value);
      if (parsed) {
        return parsed;
      }
    }

    return 0;
  }

  function parseTimestampText(value) {
    const text = String(value || "").trim();
    if (!text) {
      return 0;
    }

    const direct = Date.parse(text);
    if (Number.isFinite(direct)) {
      return direct;
    }

    const normalized = text.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, " ").replace(/\s+/g, " ").trim();
    const parsedNormalized = Date.parse(normalized);
    if (Number.isFinite(parsedNormalized)) {
      return parsedNormalized;
    }

    const monthDayTime = normalized.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (monthDayTime) {
      const now = new Date();
      const [, month, day, hour, minute, second] = monthDayTime;
      return new Date(
        now.getFullYear(),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second || 0)
      ).getTime();
    }

    return 0;
  }

  function getVisibleTopLevelNodes(selector, root) {
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll(selector)).filter((node) => {
      if (!node.isConnected || !isVisible(node)) {
        return false;
      }
      if (state.panel && state.panel.contains(node)) {
        return false;
      }
      return true;
    });

    return nodes.filter((node) => {
      return !nodes.some((other) => other !== node && other.contains(node));
    });
  }

  function getVisibleTopLevelNodesDeep(selector, root) {
    const scope = root || document;
    const nodes = queryAllDeep(selector, scope).filter((node) => {
      if (!node.isConnected || !isVisible(node)) {
        return false;
      }
      if (state.panel && state.panel.contains(node)) {
        return false;
      }
      return true;
    });

    return nodes.filter((node) => {
      return !nodes.some((other) => other !== node && other.contains(node));
    });
  }

  function getOrderedRoleCandidates(specs) {
    const items = [];
    for (const spec of specs) {
      for (const node of getVisibleTopLevelNodes(spec.selector)) {
        items.push({ role: spec.role, node });
      }
    }

    const uniqueItems = [];
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.node)) {
        continue;
      }
      seen.add(item.node);
      uniqueItems.push(item);
    }

    return uniqueItems
      .filter((item) => !uniqueItems.some((other) => other !== item && other.node.contains(item.node)))
      .sort((left, right) => compareDomOrder(left.node, right.node));
  }

  function getOrderedRoleCandidatesDeep(specs) {
    const items = [];
    for (const spec of specs) {
      for (const node of getVisibleTopLevelNodesDeep(spec.selector)) {
        items.push({ role: spec.role, node });
      }
    }

    const uniqueItems = [];
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.node)) {
        continue;
      }
      seen.add(item.node);
      uniqueItems.push(item);
    }

    return uniqueItems
      .filter((item) => !uniqueItems.some((other) => other !== item && other.node.contains(item.node)))
      .sort((left, right) => compareDomOrder(left.node, right.node));
  }

  function queryAllDeep(selector, root) {
    const results = [];
    const seenNodes = new Set();
    const visitedRoots = new Set();
    collectDeepQueryResults(selector, root || document, results, seenNodes, visitedRoots);
    return results;
  }

  function collectDeepQueryResults(selector, root, results, seenNodes, visitedRoots) {
    if (!root || visitedRoots.has(root) || typeof root.querySelectorAll !== "function") {
      return;
    }
    visitedRoots.add(root);

    for (const node of Array.from(root.querySelectorAll(selector))) {
      if (!seenNodes.has(node)) {
        seenNodes.add(node);
        results.push(node);
      }
    }

    const descendants = root.querySelectorAll("*");
    for (const element of descendants) {
      if (element.shadowRoot) {
        collectDeepQueryResults(selector, element.shadowRoot, results, seenNodes, visitedRoots);
      }
    }
  }

  function extractElementTextDeep(root) {
    const parts = [];
    collectElementTextParts(root, parts);
    return normalizeBlockText(parts.join(""));
  }

  function collectElementTextParts(node, parts) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const value = String(node.textContent || "");
      if (value.trim()) {
        parts.push(value);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node;
      if (shouldSkipTextElement(element)) {
        return;
      }
      if (isBlockBoundaryElement(element)) {
        parts.push("\n");
      }

      if (element.tagName && element.tagName.toLowerCase() === "slot") {
        const assignedNodes = element.assignedNodes ? element.assignedNodes({ flatten: true }) : [];
        if (assignedNodes.length) {
          for (const assignedNode of assignedNodes) {
            collectElementTextParts(assignedNode, parts);
          }
          parts.push("\n");
          return;
        }
      }

      if (element.shadowRoot) {
        collectElementTextParts(element.shadowRoot, parts);
      }
    }

    const childNodes = node.childNodes ? Array.from(node.childNodes) : [];
    for (const child of childNodes) {
      collectElementTextParts(child, parts);
    }

    if (node.nodeType === Node.ELEMENT_NODE && isBlockBoundaryElement(node)) {
      parts.push("\n");
    }
  }

  function shouldSkipTextElement(element) {
    const tagName = String(element.tagName || "").toLowerCase();
    if ([
      "button",
      "nav",
      "textarea",
      "input",
      "svg",
      "img",
      "video",
      "canvas",
      "style",
      "script",
      "footer"
    ].includes(tagName)) {
      return true;
    }

    const attrText = [
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid"),
      element.getAttribute("class")
    ].filter(Boolean).join(" ").toLowerCase();

    return /(toolbar|feedback|citation|source|reference|share|vote|action|attachment|welcome-message|disclaimer)/.test(attrText);
  }

  function isBlockBoundaryElement(element) {
    const tagName = String(element.tagName || "").toLowerCase();
    return /^(address|article|aside|blockquote|br|cib-chat-turn|cib-message|cib-message-group|cib-shared|div|li|main|ol|p|section|tr|ul)$/.test(tagName);
  }

  function dedupeNodes(nodes) {
    const result = [];
    const seen = new Set();
    for (const node of nodes.sort(compareDomOrder)) {
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);
      result.push(node);
    }
    return result;
  }

  function sortTurnsByDomOrder(turns) {
    return turns.slice().sort((left, right) => compareDomOrder(left.promptEl, right.promptEl));
  }

  function compareDomOrder(left, right) {
    if (left === right) {
      return 0;
    }
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    const leftRect = typeof left.getBoundingClientRect === "function" ? left.getBoundingClientRect() : null;
    const rightRect = typeof right.getBoundingClientRect === "function" ? right.getBoundingClientRect() : null;
    if (leftRect && rightRect && leftRect.top !== rightRect.top) {
      return leftRect.top > rightRect.top ? 1 : -1;
    }
    return 0;
  }

  function matchPromptToAnswerPoint(promptText, answerText) {
    const points = extractAnswerPoints(answerText);
    if (!points.length) {
      return null;
    }

    const promptVariants = buildPromptMatchVariants(promptText);
    if (!promptVariants.length) {
      return null;
    }

    let bestMatch = null;

    for (const point of points) {
      let score = 0;

      for (const promptVariant of promptVariants) {
        for (const pointVariant of point.variants) {
          score = Math.max(score, scorePromptPointMatch(promptVariant, point.head, pointVariant, point.context));
        }
      }

      if (score >= 18 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = {
          text: point.text,
          head: point.head,
          context: point.context,
          score
        };
      }
    }

    return bestMatch;
  }

  function extractAnswerPoints(answerText) {
    const text = normalizeBlockText(answerText);
    if (!text) {
      return [];
    }

    const prepared = text
      .replace(/([^\n])\s+((?:\d{1,3}|[①②③④⑤⑥⑦⑧⑨⑩])\s*[\.\)、:：])/g, "$1\n$2")
      .replace(/([^\n])\s+([一二三四五六七八九十]+\s*[、.）)])/g, "$1\n$2")
      .replace(/([^\n])\s+((?:[ivxlcdm]+)\s*[\.\)])\s+/gi, "$1\n$2 ")
      .replace(/([^\n])\s+([-*•·▪◦]\s+)/g, "$1\n$2")
      .replace(/([^\n])\s+((?:\*\*|__)[^*_ \n][^*\n]{0,48}(?:\*\*|__)\s*[：:])/g, "$1\n$2");

    const lines = prepared
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const points = [];
    const seen = new Set();
    let currentPoint = "";
    let currentContext = "";

    const pushPointEntry = (pointText, contextText) => {
      const normalizedPoint = normalizeForMatch(pointText);
      if (!normalizedPoint || seen.has(normalizedPoint)) {
        return;
      }

      const head = extractPointHead(pointText);
      if (!head) {
        return;
      }

      seen.add(normalizedPoint);
      points.push({
        text: pointText,
        head,
        context: contextText || "",
        variants: buildPointMatchVariants(pointText, head, contextText)
      });
    };

    const pushPoint = () => {
      if (!currentPoint) {
        currentContext = "";
        return;
      }

      const inlinePoints = extractInlinePoints(currentPoint);
      if (inlinePoints.length) {
        for (const inlinePoint of inlinePoints) {
          pushPointEntry(inlinePoint.text, inlinePoint.context || currentContext);
        }
      } else {
        pushPointEntry(currentPoint, currentContext);
      }

      currentPoint = "";
      currentContext = "";
    };

    for (const line of lines) {
      const inlinePoints = extractInlinePoints(line);
      if (inlinePoints.length) {
        pushPoint();
        for (const inlinePoint of inlinePoints) {
          pushPointEntry(inlinePoint.text, inlinePoint.context);
        }
        continue;
      }

      const pointText = extractPointText(line);
      if (pointText) {
        pushPoint();
        currentPoint = pointText;
        currentContext = extractPointContext(pointText);
        continue;
      }

      if (!currentPoint || !shouldAppendToPoint(line)) {
        continue;
      }

      currentPoint = normalizeText(currentPoint + " " + stripContinuationPrefix(line));
      currentContext = extractPointContext(currentPoint);
    }

    pushPoint();
    return points;
  }

  function extractPointText(line) {
    const normalizedLine = line.replace(/^\s*(?:>\s*)?/, "").trim();
    if (!normalizedLine) {
      return "";
    }

    const bulletMatch = normalizedLine.match(/^(?:\d{1,3}\s*[\.\)、:：]|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[一二三四五六七八九十]+\s*[、.）)]|(?:[ivxlcdm]+)\s*[\.\)]|[-*•·▪◦])\s*(.+)$/i);
    if (bulletMatch) {
      return cleanupPointText(bulletMatch[1]);
    }

    const boldMatch = normalizedLine.match(/^(?:[-*•·▪◦]\s*)?(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*(?:[：:.-]\s*(.+))?$/);
    if (boldMatch) {
      return cleanupPointText([boldMatch[1], boldMatch[2]].filter(Boolean).join("："));
    }

    const headingMatch = normalizedLine.match(/^([A-Za-z][A-Za-z0-9 /-]{1,32}|[\u4e00-\u9fff]{2,16})\s*[：:]\s*(.+)$/);
    if (headingMatch) {
      return cleanupPointText([headingMatch[1], headingMatch[2]].join("："));
    }

    return "";
  }

  function extractPointHead(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return "";
    }

    const parts = normalized.split(/[：:，,。；;（）()]/).map((part) => part.trim()).filter(Boolean);
    const head = parts[0] || normalized;
    return shorten(head, 24);
  }

  function extractPointContext(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return "";
    }

    const colonIndex = normalized.search(/[：:]/);
    if (colonIndex <= 0) {
      return "";
    }

    const prefix = normalized.slice(0, colonIndex).trim();
    if (!prefix || !looksLikeListIntro(prefix)) {
      return "";
    }

    return shorten(prefix, 36);
  }

  function normalizeForMatch(text) {
    return normalizeText(text)
      .toLowerCase()
      .replace(/[“”"'`]/g, "")
      .replace(/[*_]/g, "")
      .replace(/[？?！!。；;：:，,（）()\[\]【】/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripQuestionSuffix(text) {
    return normalizeText(text)
      .replace(/^(请问|请教一下|想问一下|帮我解释一下|帮我说明一下|那|那么|再问一下|顺便问一下|继续问一下|再说说|继续说说|另外)\s*/g, "")
      .replace(/\b(please|explain|describe|define|tell me|what is|what are|how does)\b/g, " ")
      .replace(/^(关于|对于|这个|这个问题|这个点|这种|这些|前面说的|上面说的|刚才说的)\s*/g, "")
      .replace(/(是什么|什么意思|是啥|指什么|怎么理解|请解释|解释一下|展开讲讲|详细说说|说一下|讲讲|介绍一下|介绍下|为什么|为何|怎么|如何|呢|吗|嘛|呀|啊|吧|么)+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildPromptMatchVariants(promptText) {
    const normalized = normalizeForMatch(promptText);
    const stripped = stripQuestionSuffix(normalized);
    const subjectLike = stripPromptIntent(stripped);
    const compactSubject = subjectLike.replace(/\b(的|地|得)\b/g, " ").trim();
    const variants = Array.from(new Set([
      stripped,
      normalized,
      subjectLike,
      compactSubject
    ].filter((item) => item && item.length >= 2)));

    return variants;
  }

  function stripPromptIntent(text) {
    return normalizeText(text)
      .replace(/^(什么是|什么叫|什么叫做|什么叫作|为什么说|为什么|为何|怎么|如何|是否|能否|可否|有没有|哪里|哪个|哪些|多少|几种)\s*/g, "")
      .replace(/\s*(是什么|什么意思|是啥|指什么|怎么理解|为什么|为何|怎么|如何)\s*$/g, "")
      .replace(/\b(what|why|how|when|where|which)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildPointMatchVariants(pointText, headText, contextText) {
    const variants = [
      pointText,
      headText,
      contextText ? contextText + " " + headText : "",
      contextText ? contextText + " " + pointText : ""
    ];

    return Array.from(new Set(variants
      .map((item) => stripQuestionSuffix(normalizeForMatch(item)))
      .filter((item) => item && item.length >= 2)));
  }

  function scorePromptPointMatch(promptText, headText, pointText, contextText) {
    const promptCore = stripPromptIntent(promptText) || promptText;
    const pointCore = stripQuestionSuffix(pointText) || pointText;
    const headCore = stripQuestionSuffix(normalizeForMatch(headText)) || normalizeForMatch(headText);
    const contextCore = stripQuestionSuffix(normalizeForMatch(contextText)) || normalizeForMatch(contextText);
    let score = Math.max(
      getTextSimilarityScore(promptCore, pointCore) + 4,
      getTextSimilarityScore(promptCore, headCore) + 2
    );

    if (contextCore) {
      score = Math.max(score, getTextSimilarityScore(promptCore, contextCore + " " + pointCore));
    }

    if (compactMatchText(promptCore) === compactMatchText(headCore)) {
      score += 18;
    }
    if (compactMatchText(pointCore).includes(compactMatchText(promptCore))) {
      score += Math.min(12, compactMatchText(promptCore).length * 2);
    }
    if (isGenericPointHead(headCore)) {
      score -= 6;
    }

    return score;
  }

  function findPromptContinuationParent(promptText, answeredPrompts) {
    const latestPrompt = answeredPrompts[answeredPrompts.length - 1];
    if (!latestPrompt) {
      return null;
    }

    const promptVariants = buildPromptMatchVariants(promptText);
    let score = 0;

    for (const promptVariant of promptVariants) {
      score = Math.max(score, scorePromptContinuation(promptText, promptVariant, latestPrompt));
    }

    if (score < 18) {
      return null;
    }

    return {
      parentSignature: latestPrompt.signature,
      point: { text: "", head: "", score },
      score,
      mode: "continuation"
    };
  }

  function scorePromptContinuation(rawPromptText, promptVariant, candidate) {
    const promptCore = stripPromptIntent(stripQuestionSuffix(promptVariant)) || promptVariant;
    const previousPrompt = stripPromptIntent(stripQuestionSuffix(normalizeForMatch(candidate.fullText || candidate.title || "")));
    const previousAnswer = normalizeForMatch(candidate.answer || "");
    const promptSimilarity = getTextSimilarityScore(promptCore, previousPrompt) + 4;
    const answerOverlap = getTokenOverlapScore(promptCore, previousAnswer);
    const answerCoverage = getTokenCoverageScore(promptCore, previousAnswer);
    const answerLcs = getLongestCommonSubstringScore(promptCore, previousAnswer);
    const semanticScore = Math.max(promptSimilarity, answerOverlap + answerCoverage + answerLcs);
    const hasCue = hasContinuationCue(rawPromptText);
    const hasReference = hasReferenceCue(rawPromptText);
    const elliptical = isEllipticalPrompt(rawPromptText);
    let score = semanticScore;

    if (hasReference) {
      score += 10;
    }
    if (hasCue && (hasReference || semanticScore >= 8)) {
      score += 6;
    }
    if (elliptical && (hasReference || semanticScore >= 10)) {
      score += 6;
    }

    return score;
  }

  function getTokenOverlapScore(left, right) {
    if (!left || !right) {
      return 0;
    }

    const leftTokens = extractMatchTokens(left);
    const rightTokens = new Set(extractMatchTokens(right));
    if (!leftTokens.length || !rightTokens.size) {
      return 0;
    }

    let score = 0;
    for (const token of leftTokens) {
      if (token.length < 2) {
        continue;
      }
      if (rightTokens.has(token)) {
        score += token.length >= 4 ? 4 : 2;
      }
    }
    return score;
  }

  function getTokenCoverageScore(left, right) {
    const leftTokens = extractMatchTokens(left).filter((token) => token.length >= 2);
    const rightTokens = new Set(extractMatchTokens(right));
    if (!leftTokens.length || !rightTokens.size) {
      return 0;
    }

    let matched = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) {
        matched += 1;
      }
    }

    return Math.round((matched / leftTokens.length) * 16);
  }

  function extractMatchTokens(text) {
    const normalized = normalizeForMatch(text);
    if (!normalized) {
      return [];
    }

    const latinTokens = normalized.match(/[a-z0-9]{2,}/g) || [];
    const chineseChunks = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const chineseTokens = [];

    for (const chunk of chineseChunks) {
      chineseTokens.push(chunk);
      for (let index = 0; index < chunk.length - 1; index += 1) {
        chineseTokens.push(chunk.slice(index, index + 2));
        if (index < chunk.length - 2) {
          chineseTokens.push(chunk.slice(index, index + 3));
        }
      }
    }

    return Array.from(new Set(latinTokens.concat(chineseTokens)));
  }

  function compactMatchText(text) {
    return normalizeForMatch(text).replace(/\s+/g, "");
  }

  function getTextSimilarityScore(left, right) {
    if (!left || !right) {
      return 0;
    }

    const compactLeft = compactMatchText(left);
    const compactRight = compactMatchText(right);
    if (!compactLeft || !compactRight) {
      return 0;
    }

    let score = 0;

    if (compactLeft === compactRight) {
      score = Math.max(score, 90);
    } else if (compactLeft.includes(compactRight) || compactRight.includes(compactLeft)) {
      score = Math.max(score, 58 + Math.min(compactLeft.length, compactRight.length));
    }

    const overlap = getTokenOverlapScore(left, right);
    const coverage = getTokenCoverageScore(left, right);
    const ngramScore = getCharacterNGramScore(left, right);
    const lcsScore = getLongestCommonSubstringScore(left, right);

    score = Math.max(score, overlap + coverage + ngramScore + lcsScore);
    return score;
  }

  function getCharacterNGramScore(left, right) {
    const leftNgrams = extractCharacterNGrams(left);
    const rightNgrams = extractCharacterNGrams(right);
    if (!leftNgrams.length || !rightNgrams.length) {
      return 0;
    }

    const rightSet = new Set(rightNgrams);
    let matched = 0;
    for (const gram of leftNgrams) {
      if (rightSet.has(gram)) {
        matched += 1;
      }
    }

    return Math.round((2 * matched / (leftNgrams.length + rightNgrams.length)) * 18);
  }

  function extractCharacterNGrams(text) {
    const compact = compactMatchText(text);
    if (!compact) {
      return [];
    }
    if (compact.length <= 3) {
      return [compact];
    }

    const grams = [];
    for (let size = 2; size <= 3; size += 1) {
      if (compact.length < size) {
        continue;
      }
      for (let index = 0; index <= compact.length - size; index += 1) {
        grams.push(compact.slice(index, index + size));
      }
    }
    return Array.from(new Set(grams));
  }

  function getLongestCommonSubstringScore(left, right) {
    const compactLeft = compactMatchText(left);
    const compactRight = compactMatchText(right);
    if (!compactLeft || !compactRight) {
      return 0;
    }

    let longest = 0;
    for (let leftIndex = 0; leftIndex < compactLeft.length; leftIndex += 1) {
      for (let rightIndex = 0; rightIndex < compactRight.length; rightIndex += 1) {
        let matched = 0;
        while (
          compactLeft[leftIndex + matched] &&
          compactLeft[leftIndex + matched] === compactRight[rightIndex + matched]
        ) {
          matched += 1;
        }
        if (matched > longest) {
          longest = matched;
        }
      }
    }

    return Math.round((longest / Math.max(1, Math.min(compactLeft.length, compactRight.length))) * 16);
  }

  function shouldAppendToPoint(line) {
    const normalizedLine = line.replace(/^\s*(?:>\s*)?/, "").trim();
    if (!normalizedLine) {
      return false;
    }
    if (/^(?:\d{1,3}\s*[\.\)、:：]|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[一二三四五六七八九十]+\s*[、.）)]|(?:[ivxlcdm]+)\s*[\.\)]|[-*•·▪◦])\s*/i.test(normalizedLine)) {
      return false;
    }
    return true;
  }

  function stripContinuationPrefix(text) {
    return normalizeText(text.replace(/^\s*(?:>\s*)?(?:[-*•·▪◦]\s*)?/, ""));
  }

  function cleanupPointText(text) {
    return normalizeText(String(text || "")
      .replace(/^(?:[：:.-]\s*)+/, "")
      .replace(/\s*[：:.-]\s*$/, "")
      .replace(/[*_]/g, ""));
  }

  function extractInlinePoints(text) {
    const prepared = cleanupPointText(text);
    if (!prepared) {
      return [];
    }

    const inlineList = extractInlineList(prepared);
    if (!inlineList) {
      return [];
    }

    return inlineList.items.map((item) => ({
      text: item,
      context: inlineList.context
    }));
  }

  function extractInlineList(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return null;
    }

    const colonMatch = normalized.match(/^(.{1,40}?)\s*[：:]\s*(.+)$/);
    if (colonMatch && looksLikeListIntro(colonMatch[1])) {
      const items = splitInlinePointSegments(colonMatch[2]);
      if (items.length >= 2) {
        return {
          context: shorten(colonMatch[1], 36),
          items
        };
      }
    }

    const introMatch = normalized.match(/^(.{0,40}?)(?:包括|包含|常见的有|主要有|一般有|特点有|优点有|缺点有|原因有|方面有|步骤有|流程有|分为|可分为)\s*(.+)$/);
    if (introMatch && looksLikeListIntro(introMatch[1] || normalized)) {
      const items = splitInlinePointSegments(introMatch[2]);
      if (items.length >= 2) {
        return {
          context: shorten((introMatch[1] || "").trim(), 36),
          items
        };
      }
    }

    const standaloneItems = splitInlinePointSegments(normalized);
    if (standaloneItems.length >= 2) {
      return {
        context: "",
        items: standaloneItems
      };
    }

    return null;
  }

  function looksLikeListIntro(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }

    return normalized.length <= 40 && /(?:以下|如下|包括|包含|分为|特点|特性|优点|缺点|原因|步骤|流程|方面|类型|分类|阶段|条件|要点|组成|结构|原则|场景|用途|区别|联系|问题|核心|功能|方法|机制|部分|环节|概念|定义|总结|注意事项|状态码|命令|参数|字段|返回值|选项|协议|模式|层次|成员|接口)/.test(normalized);
  }

  function splitInlinePointSegments(text) {
    const normalized = cleanupPointText(text).replace(/[。！？!?]+$/g, "");
    if (!normalized) {
      return [];
    }

    let segments = normalized
      .split(/\s*(?:、|，|,|；|;|\/|\\|\band\b|\bor\b|以及|及|或)\s*/i)
      .map((item) => cleanupPointText(item))
      .filter(Boolean);

    if (segments.length < 2 && /和/.test(normalized)) {
      const andSegments = normalized
        .split(/\s*和\s*/g)
        .map((item) => cleanupPointText(item))
        .filter(Boolean);
      if (andSegments.length >= 2 && andSegments.every(isLikelyAtomicPoint)) {
        segments = andSegments;
      }
    }

    segments = Array.from(new Set(segments.filter(isLikelyAtomicPoint)));
    return segments.length >= 2 && segments.length <= 8 ? segments : [];
  }

  function isLikelyAtomicPoint(text) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 2 || normalized.length > 24) {
      return false;
    }

    if (/[。！？!?]/.test(normalized)) {
      return false;
    }

    return !/(因为|所以|如果|但是|不过|例如|比如|通常|可以|能够|需要|用于|表示|意味着|原因是|步骤是)/.test(normalized);
  }

  function isGenericPointHead(text) {
    const normalized = normalizeForMatch(text);
    if (!normalized) {
      return false;
    }

    return /(?:以下|如下|主要|特点|特性|优点|缺点|原因|步骤|流程|方面|类型|分类|阶段|条件|要点|组成|结构|原则|场景|用途|区别|联系|问题|核心|功能|方法|机制|部分|环节|概念|定义|总结)$/.test(normalized);
  }

  function hasContinuationCue(text) {
    const normalized = normalizeText(text);
    return /^(那|那么|然后|接着|继续|再|另外|顺便|这里|接下来)/.test(normalized);
  }

  function hasReferenceCue(text) {
    const normalized = normalizeText(text);
    return /(这个|这个点|这个问题|这一点|这个概念|这里|这种|这些|它|其|上述|上面说的|前面提到的)/.test(normalized);
  }

  function isEllipticalPrompt(text) {
    const normalized = normalizeText(text);
    return normalized.length <= 12 && /[呢吗嘛呀啊?？]$/.test(normalized);
  }

  function syncTree(entries) {
    state.domNodeMap.clear();
    const now = Date.now();
    let parentId = state.tree.rootId;
    const seenNodeIds = new Set();
    const seenSignatures = new Set();
    const seenPromptIndices = new Set();
    const signatureNodeMap = new Map();
    const nodeIndexes = buildNodeIndexes(state.tree);

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const resolvedParentId = resolveParentId(parentId, entry, signatureNodeMap, nodeIndexes);
      const originalPromptIndex = Number.isFinite(entry.originalPromptIndex) ? entry.originalPromptIndex : index;
      const node = findOrCreateNode(resolvedParentId, entry, originalPromptIndex, now, signatureNodeMap, nodeIndexes);
      node.title = entry.title;
      node.answer = entry.answer;
      node.signature = entry.signature;
      if (entry.askedAt) {
        node.askedAt = entry.askedAt;
      }
      node.promptIndex = originalPromptIndex;
      node.updatedAt = now;
      node.lastSeenAt = now;
      state.domNodeMap.set(node.id, entry.promptEl);
      entry.promptEl.dataset.cgptTreeNodeId = node.id;
      seenNodeIds.add(node.id);
      if (entry.signature) {
        seenSignatures.add(entry.signature);
      }
      seenPromptIndices.add(originalPromptIndex);
      signatureNodeMap.set(entry.signature, node.id);
      indexNode(nodeIndexes, node);
      parentId = node.id;
    }

    pruneNodes(seenNodeIds, seenSignatures, seenPromptIndices, now);
    if (state.tree.linearSortEnabled) {
      applyLinearSortMode(false);
    } else {
      rebuildChildren(state.tree);
    }
    markTreeStructureDirty();
    saveTree();
  }

  function resolveParentId(parentId, entry, signatureNodeMap, nodeIndexes) {
    if (!entry.parentSignature) {
      return parentId;
    }

    if (entry.parentSignature === ROOT_PARENT_SIGNATURE) {
      return state.tree.rootId;
    }

    const matchedParentId = signatureNodeMap.get(entry.parentSignature) || findNodeIdBySignature(entry.parentSignature, nodeIndexes);
    return matchedParentId || parentId;
  }

  function findNodeIdBySignature(signature, nodeIndexes) {
    if (!signature) {
      return "";
    }
    if (nodeIndexes?.bySignature?.has(signature)) {
      return nodeIndexes.bySignature.get(signature);
    }

    const match = Object.values(state.tree.nodes).find((node) => {
      return node.id !== "root" && node.signature === signature;
    });

    return match ? match.id : "";
  }

  function findOrCreateNode(parentId, entry, promptIndex, timestamp, signatureNodeMap, nodeIndexes) {
    let node = nodeIndexes.byPromptSignature.get(getPromptSignatureKey(promptIndex, entry.signature));

    if (!node) {
      const siblings = getChildren(parentId);
      node = siblings.find((candidate) => candidate.signature === entry.signature);
    }

    if (!node) {
      node = nodeIndexes.byParentSignature.get(getParentSignatureKey(parentId, entry.signature));
    }

    if (!node) {
      const id = makeNodeId();
      node = {
        id,
        parentId,
        children: [],
        title: entry.title,
        answer: entry.answer,
        signature: entry.signature,
        askedAt: entry.askedAt || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        collapsed: false,
        promptIndex,
        lastSeenAt: timestamp
      };
      state.tree.nodes[id] = node;
    }

    node.parentId = resolveStoredParentId(node, parentId, signatureNodeMap);
    return node;
  }

  function buildNodeIndexes(tree) {
    const indexes = {
      byPromptSignature: new Map(),
      byParentSignature: new Map(),
      bySignature: new Map()
    };
    for (const node of Object.values(tree?.nodes || {})) {
      indexNode(indexes, node);
    }
    return indexes;
  }

  function indexNode(indexes, node) {
    if (!indexes || !node || node.id === state.tree.rootId) {
      return;
    }
    if (Number.isInteger(node.promptIndex) && node.signature) {
      indexes.byPromptSignature.set(getPromptSignatureKey(node.promptIndex, node.signature), node);
    }
    if (node.parentId && node.signature) {
      indexes.byParentSignature.set(getParentSignatureKey(node.parentId, node.signature), node);
    }
    if (node.signature && !indexes.bySignature.has(node.signature)) {
      indexes.bySignature.set(node.signature, node.id);
    }
  }

  function getPromptSignatureKey(promptIndex, signature) {
    return String(promptIndex) + "\n" + String(signature || "");
  }

  function getParentSignatureKey(parentId, signature) {
    return String(parentId || "") + "\n" + String(signature || "");
  }

  function resolveStoredParentId(node, fallbackParentId, signatureNodeMap) {
    if (!node || !node.parentId) {
      return fallbackParentId;
    }

    if (node.parentId === state.tree.rootId) {
      return state.tree.rootId;
    }

    const storedParent = state.tree.nodes[node.parentId];
    if (!storedParent?.signature) {
      return fallbackParentId;
    }

    return signatureNodeMap.get(storedParent.signature) || fallbackParentId;
  }

  function getChildren(parentId) {
    const parent = state.tree.nodes[parentId];
    if (!parent) {
      return [];
    }
    return parent.children
      .map((childId) => state.tree.nodes[childId])
      .filter(Boolean);
  }

  function pruneNodes(seenNodeIds, seenSignatures, seenPromptIndices, timestamp) {
    const tree = state.tree;

    // Remove stale duplicates when a node was manually moved and then re-scanned.
    for (const node of Object.values(tree.nodes)) {
      if (node.id === tree.rootId || seenNodeIds.has(node.id)) {
        continue;
      }

      const hasSeenSignature = Boolean(node.signature) && seenSignatures.has(node.signature);
      const hasSeenPromptIndex = Number.isInteger(node.promptIndex) && seenPromptIndices.has(node.promptIndex);
      if (hasSeenSignature || hasSeenPromptIndex) {
        removeNode(node.id);
      }
    }

    const allNodes = Object.values(tree.nodes)
      .filter((node) => node.id !== tree.rootId)
      .sort((a, b) => (a.updatedAt - b.updatedAt) || (a.createdAt - b.createdAt));

    while (allNodes.length > MAX_NODES) {
      const candidate = allNodes.shift();
      if (!candidate || seenNodeIds.has(candidate.id)) {
        continue;
      }
      removeNode(candidate.id);
    }

    for (const node of Object.values(tree.nodes)) {
      if (node.id === tree.rootId) {
        continue;
      }
      if (!Number.isFinite(node.lastSeenAt) || node.lastSeenAt <= 0) {
        node.lastSeenAt = timestamp;
      }
    }
  }

  function removeNode(nodeId) {
    const node = state.tree.nodes[nodeId];
    if (!node) {
      return;
    }
    for (const childId of node.children) {
      const child = state.tree.nodes[childId];
      if (child) {
        child.parentId = node.parentId || state.tree.rootId;
      }
    }
    delete state.tree.nodes[nodeId];
    state.domNodeMap.delete(nodeId);
    if (state.activeNodeId === nodeId) {
      state.activeNodeId = null;
    }
    markTreeStructureDirty();
  }

  function markTreeStructureDirty() {
    state.treeStructureVersion += 1;
    if (state.tree) {
      state.tree.version = state.treeStructureVersion;
    }
  }

  function updateSearchResults(openFirstMatch) {
    const query = normalizeText(state.tree.searchQuery || "").toLowerCase();
    if (!query) {
      state.searchResults = [];
      state.searchIndex = -1;
      updateResultBadge();
      return;
    }

    state.searchResults = Object.values(state.tree.nodes)
      .filter((node) => node.id !== "root")
      .filter((node) => {
        const haystack = (node.title || "").toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
      .map((node) => node.id);

    if (state.searchIndex >= state.searchResults.length) {
      state.searchIndex = -1;
    }

    if (openFirstMatch && state.searchResults.length) {
      const firstIndex = state.searchIndex >= 0 ? state.searchIndex : 0;
      revealAncestors(state.searchResults[firstIndex]);
    }

    updateResultBadge();
  }

  function updateResultBadge() {
    if (!state.resultBadge) {
      return;
    }

    const pendingQuery = normalizeText(state.searchDraft || "");
    const appliedQuery = normalizeText(state.tree.searchQuery || "");

    if (state.searchApplyButton) {
      const shouldCancel = pendingQuery === appliedQuery && Boolean(appliedQuery);
      state.searchApplyButton.textContent = shouldCancel ? "取消" : "搜索";
      state.searchApplyButton.title = shouldCancel ? "取消搜索" : "搜索（Enter）";
      state.searchApplyButton.setAttribute("aria-label", shouldCancel ? "取消搜索" : "搜索");
      state.searchApplyButton.classList.toggle("is-cancel", shouldCancel);
    }

    const pendingNormalized = pendingQuery.toLowerCase();
    const appliedNormalized = appliedQuery.toLowerCase();
    if (pendingNormalized !== appliedNormalized) {
      state.resultBadge.textContent = pendingNormalized ? "按 Enter 或点击搜索" : "按 Enter 或点击搜索清除";
      return;
    }

    if (!state.searchResults.length) {
      state.resultBadge.textContent = appliedQuery ? "0 个匹配" : "未搜索";
      return;
    }
    const currentIndex = state.searchIndex >= 0 ? state.searchIndex : 0;
    state.resultBadge.textContent = (currentIndex + 1) + " / " + state.searchResults.length + " 个匹配";
  }

  function moveSearch(step) {
    if (!state.searchResults.length) {
      updateResultBadge();
      return;
    }
    state.searchIndex = (state.searchIndex + step + state.searchResults.length) % state.searchResults.length;
    const nodeId = state.searchResults[state.searchIndex];
    const layoutChanged = revealAncestors(nodeId);
    updateResultBadge();
    if (layoutChanged) {
      state.renderVersion += 1;
      renderTree();
    } else {
      updateRenderedActiveNodeClasses(state.activeNodeId, nodeId);
    }
    jumpToNode(nodeId);
  }

  function setAllCollapsed(collapsed) {
    let changed = false;
    for (const node of Object.values(state.tree.nodes)) {
      if (node.id !== "root" && node.children.length && node.collapsed !== collapsed) {
        node.collapsed = collapsed;
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    state.renderVersion += 1;
    saveTree();
    renderTree();
  }

  function revealAncestors(nodeId) {
    let changed = false;
    let cursor = state.tree.nodes[nodeId];
    while (cursor && cursor.parentId) {
      const parent = state.tree.nodes[cursor.parentId];
      if (!parent) {
        break;
      }
      if (parent.collapsed) {
        parent.collapsed = false;
        changed = true;
      }
      cursor = parent.id === "root" ? null : parent;
    }
    return changed;
  }

  function renderTree() {
    if (!state.body) {
      return;
    }
    const renderStartedAt = performance.now();

    if (isConversationClosed()) {
      state.renderedFingerprint = "";
      state.body.innerHTML = "";
      return;
    }

    const previousScrollLeft = state.body.scrollLeft;
    const previousScrollTop = state.body.scrollTop;

    const layout = buildVisibleLayout();
    const fingerprint = [
      "tree:" + (state.tree?.version || 0),
      "render:" + state.renderVersion,
      "collapsed:" + Number(Boolean(state.tree.panelCollapsed)),
      "search:" + (state.tree.searchQuery || ""),
      "active:" + (state.activeNodeId || ""),
      "layout:" + layout.map((item) => item.id + "@" + item.depth).join("|"),
      "drag:" + [state.drag.sourceId || "", state.drag.targetId || "", state.drag.invalidTargetId || ""].join(":")
    ].join(";");

    if (fingerprint === state.renderedFingerprint) {
      updateSummary(layout.length);
      return;
    }
    state.renderedFingerprint = fingerprint;

    state.body.innerHTML = "";
    updateSummary(layout.length);

    if (!layout.length) {
      const empty = document.createElement("div");
      empty.className = "cgpt-tree-empty";
      empty.textContent = "尚未检测到提示词。请打开一个 ChatGPT 对话并发送消息。";
      state.body.appendChild(empty);
      return;
    }

    const width = getTreeCanvasWidth(layout);
    const height = Math.max(88, layout.length * NODE_ROW_HEIGHT + 4);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "cgpt-tree-svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    for (const item of layout) {
      if (item.parentLayout) {
        svg.appendChild(createLink(item.parentLayout, item));
      }
    }
    for (const item of layout) {
      svg.appendChild(createNodeGroup(item));
    }

    state.body.appendChild(svg);
    state.body.scrollLeft = previousScrollLeft;
    state.body.scrollTop = previousScrollTop;
    syncRenderedActiveNodeClasses();
    const durationMs = Math.round(performance.now() - renderStartedAt);
    if (durationMs > 120) {
      logger?.warn("render-slow", {
        durationMs,
        visibleCount: layout.length,
        width,
        height
      });
    }
    window.requestAnimationFrame(() => {
      scrollTreeNodeIntoView(state.activeNodeId);
    });
  }

  function getTreeCanvasWidth(layout) {
    const bodyWidth = Math.max(300, state.body.clientWidth - 4);
    const estimatedContentWidth = layout.reduce((maxWidth, item) => {
      const textWidth = estimateNodeLabelWidth("", getNodeDisplayTitle(item.node));
      return Math.max(maxWidth, item.x + textWidth + 56);
    }, 0);
    return Math.max(bodyWidth, estimatedContentWidth);
  }

  function estimateNodeLabelWidth(orderText, titleText) {
    const normalized = normalizeText([orderText, titleText].filter(Boolean).join(" "));
    let width = 0;
    for (const char of normalized) {
      width += /[\u4e00-\u9fff]/.test(char) ? 13 : 7;
    }
    return Math.max(96, Math.min(960, width));
  }

  function updateSummary(visibleCount) {
    if (isConversationClosed()) {
      const reason = state.isConversationPermanentlyClosed
        ? "此对话已永久关闭，可在插件设置页重新开启。"
        : "此对话本次访问已关闭，下次访问会自动恢复。";
      state.summary.textContent = reason;
      updateResultBadge();
      return;
    }
    const deletedCount = Math.max(
      Array.isArray(state.tree.ignoredPromptIndices) ? state.tree.ignoredPromptIndices.length : 0,
      Array.isArray(state.tree.ignoredSignatures) ? state.tree.ignoredSignatures.length : 0,
      Array.isArray(state.tree.ignoredTitles) ? state.tree.ignoredTitles.length : 0
    );
    const total = Math.max(0, Object.keys(state.tree.nodes).length - 1) + deletedCount;
    const searchSuffix = state.tree.searchQuery ? " • 已筛选" : "";
    state.summary.textContent = "已跟踪 " + total + " 个问题 • 当前可见 " + visibleCount + " 个问题 • 已删除 " + deletedCount + " 个问题" + searchSuffix;
    updateResultBadge();
  }

  function isConversationClosable() {
    return shouldPersistTreeState();
  }

  function isConversationClosed() {
    return Boolean(state.isConversationTemporarilyClosed || state.isConversationPermanentlyClosed);
  }

  function setConversationWorkSuspended(shouldSuspend) {
    const nextValue = Boolean(shouldSuspend);
    if (state.workSuspended === nextValue) {
      // The extension starts with workSuspended=false. Ensure we still attach the observer on first boot
      // (and after any case where the observer was disconnected but the flag didn't change).
      if (!nextValue) {
        observeConversation();
      }
      return;
    }
    state.workSuspended = nextValue;

    if (state.workSuspended) {
      window.clearTimeout(state.scanTimer);
      state.scanTimer = null;
      state.deferredScanDelay = null;
      state.deferredScanRequest = null;
      state.scanInFlight = false;

      if (state.observer) {
        state.observer.disconnect();
      }
      updateBusyControls();
      return;
    }

    observeConversation();
    scheduleScan(120);
  }

  async function syncConversationClosedState() {
    const closable = isConversationClosable();
    let temporaryClosed = false;
    let permanentClosed = false;
    try {
      if (closable) {
        const stored = await chrome.storage.local.get(getPermanentCloseStorageKey());
        permanentClosed = Boolean(stored[getPermanentCloseStorageKey()]);
      }
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to read permanent close state", error);
    } finally {
      state.isConversationTemporarilyClosed = temporaryClosed;
      state.isConversationPermanentlyClosed = permanentClosed;
      state.closeStateLoaded = true;
      updateConversationVisibility();
      renderTree();
    }
  }

  function updateConversationVisibility() {
    if (!state.panel) {
      return;
    }
    const hidden = isConversationClosed();
    state.panel.hidden = hidden;
    if (hidden) {
      hideHoverTooltip();
      if (state.activeNodeId) {
        state.activeNodeId = null;
        clearManualActiveNodePin();
      }
      applyActiveHighlight();
      syncRenderedActiveNodeClasses();
    }
    setConversationWorkSuspended(hidden);
    if (state.closeMenu) {
      state.closeMenu.classList.add("cgpt-tree-hidden");
    }
  }

  async function setConversationClosedMode(mode) {
    const closable = isConversationClosable();
    if (!closable) {
      state.isConversationTemporarilyClosed = false;
      state.isConversationPermanentlyClosed = false;
      state.closeStateLoaded = true;
      updateConversationVisibility();
      renderTree();
      return;
    }

    const permanentKey = getPermanentCloseStorageKey();
    if (mode === "temporary") {
      await chrome.storage.local.remove(permanentKey);
      state.isConversationTemporarilyClosed = true;
      state.isConversationPermanentlyClosed = false;
    } else if (mode === "permanent") {
      await chrome.storage.local.set({ [permanentKey]: true });
      state.isConversationTemporarilyClosed = false;
      state.isConversationPermanentlyClosed = true;
    } else {
      await chrome.storage.local.remove(permanentKey);
      state.isConversationTemporarilyClosed = false;
      state.isConversationPermanentlyClosed = false;
    }
    state.closeStateLoaded = true;
    updateConversationVisibility();
    renderTree();
  }

  async function getConversationStatusPayload() {
    if (!state.closeStateLoaded) {
      await syncConversationClosedState();
    }
    return {
      ok: true,
      chatKey: state.chatKey,
      title: document.title || "",
      closable: isConversationClosable(),
      temporaryClosed: state.isConversationTemporarilyClosed,
      permanentClosed: state.isConversationPermanentlyClosed,
      closed: isConversationClosed()
    };
  }

  function buildVisibleLayout() {
    const items = [];
    let row = 0;
    const query = normalizeText(state.tree.searchQuery || "").toLowerCase();
    const descendantMatchCache = new Map();

    function hasMatchingDescendantCached(nodeId) {
      if (descendantMatchCache.has(nodeId)) {
        return descendantMatchCache.get(nodeId);
      }
      const node = state.tree.nodes[nodeId];
      if (!node) {
        descendantMatchCache.set(nodeId, false);
        return false;
      }
      const result = node.children.some((childId) => {
        const child = state.tree.nodes[childId];
        return child && (nodeMatchesQuery(child, query) || hasMatchingDescendantCached(childId));
      });
      descendantMatchCache.set(nodeId, result);
      return result;
    }

    function walk(nodeId, depth, parentLayout) {
      const node = state.tree.nodes[nodeId];
      if (!node) {
        return;
      }
      const matches = !query || nodeMatchesQuery(node, query);
      const descendantMatches = query ? hasMatchingDescendantCached(nodeId) : false;
      if (query && !matches && !descendantMatches) {
        return;
      }
      const layout = {
        id: nodeId,
        node,
        depth,
        x: 28 + depth * NODE_INDENT,
        y: 16 + row * NODE_ROW_HEIGHT,
        parentLayout
      };
      items.push(layout);
      row += 1;

      if (node.collapsed && !(query && descendantMatches)) {
        return;
      }
      for (const childId of node.children) {
        walk(childId, depth + 1, layout);
      }
    }

    for (const childId of state.tree.nodes.root.children) {
      walk(childId, 0, null);
    }

    return items;
  }

  function nodeMatchesQuery(node, query) {
    const haystack = normalizeText(node.title || "").toLowerCase();
    return haystack.includes(query);
  }

  function hasMatchingDescendant(nodeId, query) {
    const node = state.tree.nodes[nodeId];
    if (!node) {
      return false;
    }
    return node.children.some((childId) => {
      const child = state.tree.nodes[childId];
      return child && (nodeMatchesQuery(child, query) || hasMatchingDescendant(childId, query));
    });
  }

  function createLink(from, to) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const startX = from.x + 16;
    const startY = from.y;
    const endX = to.x - 10;
    const endY = to.y;
    const midX = Math.round((startX + endX) / 2);
    path.setAttribute("class", "cgpt-tree-link");
    path.setAttribute("d", "M " + startX + " " + startY + " C " + midX + " " + startY + ", " + midX + " " + endY + ", " + endX + " " + endY);
    return path;
  }

  function createNodeGroup(item) {
    const node = item.node;
    const isActive = item.id === state.activeNodeId;
    const fullTitle = normalizeText(node.title || "") || "未命名提示词";
    const displayTitle = getNodeDisplayTitle(node);
    const bodyWidth = Math.max(
      Number(state.body?.clientWidth) || 0,
      Number(state.body?.scrollWidth) || 0,
      640
    );
    const hitboxWidth = Math.max(
      bodyWidth,
      estimateNodeLabelWidth(formatNodeOrder(node), displayTitle) + 120
    );
    const showFullTitleOnHover = displayTitle !== fullTitle;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const classNames = ["cgpt-tree-node"];
    if (isActive) {
      classNames.push("active");
    }
    if (isSearchMatch(item.id)) {
      classNames.push("search-match");
    }
    if (isSearchCurrent(item.id)) {
      classNames.push("search-current");
    }
    if (state.drag.targetId === item.id) {
      classNames.push("drop-target");
    }
    if (state.drag.invalidTargetId === item.id) {
      classNames.push("drop-invalid");
    }
    if (state.drag.sourceId === item.id) {
      classNames.push("drag-source");
    }
    group.setAttribute("class", classNames.join(" "));
    group.setAttribute("transform", "translate(" + item.x + " " + item.y + ")");
    group.dataset.id = item.id;

    const hitbox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    hitbox.setAttribute("class", "cgpt-tree-hitbox");
    hitbox.setAttribute("x", "-26");
    hitbox.setAttribute("y", "-16");
    hitbox.setAttribute("width", String(hitboxWidth));
    hitbox.setAttribute("height", "34");
    bindNodeInteraction(hitbox, item.id, {
      jumpNodeId: item.id,
      tooltipText: showFullTitleOnHover ? fullTitle : ""
    });
    group.appendChild(hitbox);

    if (node.children.length) {
      group.appendChild(createToggle(item.id, node.collapsed));
    }

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "0");
    circle.setAttribute("cy", "0");
    circle.setAttribute("r", "8");
    group.appendChild(circle);

    const order = document.createElementNS("http://www.w3.org/2000/svg", "text");
    order.setAttribute("class", "cgpt-tree-node-order");
    order.setAttribute("x", "0");
    order.setAttribute("y", "3");
    order.setAttribute("text-anchor", "middle");
    order.textContent = formatNodeOrder(node);
    group.appendChild(order);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "cgpt-tree-node-label");
    label.setAttribute("x", "18");
    label.setAttribute("y", "4");
    label.textContent = displayTitle;
    group.appendChild(label);

    return group;
  }

  function createToggle(nodeId, collapsed) {
    const toggle = document.createElementNS("http://www.w3.org/2000/svg", "g");
    toggle.setAttribute("class", "cgpt-tree-toggle");
    toggle.setAttribute("transform", "translate(-24 -6)");
    toggle.dataset.role = "node-toggle";
    toggle.dataset.id = nodeId;

    toggle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (Date.now() < state.suppressClickUntil || state.drag.dragging) {
        return;
      }
      toggleNodeCollapsed(nodeId);
    });

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "12");
    rect.setAttribute("rx", "3");
    toggle.appendChild(rect);

    const h = document.createElementNS("http://www.w3.org/2000/svg", "path");
    h.setAttribute("class", "cgpt-tree-toggle-mark");
    h.setAttribute("d", "M 3 6 L 9 6");
    toggle.appendChild(h);

    if (collapsed) {
      const v = document.createElementNS("http://www.w3.org/2000/svg", "path");
      v.setAttribute("class", "cgpt-tree-toggle-mark");
      v.setAttribute("d", "M 6 3 L 6 9");
      toggle.appendChild(v);
    }

    return toggle;
  }

  function toggleNodeCollapsed(nodeId) {
    const node = state.tree.nodes[nodeId];
    if (!node || !node.children.length) {
      return;
    }
    captureUndoState();
    node.collapsed = !node.collapsed;
    state.renderVersion += 1;
    saveTree();
    renderTree();
  }

  function bindNodeInteraction(element, nodeId, options) {
    const jumpNodeId = options?.jumpNodeId || "";
    const tooltipText = String(options?.tooltipText || "").trim();
    element.dataset.dragNodeId = nodeId;
    if (jumpNodeId) {
      element.dataset.jumpNodeId = jumpNodeId;
    }
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      beginPointerGesture(nodeId, event, jumpNodeId);
    });
    if (tooltipText) {
      element.addEventListener("pointerenter", (event) => {
        showHoverTooltip(tooltipText, event);
      });
      element.addEventListener("pointermove", (event) => {
        moveHoverTooltip(event);
      });
      element.addEventListener("pointerleave", hideHoverTooltip);
    }
  }

  function beginPointerGesture(nodeId, event, jumpNodeId) {
    hideHoverTooltip();
    state.drag.sourceId = nodeId;
    state.drag.jumpNodeId = jumpNodeId || null;
    state.drag.targetId = null;
    state.drag.invalidTargetId = null;
    state.drag.pointerId = event.pointerId;
    state.drag.startX = event.clientX;
    state.drag.startY = event.clientY;
    state.drag.currentX = event.clientX;
    state.drag.currentY = event.clientY;
    state.drag.dragging = false;
    debugLog("gesture-start", {
      nodeId,
      jumpNodeId: jumpNodeId || null,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY
    });
  }

  function handleDragMove(event) {
    if (state.panelDrag.active && event.pointerId === state.panelDrag.pointerId) {
      updatePanelDrag(event);
      return;
    }
    if (!state.drag.sourceId || event.pointerId !== state.drag.pointerId) {
      return;
    }
    state.drag.currentX = event.clientX;
    state.drag.currentY = event.clientY;

    const deltaX = event.clientX - state.drag.startX;
    const deltaY = event.clientY - state.drag.startY;
    if (!state.drag.dragging && Math.hypot(deltaX, deltaY) < 6) {
      return;
    }

    if (!state.drag.dragging) {
      state.drag.dragging = true;
      createDragGhost();
      debugLog("drag-start", {
        nodeId: state.drag.sourceId,
        pointerId: event.pointerId
      });
    }

    updateDragGhostPosition();
    updateDropTarget(event.clientX, event.clientY);
  }

  function handleDragEnd(event) {
    if (state.panelDrag.active && event.pointerId === state.panelDrag.pointerId) {
      finishPanelDrag();
      return;
    }
    if (!state.drag.sourceId || event.pointerId !== state.drag.pointerId) {
      return;
    }

    const sourceId = state.drag.sourceId;
    const jumpNodeId = state.drag.jumpNodeId;
    const targetId = state.drag.targetId;
    const dragging = state.drag.dragging;
    debugLog("drag-end", {
      sourceId,
      jumpNodeId,
      targetId,
      dragging,
      pointerId: event.pointerId
    });
    cleanupDragState();
    if (dragging) {
      state.suppressClickUntil = Date.now() + 250;
    }

    if (!dragging || !targetId) {
      if (!dragging && jumpNodeId && Date.now() >= state.suppressClickUntil) {
        jumpToNode(jumpNodeId);
      }
      if (dragging) {
        renderTree();
      }
      return;
    }

    moveNode(sourceId, targetId);
  }

  function createDragGhost() {
    const node = state.tree.nodes[state.drag.sourceId];
    if (!node) {
      return;
    }
    const ghost = document.createElement("div");
    ghost.className = "cgpt-tree-drag-ghost";
    ghost.textContent = node.title || "未命名提示词";
    document.body.appendChild(ghost);
    state.drag.ghostEl = ghost;
    updateDragGhostPosition();
    renderTree();
  }

  function updateDragGhostPosition() {
    if (!state.drag.ghostEl) {
      return;
    }
    state.drag.ghostEl.style.left = state.drag.currentX + 16 + "px";
    state.drag.ghostEl.style.top = state.drag.currentY + 16 + "px";
  }

  function updateDropTarget(clientX, clientY) {
    const hovered = getNodeIdFromPoint(clientX, clientY);
    const nextTargetId = isValidDropTarget(state.drag.sourceId, hovered) ? hovered : null;
    const nextInvalidId = hovered && !nextTargetId ? hovered : null;
    if (nextTargetId === state.drag.targetId && nextInvalidId === state.drag.invalidTargetId) {
      return;
    }
    state.drag.targetId = nextTargetId;
    state.drag.invalidTargetId = nextInvalidId;
    renderTree();
  }

  function getNodeIdFromPoint(clientX, clientY) {
    const elements = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
    const sourceId = state.drag.sourceId;
    for (const element of elements) {
      if (!element || typeof element.closest !== "function") {
        continue;
      }
      const group = element.closest("g[data-id]");
      const nodeId = group?.dataset?.id || null;
      if (!nodeId || nodeId === sourceId) {
        continue;
      }
      return nodeId;
    }
    return null;
  }

  function isValidDropTarget(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId || targetId === state.tree.rootId) {
      return false;
    }
    return !isDescendantNode(sourceId, targetId);
  }

  function isDescendantNode(ancestorId, nodeId) {
    let cursor = state.tree.nodes[nodeId];
    while (cursor && cursor.parentId) {
      if (cursor.parentId === ancestorId) {
        return true;
      }
      cursor = state.tree.nodes[cursor.parentId];
    }
    return false;
  }

  function cleanupDragState() {
    hideHoverTooltip();
    if (state.drag.ghostEl) {
      state.drag.ghostEl.remove();
    }
    state.drag = {
      sourceId: null,
      jumpNodeId: null,
      targetId: null,
      invalidTargetId: null,
      pointerId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      dragging: false,
      ghostEl: null
    };
  }

  function beginPanelDrag(event) {
    if (event.button !== 0 || !state.panel) {
      return;
    }
    const interactive = event.target?.closest?.("button, input, select, textarea, a, [data-role]");
    if (interactive && interactive !== event.currentTarget) {
      return;
    }
    const rect = state.panel.getBoundingClientRect();
    state.panelDrag.pointerId = event.pointerId;
    state.panelDrag.startX = event.clientX;
    state.panelDrag.startY = event.clientY;
    state.panelDrag.originLeft = rect.left;
    state.panelDrag.originTop = rect.top;
    state.panelDrag.active = true;
    state.panel.classList.add("cgpt-tree-panel-dragging");
    state.panel.style.right = "auto";
    state.panel.style.bottom = "auto";
    state.panel.style.left = rect.left + "px";
    state.panel.style.top = rect.top + "px";
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        console.warn("ChatGPT Tree Panel: failed to capture panel drag pointer", error);
      }
    }
    event.preventDefault();
  }

  function updatePanelDrag(event) {
    if (!state.panelDrag.active || !state.panel) {
      return;
    }
    const deltaX = event.clientX - state.panelDrag.startX;
    const deltaY = event.clientY - state.panelDrag.startY;
    const nextPosition = clampPanelPosition(
      state.panelDrag.originLeft + deltaX,
      state.panelDrag.originTop + deltaY
    );
    applyPanelPosition(nextPosition.left, nextPosition.top, false);
  }

  function finishPanelDrag() {
    if (!state.panelDrag.active) {
      return;
    }
    state.panelDrag.active = false;
    if (state.panel) {
      state.panel.classList.remove("cgpt-tree-panel-dragging");
    }
    const rect = state.panel?.getBoundingClientRect();
    if (rect) {
      state.tree.panelPosition = clampPanelPosition(rect.left, rect.top);
      saveTree();
    }
    state.panelDrag.pointerId = null;
  }

  function clampPanelPosition(left, top) {
    const panelWidth = state.panel?.offsetWidth || 388;
    const panelHeight = state.panel?.offsetHeight || 420;
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin);
    return {
      left: Math.min(Math.max(Math.round(left), margin), maxLeft),
      top: Math.min(Math.max(Math.round(top), margin), maxTop)
    };
  }

  function applyPanelPosition(left, top, persist) {
    if (!state.panel) {
      return;
    }
    const nextPosition = clampPanelPosition(left, top);
    state.panel.style.left = nextPosition.left + "px";
    state.panel.style.top = nextPosition.top + "px";
    state.panel.style.right = "auto";
    state.panel.style.bottom = "auto";
    if (persist) {
      state.tree.panelPosition = nextPosition;
      saveTree();
    }
  }

  function applyStoredPanelPosition() {
    if (!state.panel) {
      return;
    }
    const position = normalizePanelPosition(state.tree.panelPosition);
    if (!position) {
      state.panel.style.left = "";
      state.panel.style.top = "";
      state.panel.style.right = "";
      state.panel.style.bottom = "";
      return;
    }
    applyPanelPosition(position.left, position.top, false);
  }

  function clampStoredPanelPosition() {
    const position = normalizePanelPosition(state.tree.panelPosition);
    if (!position) {
      return;
    }
    const nextPosition = clampPanelPosition(position.left, position.top);
    applyPanelPosition(nextPosition.left, nextPosition.top, false);
    if (nextPosition.left !== position.left || nextPosition.top !== position.top) {
      state.tree.panelPosition = nextPosition;
      saveTree();
    }
  }

  function ensureHoverTooltip() {
    if (state.hoverTooltipEl?.isConnected) {
      return state.hoverTooltipEl;
    }
    const tooltip = document.createElement("div");
    tooltip.className = "cgpt-tree-hover-tooltip";
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    state.hoverTooltipEl = tooltip;
    return tooltip;
  }

  function moveHoverTooltip(event) {
    const tooltip = state.hoverTooltipEl;
    if (!tooltip || tooltip.hidden) {
      return;
    }
    suppressNativeTooltipsAtPoint(event.clientX, event.clientY);
    tooltip.style.left = event.clientX + 14 + "px";
    tooltip.style.top = event.clientY + 14 + "px";
  }

  function showHoverTooltip(text, event) {
    if (!text || state.drag.dragging) {
      return;
    }
    suppressNativeTooltipsAtPoint(event.clientX, event.clientY);
    const tooltip = ensureHoverTooltip();
    tooltip.textContent = text;
    tooltip.hidden = false;
    moveHoverTooltip(event);
  }

  function hideHoverTooltip() {
    if (!state.hoverTooltipEl) {
      return;
    }
    state.hoverTooltipEl.hidden = true;
    restoreSuppressedNativeTooltips();
  }

  function suppressNativeTooltipsAtPoint(clientX, clientY) {
    restoreSuppressedNativeTooltips();
    if (typeof document.elementsFromPoint !== "function") {
      return;
    }

    const seen = new Set();
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      let current = element;
      while (current && current !== document.documentElement && !seen.has(current)) {
        seen.add(current);
        suppressNativeTooltipForElement(current);
        current = current.parentElement;
      }
    }
  }

  function suppressNativeTooltipForElement(element) {
    if (!(element instanceof Element)) {
      return;
    }

    if (element.hasAttribute("title")) {
      state.suppressedTitleAttrs.push({
        element,
        value: element.getAttribute("title")
      });
      element.removeAttribute("title");
    }

    if (element.namespaceURI !== "http://www.w3.org/2000/svg") {
      return;
    }

    const directTitleChildren = Array.from(element.children || []).filter((child) => child.localName === "title");
    for (const titleEl of directTitleChildren) {
      state.suppressedSvgTitles.push({
        parent: element,
        titleEl
      });
      titleEl.remove();
    }
  }

  function restoreSuppressedNativeTooltips() {
    while (state.suppressedTitleAttrs.length) {
      const entry = state.suppressedTitleAttrs.pop();
      if (!entry?.element?.isConnected) {
        continue;
      }
      entry.element.setAttribute("title", entry.value || "");
    }

    while (state.suppressedSvgTitles.length) {
      const entry = state.suppressedSvgTitles.pop();
      if (!entry?.parent?.isConnected || !entry?.titleEl) {
        continue;
      }
      entry.parent.appendChild(entry.titleEl);
    }
  }

  function moveNode(nodeId, nextParentId) {
    const node = state.tree.nodes[nodeId];
    const nextParent = state.tree.nodes[nextParentId];
    if (!node || !nextParent || !isValidDropTarget(nodeId, nextParentId)) {
      renderTree();
      return;
    }

    captureUndoState();
    const prevParent = state.tree.nodes[node.parentId];
    if (prevParent) {
      prevParent.children = prevParent.children.filter((childId) => childId !== nodeId);
    }

    node.parentId = nextParentId;
    nextParent.children = nextParent.children.filter((childId) => childId !== nodeId);
    nextParent.children.push(nodeId);
    nextParent.collapsed = false;

    markTreeStructureDirty();
    saveTree();
    renderTree();
  }

  function normalizeExportFormat(format) {
    const value = String(format || "").trim().toLowerCase();
    if (!value) {
      return "markdown";
    }
    if (["markdown", "md", "mark down"].includes(value)) {
      return "markdown";
    }
    if (["png", "image", "img", "图片", "png图片"].includes(value)) {
      return "png";
    }
    if (["jpg", "jpeg", "jpg图片", "jpeg图片"].includes(value)) {
      return "jpg";
    }
    if (["svg", "矢量图", "svg图片"].includes(value)) {
      return "svg";
    }
    return "markdown";
  }

  function updateExportModeOptions() {
    const modeSelect = state.panel?.querySelector('[data-role="export-markdown-mode"]');
    if (!modeSelect) {
      return;
    }

    if (state.exportFormat === "markdown") {
      modeSelect.innerHTML = [
        '<option value="with-answers">完整对话</option>',
        '<option value="questions-only">仅问题</option>'
      ].join("");
      modeSelect.value = state.exportMarkdownMode === "questions-only" ? "questions-only" : "with-answers";
      return;
    }

    modeSelect.innerHTML = '<option value="questions-only">仅问题</option>';
    modeSelect.value = "questions-only";
  }

  async function exportTree(format) {
    const normalizedFormat = normalizeExportFormat(format);
    if (normalizedFormat === "png") {
      await exportTreeAsImage("png");
      return;
    }
    if (normalizedFormat === "jpg") {
      await exportTreeAsImage("jpeg");
      return;
    }
    if (normalizedFormat === "svg") {
      exportTreeAsSvg();
      return;
    }

    const extension = "md";
    const mimeType = "text/markdown;charset=utf-8";
    const content = buildTreeMarkdown(state.exportMarkdownMode === "with-answers");
    await copyText(content);
    downloadBlob(new Blob([content], { type: mimeType }), buildExportFilename(extension));
  }

  function buildTreeMarkdown(includeAnswers) {
    if (includeAnswers) {
      return buildConversationMarkdown();
    }

    const lines = ["# " + getExportConversationTitle(), ""];

    function walk(nodeId, depth) {
      const node = state.tree.nodes[nodeId];
      if (!node) {
        return;
      }
      const headingLevel = Math.min(depth + 2, 6);
      lines.push("#".repeat(headingLevel) + " " + (node.title || "未命名提示词"));
      lines.push("");
      for (const childId of node.children) {
        walk(childId, depth + 1);
      }
    }

    for (const childId of state.tree.nodes.root.children) {
      walk(childId, 0);
    }

    return lines.join("\n");
  }

  function buildConversationMarkdown() {
    const title = getExportConversationTitle();
    const lines = ["# " + title, "", "导出时间：" + formatConversationTimestamp(new Date()), ""];
    const entries = getConversationExportEntries();
    for (const entry of entries) {
      lines.push("## " + entry.index + ". 问题");
      lines.push("");
      lines.push(entry.question || "未命名提示词");
      lines.push("");
      lines.push("## " + entry.index + ". 回答");
      lines.push("");
      lines.push(getDirectMarkdownAnswer(entry.answer));
      lines.push("");
    }
    return lines.join("\n");
  }

  function getDirectMarkdownAnswer(answer) {
    const text = String(answer || "").replace(/\r\n/g, "\n").trim();
    return text || "暂无回答";
  }

  function exportTreeAsSvg() {
    const source = buildCurrentTreeSvgMarkup();
    if (!source) {
      return;
    }
    downloadBlob(new Blob([source], { type: "image/svg+xml;charset=utf-8" }), buildExportFilename("svg"));
  }

  async function exportTreeAsImage(imageType) {
    const source = buildCurrentTreeSvgMarkup();
    if (!source) {
      return;
    }
    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    try {
      const image = await loadImage(url);
      const dimensions = getCurrentTreeSvgDimensions();
      const width = dimensions.width;
      const height = dimensions.height;
      const canvas = document.createElement("canvas");
      const scale = window.devicePixelRatio > 1 ? 2 : 1;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.scale(scale, scale);
      context.fillStyle = "#09111a";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const mimeType = imageType === "jpeg" ? "image/jpeg" : "image/png";
      const extension = imageType === "jpeg" ? "jpg" : "png";
      const quality = imageType === "jpeg" ? 0.92 : undefined;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
      if (blob) {
        downloadBlob(blob, buildExportFilename(extension));
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function buildCurrentTreeSvgMarkup() {
    const svg = state.body?.querySelector(".cgpt-tree-svg");
    if (!svg) {
      return "";
    }
    return buildExportSvgMarkup(svg);
  }

  function buildExportSvgMarkup(svg) {
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = [
      ".cgpt-tree-link{fill:none;stroke:rgba(160,179,196,.34);stroke-width:1.5px;}",
      ".cgpt-tree-node circle{fill:#7dd3fc;stroke:rgba(4,12,18,.55);stroke-width:1.5px;}",
      ".cgpt-tree-node.active circle{fill:#f7b955;}",
      ".cgpt-tree-node.search-match circle{stroke:#7ee081;stroke-width:2px;}",
      ".cgpt-tree-node.search-current circle{fill:#7ee081;}",
      ".cgpt-tree-node.drop-target circle{fill:#8ff0b2;stroke:#d9ffdf;stroke-width:2.5px;}",
      ".cgpt-tree-node.drop-invalid circle{fill:#f28d8d;stroke:#ffd7d7;stroke-width:2.5px;}",
      ".cgpt-tree-node-label{fill:#f3f8fb;font-size:12px;font-family:'SF Pro Display','Segoe UI',sans-serif;}",
      ".cgpt-tree-node-order{fill:#09111a;font-size:8px;font-weight:700;font-family:'SF Pro Display','Segoe UI',sans-serif;}",
      ".cgpt-tree-hitbox{fill:transparent;}",
      ".cgpt-tree-toggle{fill:rgba(255,255,255,.16);stroke:rgba(255,255,255,.2);stroke-width:1px;}",
      ".cgpt-tree-toggle-mark{fill:none;stroke:#fff;stroke-linecap:round;stroke-width:1.4px;}"
    ].join("");
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  function getCurrentTreeSvgDimensions() {
    const svg = state.body?.querySelector(".cgpt-tree-svg");
    if (!svg) {
      return { width: 800, height: 600 };
    }
    return {
      width: Number(svg.getAttribute("width")) || svg.clientWidth || 800,
      height: Number(svg.getAttribute("height")) || svg.clientHeight || 600
    };
  }

  function getConversationExportEntries() {
    const turns = getConversationTurns();
    const answerQueues = new Map();
    const ignoredPromptIndexSet = getIgnoredPromptIndexSet();
    const ignoredSignatureSet = getIgnoredSignatureSet();
    const ignoredTitleSet = getIgnoredTitleSet();
    const titleMatchCounts = new Map();
    for (const turn of turns) {
      if (turn?.role !== "user") {
        continue;
      }
      const normalizedTitle = normalizeIgnoredPromptTitle(turn.text || "");
      if (!normalizedTitle) {
        continue;
      }
      titleMatchCounts.set(normalizedTitle, (titleMatchCounts.get(normalizedTitle) || 0) + 1);
    }
    let pendingUserTurn = null;
    let promptOrdinal = -1;

    for (const turn of turns) {
      if (turn.role === "user") {
        promptOrdinal += 1;
        const signature = buildSignature(normalizeTurnText("user", turn.text || ""));
        const normalizedTitle = normalizeIgnoredPromptTitle(turn.text || "");
        const shouldIgnoreByTitle = ignoredTitleSet.has(normalizedTitle) && titleMatchCounts.get(normalizedTitle) === 1;
        if (ignoredPromptIndexSet.has(promptOrdinal) || ignoredSignatureSet.has(signature) || shouldIgnoreByTitle) {
          pendingUserTurn = null;
          continue;
        }
        pendingUserTurn = turn;
        continue;
      }
      if (turn.role !== "assistant" || !pendingUserTurn) {
        continue;
      }
      const signature = buildSignature(normalizeTurnText("user", pendingUserTurn.text || ""));
      if (!answerQueues.has(signature)) {
        answerQueues.set(signature, []);
      }
      answerQueues.get(signature).push(turn.markdown || turn.text || "暂无回答");
      pendingUserTurn = null;
    }

    return Object.values(state.tree.nodes)
      .filter((node) => {
        if (!node || node.id === state.tree.rootId) {
          return false;
        }
        if (ignoredPromptIndexSet.has(Number.isInteger(node.promptIndex) ? node.promptIndex : -1)) {
          return false;
        }
        if (ignoredSignatureSet.has(node.signature || "")) {
          return false;
        }
        const normalizedTitle = normalizeIgnoredPromptTitle(node.title || "");
        const shouldIgnoreByTitle = ignoredTitleSet.has(normalizedTitle)
          && titleMatchCounts.get(normalizedTitle) === 1;
        return !shouldIgnoreByTitle;
      })
      .sort((left, right) => {
        const leftIndex = typeof left.promptIndex === "number" ? left.promptIndex : Number.MAX_SAFE_INTEGER;
        const rightIndex = typeof right.promptIndex === "number" ? right.promptIndex : Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
        return (left.createdAt || 0) - (right.createdAt || 0);
      })
      .map((node, index) => {
        const queuedAnswers = answerQueues.get(node.signature) || [];
        const answer = queuedAnswers.length ? queuedAnswers.shift() : (node.answer || "暂无回答");
        return {
          index: index + 1,
          question: node.title || "未命名提示词",
          answer
        };
      });
  }

  function buildConversationSvgMarkup() {
    const title = getExportConversationTitle();
    const exportedAt = formatConversationTimestamp(new Date());
    const entries = getConversationExportEntries();
    if (!entries.length) {
      return "";
    }

    const width = 1080;
    const lines = [];
    lines.push({ text: title, kind: "title" });
    lines.push({ text: "导出时间 " + exportedAt, kind: "meta" });

    for (const entry of entries) {
      lines.push({ text: entry.index + ". 问题", kind: "section" });
      for (const line of wrapExportText(entry.question, 48)) {
        lines.push({ text: line, kind: "question" });
      }
      lines.push({ text: entry.index + ". 回答", kind: "section" });
      for (const line of wrapExportText(entry.answer, 48)) {
        lines.push({ text: line, kind: "answer" });
      }
    }

    let y = 54;
    const lineMeta = lines.map((line) => {
      const metrics = getConversationLineMetrics(line.kind);
      const currentY = y;
      y += metrics.height;
      return { ...line, y: currentY, metrics };
    });
    const height = Math.max(320, y + 26);

    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '">',
      '<rect width="100%" height="100%" fill="#09111a"/>',
      '<rect x="24" y="24" width="' + (width - 48) + '" height="' + (height - 48) + '" rx="24" fill="#111a24" stroke="rgba(255,255,255,0.08)"/>'
    ];

    for (const line of lineMeta) {
      const fill = line.metrics.fill;
      const fontSize = line.metrics.fontSize;
      const fontWeight = line.metrics.fontWeight;
      parts.push(
        '<text x="54" y="' + line.y + '" fill="' + fill + '" font-size="' + fontSize + '" font-weight="' + fontWeight + '" font-family="SF Pro Display, Segoe UI, sans-serif">' +
        escapeXml(line.text) +
        "</text>"
      );
    }

    parts.push("</svg>");
    return parts.join("");
  }

  function getConversationSvgDimensions() {
    const source = buildConversationSvgMarkup();
    const widthMatch = source.match(/width="(\d+)"/);
    const heightMatch = source.match(/height="(\d+)"/);
    return {
      width: widthMatch ? Number(widthMatch[1]) : 1080,
      height: heightMatch ? Number(heightMatch[1]) : 1200
    };
  }

  function wrapExportText(text, maxLength) {
    const rawLines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const result = [];
    for (const rawLine of rawLines) {
      const normalizedLine = rawLine || " ";
      let current = "";
      let currentLength = 0;
      for (const char of Array.from(normalizedLine)) {
        const charLength = /[\u4e00-\u9fff]/.test(char) ? 2 : 1;
        if (current && currentLength + charLength > maxLength) {
          result.push(current);
          current = char;
          currentLength = charLength;
          continue;
        }
        current += char;
        currentLength += charLength;
      }
      result.push(current || " ");
    }
    return result;
  }

  function getConversationLineMetrics(kind) {
    if (kind === "title") {
      return { fontSize: 28, fontWeight: 700, fill: "#f3f8fb", height: 42 };
    }
    if (kind === "meta") {
      return { fontSize: 16, fontWeight: 500, fill: "#b7c7d4", height: 32 };
    }
    if (kind === "section") {
      return { fontSize: 18, fontWeight: 700, fill: "#7dd3fc", height: 34 };
    }
    if (kind === "question") {
      return { fontSize: 17, fontWeight: 600, fill: "#eef6fb", height: 30 };
    }
    return { fontSize: 16, fontWeight: 400, fill: "#e3edf3", height: 28 };
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  function buildExportFilename(extension) {
    const title = sanitizeFilenameSegment(getExportConversationTitle());
    const timestamp = formatExportFilenameTimestamp(new Date());
    return title + "-" + timestamp + "." + extension;
  }

  function getExportConversationTitle() {
    const pageTitle = extractConversationTitleFromPage();
    if (pageTitle) {
      return pageTitle;
    }

    const rawTitle = String(document.title || "").trim();
    const cleaned = rawTitle
      .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
      .replace(/\s*[|]\s*ChatGPT\s*$/i, "")
      .replace(/\s*[-|]\s*Gemini\s*$/i, "")
      .replace(/\s*[|]\s*Gemini\s*$/i, "")
      .trim();
    return cleaned && !/^(chatgpt|gemini)$/i.test(cleaned)
      ? cleaned
      : (state.siteType === SITE_TYPE_GEMINI ? "Gemini对话" : "ChatGPT对话");
  }

  function extractConversationTitleFromPage() {
    const selectors = [
      'nav a[aria-current="page"]',
      'aside a[aria-current="page"]',
      '[data-testid*="conversation"][aria-current="page"]',
      '[data-testid*="conversation"] [aria-current="page"]',
      'main h1',
      'header h1'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const element of candidates) {
        const text = normalizeText(element.textContent || "");
        if (!text) {
          continue;
        }
        if (/^(chatgpt|gemini|对话树)$/i.test(text)) {
          continue;
        }
        if (text.length < 2) {
          continue;
        }
        return text;
      }
    }

    return "";
  }

  function sanitizeFilenameSegment(value) {
    return String(value || "ChatGPT对话")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "ChatGPT对话";
  }

  function formatExportFilenameTimestamp(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return month + "月" + day + "日" + hour + "时" + minute + "分";
  }

  function formatConversationTimestamp(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return month + "月" + day + "日 " + hour + ":" + minute;
  }

  function escapeXml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async function copyText(text) {
    if (!navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.warn("ChatGPT Tree Panel: failed to copy export text", error);
    }
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function isRootScrollableElement(element) {
    return element === document.scrollingElement
      || element === document.documentElement
      || element === document.body;
  }

  function findNearestScrollableAncestor(element) {
    let current = element?.parentElement || null;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY || style.overflow;
      if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight + 1) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isExtensionOverlayElement(element) {
    if (!element) {
      return false;
    }
    if (element.id === PANEL_ID || element.closest("#" + PANEL_ID)) {
      return true;
    }
    const className = typeof element.className === "string" ? element.className : "";
    const id = typeof element.id === "string" ? element.id : "";
    return className.includes("cgpt-tree") || id.includes("cgpt-tree");
  }

  function getTopScrollPadding() {
    let padding = SCROLL_PADDING;
    if (state.siteType === SITE_TYPE_GITHUB_COPILOT) {
      padding += GITHUB_COPILOT_TOP_BUFFER;
    }
    return padding;
  }

  function getSafeTopOffset() {
    return detectTopOverlayHeight() + getTopScrollPadding();
  }

  function detectTopOverlayHeight() {
    const cache = state.topOverlayCache;
    const now = performance.now();
    if (cache.measuredAt > 0 && cache.viewportWidth === window.innerWidth && now - cache.measuredAt < TOP_OVERLAY_CACHE_TTL_MS) {
      return cache.value;
    }

    const startedAt = performance.now();
    const elements = getTopOverlayCandidates();
    let maxBottom = 0;
    const minWidth = state.siteType === SITE_TYPE_GITHUB_COPILOT
      ? Math.min(window.innerWidth * 0.12, 96)
      : Math.min(window.innerWidth * 0.3, 240);

    for (const element of elements) {
      if (!element || isExtensionOverlayElement(element)) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if ((style.position !== "fixed" && style.position !== "sticky")
        || style.display === "none"
        || style.visibility === "hidden"
        || Number(style.opacity || "1") <= 0) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const zIndex = Number.parseInt(style.zIndex || "0", 10);
      if (rect.height <= 0
        || rect.width < minWidth
        || rect.bottom <= 0
        || rect.top > 1
        || !Number.isFinite(zIndex)
        || zIndex <= 1) {
        continue;
      }
      maxBottom = Math.max(maxBottom, rect.bottom);
    }

    const value = Math.max(0, Math.ceil(maxBottom));
    state.topOverlayCache = {
      value,
      measuredAt: now,
      viewportWidth: window.innerWidth
    };
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs > 60) {
      logger?.warn("top-overlay-detect-slow", {
        durationMs,
        candidateCount: elements.length,
        value
      });
    }
    return value;
  }

  function resetTopOverlayCache() {
    state.topOverlayCache.value = 0;
    state.topOverlayCache.measuredAt = 0;
    state.topOverlayCache.viewportWidth = 0;
  }

  function getTopOverlayCandidates() {
    if (!document.body) {
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const addCandidate = (element) => {
      if (!element || seen.has(element) || candidates.length >= 240) {
        return;
      }
      seen.add(element);
      candidates.push(element);
    };

    const bodyChildren = document.body.children;
    for (let i = 0; i < bodyChildren.length && i < 120; i += 1) {
      addCandidate(bodyChildren[i]);
    }

    if (typeof document.elementsFromPoint === "function") {
      const width = Math.max(1, window.innerWidth || 1);
      const height = Math.max(1, window.innerHeight || 1);
      const sampleXs = [
        1,
        Math.floor(width * 0.25),
        Math.floor(width * 0.5),
        Math.floor(width * 0.75),
        Math.max(1, width - 2)
      ];
      const sampleYs = [
        1,
        Math.min(16, height - 1),
        Math.min(56, height - 1)
      ];
      for (const x of sampleXs) {
        for (const y of sampleYs) {
          const stack = document.elementsFromPoint(x, y).slice(0, 8);
          for (const element of stack) {
            let current = element;
            while (current && current !== document.body && current !== document.documentElement) {
              addCandidate(current);
              current = current.parentElement;
            }
          }
        }
      }
    }

    return candidates;
  }

  function alignWindowScrollForTarget(target, safeTopOffset, behavior) {
    const targetRect = target.getBoundingClientRect();
    const nextTop = window.scrollY + targetRect.top - safeTopOffset;
    const resolvedTop = Math.max(0, nextTop);
    window.scrollTo({
      top: resolvedTop,
      behavior
    });
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement && Math.abs(scrollingElement.scrollTop - resolvedTop) > 1) {
      scrollingElement.scrollTop = resolvedTop;
    }
  }

  function alignNestedScrollParent(target, scrollParent, safeTopOffset, behavior) {
    const targetRect = target.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const desiredParentTop = Math.max(safeTopOffset, SCROLL_PADDING);

    if (parentRect.top < desiredParentTop) {
      const nextWindowTop = Math.max(0, window.scrollY + parentRect.top - desiredParentTop);
      window.scrollTo({
        top: nextWindowTop,
        behavior
      });
      const scrollingElement = document.scrollingElement || document.documentElement;
      if (scrollingElement && Math.abs(scrollingElement.scrollTop - nextWindowTop) > 1) {
        scrollingElement.scrollTop = nextWindowTop;
      }
    }

    const desiredTargetTop = Math.max(SCROLL_PADDING, safeTopOffset - parentRect.top);
    const nextTop = scrollParent.scrollTop + (targetRect.top - parentRect.top) - desiredTargetTop;
    const resolvedTop = Math.max(0, nextTop);
    scrollParent.scrollTo({
      top: resolvedTop,
      behavior
    });
    if (Math.abs(scrollParent.scrollTop - resolvedTop) > 1) {
      scrollParent.scrollTop = resolvedTop;
    }
  }

  function correctTargetScrollPosition(target, remainingAttempts) {
    if (!target || !target.isConnected || remainingAttempts <= 0) {
      return;
    }

    const safeTopOffset = getSafeTopOffset();
    const targetRect = target.getBoundingClientRect();
    if (targetRect.top >= safeTopOffset) {
      return;
    }

    const scrollParent = findNearestScrollableAncestor(target);
    if (scrollParent && !isRootScrollableElement(scrollParent)) {
      const parentRect = scrollParent.getBoundingClientRect();
      const desiredTargetTop = Math.max(SCROLL_PADDING, safeTopOffset - parentRect.top);
      const innerDelta = (targetRect.top - parentRect.top) - desiredTargetTop;
      if (Math.abs(innerDelta) > 1) {
        scrollParent.scrollBy({
          top: innerDelta,
          behavior: "auto"
        });
      }
    }

    const correctedRect = target.getBoundingClientRect();
    if (correctedRect.top < safeTopOffset) {
      window.scrollBy({
        top: correctedRect.top - safeTopOffset,
        behavior: "auto"
      });
    } else {
      return;
    }

    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        correctTargetScrollPosition(target, remainingAttempts - 1);
      });
    }, SCROLL_CORRECTION_DELAY_MS);
  }

  function scrollTargetIntoView(target) {
    debugLog("scroll-target-into-view", {
      tagName: target?.tagName || null,
      datasetNodeId: target?.dataset?.cgptTreeNodeId || null,
      text: normalizeText(target?.textContent || "").slice(0, 80)
    });
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "nearest"
      });
    }
    const overlayHeight = detectTopOverlayHeight();
    const safeTopOffset = overlayHeight + getTopScrollPadding();
    const scrollParent = findNearestScrollableAncestor(target);
    if (scrollParent && !isRootScrollableElement(scrollParent)) {
      alignNestedScrollParent(target, scrollParent, safeTopOffset, "smooth");
    } else {
      alignWindowScrollForTarget(target, safeTopOffset, "smooth");
    }

    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        correctTargetScrollPosition(target, SCROLL_CORRECTION_MAX_ATTEMPTS);
      });
    }, SCROLL_CORRECTION_DELAY_MS);
  }

  function resolveNodeTargetElement(nodeId) {
    const mappedTarget = state.domNodeMap.get(nodeId);
    if (mappedTarget?.isConnected) {
      debugLog("resolve-target-hit-dom-map", {
        nodeId,
        tagName: mappedTarget.tagName,
        text: normalizeText(mappedTarget.textContent || "").slice(0, 80)
      });
      return mappedTarget;
    }

    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      const directTarget = document.querySelector('[data-cgpt-tree-node-id="' + CSS.escape(nodeId) + '"]');
      if (directTarget) {
        state.domNodeMap.set(nodeId, directTarget);
        debugLog("resolve-target-hit-dataset", {
          nodeId,
          tagName: directTarget.tagName,
          text: normalizeText(directTarget.textContent || "").slice(0, 80)
        });
        return directTarget;
      }
    }

    const node = state.tree.nodes[nodeId];
    if (!node || node.id === state.tree.rootId) {
      return null;
    }

    const nodeCount = Math.max(0, Object.keys(state.tree.nodes || {}).length - 1);
    if (nodeCount > 80) {
      logger?.warn("resolve-target-skip-heavy-fallback", {
        nodeId,
        nodeCount,
        promptIndex: node.promptIndex,
        title: String(node.title || "").slice(0, 120)
      });
      return null;
    }

    const userTurns = getConversationTurns().filter((turn) => turn.role === "user" && turn.promptEl?.isConnected);
    let target = null;

    if (Number.isInteger(node.promptIndex) && node.promptIndex >= 0 && userTurns[node.promptIndex]?.promptEl) {
      target = userTurns[node.promptIndex].promptEl;
      debugLog("resolve-target-hit-prompt-index", {
        nodeId,
        promptIndex: node.promptIndex,
        text: normalizeText(target.textContent || "").slice(0, 80)
      });
    }

    if (!target) {
      const normalizedTitle = normalizeTurnText("user", node.title || "");
      const matchedTurn = userTurns.find((turn) => normalizeTurnText("user", turn.text || "") === normalizedTitle);
      target = matchedTurn?.promptEl || null;
      if (target) {
        debugLog("resolve-target-hit-title", {
          nodeId,
          title: normalizedTitle,
          text: normalizeText(target.textContent || "").slice(0, 80)
        });
      }
    }

    if (target) {
      state.domNodeMap.set(nodeId, target);
      target.dataset.cgptTreeNodeId = nodeId;
    } else {
      debugLog("resolve-target-miss", {
        nodeId,
        promptIndex: node.promptIndex,
        title: node.title || ""
      });
    }

    return target;
  }

  function jumpToNode(nodeId) {
    const startedAt = performance.now();
    debugLog("jump-start", {
      nodeId,
      activeNodeId: state.activeNodeId
    });
    const previousActiveNodeId = state.activeNodeId;
    state.activeNodeId = nodeId;
    pinManualActiveNode(nodeId);
    const layoutChanged = revealAncestors(nodeId);
    applyActiveHighlight();
    if (layoutChanged) {
      state.renderVersion += 1;
      renderTree();
    } else {
      updateRenderedActiveNodeClasses(previousActiveNodeId, nodeId);
    }
    const target = resolveNodeTargetElement(nodeId);
    if (!target) {
      debugLog("jump-no-target", {
        nodeId
      });
      logSlowJumpIfNeeded(startedAt, nodeId, "no-target");
      window.requestAnimationFrame(() => {
        scrollTreeNodeIntoView(nodeId, { alignX: "start" });
      });
      return;
    }
    debugLog("jump-found-target", {
      nodeId,
      tagName: target.tagName,
      text: normalizeText(target.textContent || "").slice(0, 80)
    });
    window.requestAnimationFrame(() => {
      scrollTargetIntoView(target);
      scrollTreeNodeIntoView(nodeId, { alignX: "start" });
    });
    logSlowJumpIfNeeded(startedAt, nodeId, "target-found");
  }

  function logSlowJumpIfNeeded(startedAt, nodeId, result) {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs <= 80) {
      return;
    }
    logger?.warn("jump-sync-slow", {
      durationMs,
      nodeId,
      result,
      nodeCount: Math.max(0, Object.keys(state.tree?.nodes || {}).length - 1),
      domMapSize: state.domNodeMap.size
    });
  }

  function promoteActiveNodeOneLevel() {
    const activeNode = state.tree.nodes[state.activeNodeId];
    if (!activeNode) {
      window.alert("请先选择一个节点");
      return;
    }
    if (activeNode.id === state.tree.rootId) {
      window.alert("当前已是根节点");
      return;
    }

    const parentId = activeNode.parentId;
    if (!parentId) {
      window.alert("该节点已处于顶层");
      return;
    }

    const parentNode = state.tree.nodes[parentId];
    const nextParentId = parentNode?.parentId || state.tree.rootId;
    if (nextParentId === state.tree.rootId) {
      setNodeAsRoot(activeNode);
    } else {
      moveNode(activeNode.id, nextParentId);
    }
    state.activeNodeId = activeNode.id;
    state.renderVersion += 1;
    renderTree();
    scrollTreeNodeIntoView(activeNode.id);
  }

  function demoteActiveNodeOneLevel() {
    const activeNode = state.tree.nodes[state.activeNodeId];
    if (!activeNode) {
      window.alert("请先选择一个节点");
      return;
    }
    if (activeNode.id === state.tree.rootId) {
      window.alert("当前已是根节点");
      return;
    }

    const parentNode = state.tree.nodes[activeNode.parentId];
    const siblingIds = parentNode?.children || [];
    const currentIndex = siblingIds.indexOf(activeNode.id);
    if (currentIndex <= 0) {
      window.alert("该节点前面没有可作为上级的问题");
      return;
    }

    const previousSiblingId = siblingIds[currentIndex - 1];
    const previousSibling = state.tree.nodes[previousSiblingId];
    if (!previousSibling) {
      window.alert("未找到可作为上级的问题");
      return;
    }

    moveNode(activeNode.id, previousSiblingId);
    state.activeNodeId = activeNode.id;
    state.renderVersion += 1;
    scrollTreeNodeIntoView(activeNode.id);
  }

  function linearSortNodesByTime() {
    if (!state.tree) {
      return;
    }
    if (isConversationClosed()) {
      return;
    }

    const rootId = state.tree.rootId || "root";
    const root = state.tree.nodes[rootId] || state.tree.nodes.root;
    if (!root) {
      return;
    }

    captureUndoState();
    state.tree.linearSortEnabled = true;

    applyLinearSortMode(true);

    markTreeStructureDirty();
    updateSearchResults(false);
    saveTree();
    state.renderVersion += 1;
    renderTree();
    if (state.activeNodeId) {
      scrollTreeNodeIntoView(state.activeNodeId, { alignX: "start" });
    }
  }

  function applyLinearSortMode(ensureRoot) {
    if (!state.tree) {
      return;
    }
    const rootId = state.tree.rootId || "root";
    const root = state.tree.nodes[rootId] || state.tree.nodes.root;
    if (!root) {
      return;
    }
    if (ensureRoot) {
      root.parentId = null;
    }

    const nodes = Object.values(state.tree.nodes)
      .filter((node) => node && node.id !== rootId)
      .sort((a, b) => {
        const aIndex = Number.isFinite(a.promptIndex) ? a.promptIndex : Number.POSITIVE_INFINITY;
        const bIndex = Number.isFinite(b.promptIndex) ? b.promptIndex : Number.POSITIVE_INFINITY;
        if (aIndex !== bIndex) {
          return aIndex - bIndex;
        }
        return (a.createdAt - b.createdAt) || a.id.localeCompare(b.id);
      });

    root.children = [];
    for (const node of nodes) {
      node.parentId = rootId;
      node.children = [];
      node.collapsed = false;
      root.children.push(node.id);
    }
  }

  function setActiveNodeAsRoot() {
    const activeNode = state.tree.nodes[state.activeNodeId];
    if (!activeNode) {
      window.alert("请先选择一个节点");
      return;
    }
    if (activeNode.id === state.tree.rootId) {
      window.alert("当前已是根节点");
      return;
    }
    const oldParentId = activeNode.parentId;
    if (oldParentId === state.tree.rootId) {
      window.alert("该节点已处于顶层");
      return;
    }
    setNodeAsRoot(activeNode);
    state.renderVersion += 1;
    renderTree();
  }

  function setNodeAsRoot(node) {
    if (!node || node.id === state.tree.rootId) {
      return;
    }
    captureUndoState();
    const oldParent = state.tree.nodes[node.parentId];
    if (oldParent) {
      oldParent.children = oldParent.children.filter((id) => id !== node.id);
    }
    node.parentId = state.tree.rootId;
    state.tree.nodes.root.children = state.tree.nodes.root.children.filter((id) => id !== node.id);
    state.tree.nodes.root.children.push(node.id);
    markTreeStructureDirty();
    saveTree();
  }

  async function deleteActiveNodeForever() {
    const activeNode = state.tree.nodes[state.activeNodeId];
    if (!activeNode || activeNode.id === state.tree.rootId) {
      window.alert("请先选中要删除的问题");
      return;
    }

    const signature = String(activeNode.signature || "").trim();
    if (!signature) {
      window.alert("当前问题缺少可识别标记，暂时无法删除");
      return;
    }
    const normalizedTitle = normalizeIgnoredPromptTitle(activeNode.title || "");
    const promptIndex = Number.isInteger(activeNode.promptIndex) ? activeNode.promptIndex : -1;

    const ignoredPromptIndices = Array.isArray(state.tree.ignoredPromptIndices)
      ? state.tree.ignoredPromptIndices.slice()
      : [];
    if (promptIndex >= 0 && !ignoredPromptIndices.includes(promptIndex)) {
      ignoredPromptIndices.push(promptIndex);
    }
    const ignored = Array.isArray(state.tree.ignoredSignatures) ? state.tree.ignoredSignatures.slice() : [];
    if (!ignored.includes(signature)) {
      ignored.push(signature);
    }
    const ignoredTitles = Array.isArray(state.tree.ignoredTitles) ? state.tree.ignoredTitles.slice() : [];
    if (normalizedTitle && !ignoredTitles.includes(normalizedTitle)) {
      ignoredTitles.push(normalizedTitle);
    }
    captureUndoState();
    state.tree.ignoredPromptIndices = ignoredPromptIndices;
    state.tree.ignoredSignatures = ignored;
    state.tree.ignoredTitles = ignoredTitles;
    removeNode(activeNode.id);
    rebuildChildren(state.tree);
    markTreeStructureDirty();
    updateSearchResults(false);
    saveTree();
    renderTree();

    await scanConversation(true, true);
  }

  function formatNodeOrder(node) {
    const promptIndex = Number.isFinite(node?.promptIndex) ? node.promptIndex : -1;
    if (promptIndex < 0) {
      return "";
    }
    return String(promptIndex + 1);
  }

  function getNodeDisplayTitle(node) {
    const title = normalizeText(node?.title || "") || "未命名提示词";
    const chars = Array.from(title);
    if (chars.length <= 30) {
      return title;
    }
    return chars.slice(0, 30).join("") + "...";
  }

  function scrollTreeNodeIntoView(nodeId, options) {
    if (!nodeId || !state.body) {
      return;
    }
    const group = state.body.querySelector('g[data-id="' + nodeId + '"]');
    if (!group || typeof group.getBoundingClientRect !== "function") {
      return;
    }

    const bodyRect = state.body.getBoundingClientRect();
    const groupRect = group.getBoundingClientRect();
    if (!bodyRect.width || !bodyRect.height || !groupRect.width || !groupRect.height) {
      return;
    }

    const labelEl = group.querySelector(".cgpt-tree-node-label");
    const circleEl = group.querySelector("circle");
    const labelRect = labelEl?.getBoundingClientRect?.() || null;
    const circleRect = circleEl?.getBoundingClientRect?.() || null;
    const contentLeft = Math.min(
      labelRect?.left ?? groupRect.left,
      circleRect?.left ?? groupRect.left
    );
    const contentRight = Math.max(
      labelRect?.right ?? groupRect.right,
      circleRect?.right ?? groupRect.right
    );

    const padding = 32;
    const minLeft = contentLeft - bodyRect.left + state.body.scrollLeft - padding;
    const maxRight = contentRight - bodyRect.left + state.body.scrollLeft + padding;
    const minTop = groupRect.top - bodyRect.top + state.body.scrollTop - padding;
    const maxBottom = groupRect.bottom - bodyRect.top + state.body.scrollTop + padding;

    const alignX = options?.alignX || "ensure";
    let nextLeft = state.body.scrollLeft;
    let nextTop = state.body.scrollTop;

    if (alignX === "start") {
      const dotShift = circleRect?.width || 16;
      const anchorLeft = (labelRect?.left ?? contentLeft) - bodyRect.left + state.body.scrollLeft - dotShift;
      nextLeft = Math.max(0, anchorLeft - padding);
    } else {
      if (minLeft < nextLeft) {
        nextLeft = Math.max(0, minLeft);
      } else if (maxRight > nextLeft + state.body.clientWidth) {
        nextLeft = Math.max(0, maxRight - state.body.clientWidth);
      }
    }

    if (minTop < nextTop) {
      nextTop = Math.max(0, minTop);
    } else if (maxBottom > nextTop + state.body.clientHeight) {
      nextTop = Math.max(0, maxBottom - state.body.clientHeight);
    }

    if (nextLeft !== state.body.scrollLeft || nextTop !== state.body.scrollTop) {
      state.body.scrollTo({ left: nextLeft, top: nextTop, behavior: "smooth" });
    }
  }

  function updateActiveNodeFromViewport() {
    if (isConversationClosed()) {
      if (state.activeNodeId) {
        state.activeNodeId = null;
        clearManualActiveNodePin();
        applyActiveHighlight();
        syncRenderedActiveNodeClasses();
      }
      return;
    }
    if (
      state.manualActiveNodeId &&
      state.activeNodeId === state.manualActiveNodeId &&
      Date.now() < state.manualActiveUntil
    ) {
      return;
    }

    let best = null;
    const center = window.innerHeight / 2;

    for (const [nodeId, element] of state.domNodeMap.entries()) {
      if (!element || !element.isConnected) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        continue;
      }
      const distance = Math.abs(rect.top + rect.height / 2 - center);
      if (!best || distance < best.distance) {
        best = { nodeId, distance };
      }
    }

    if (best && best.nodeId !== state.activeNodeId) {
      const previousActiveNodeId = state.activeNodeId;
      state.activeNodeId = best.nodeId;
      clearManualActiveNodePin();
      applyActiveHighlight();
      updateRenderedActiveNodeClasses(previousActiveNodeId, best.nodeId);
    }
  }

  function pinManualActiveNode(nodeId) {
    state.manualActiveNodeId = nodeId || null;
    state.manualActiveUntil = Date.now() + MANUAL_ACTIVE_NODE_HOLD_MS;
  }

  function clearManualActiveNodePin() {
    state.manualActiveNodeId = null;
    state.manualActiveUntil = 0;
  }

  function syncRenderedActiveNodeClasses() {
    if (!state.body) {
      return;
    }
    state.body.querySelectorAll("g[data-id].active").forEach((element) => {
      element.classList.remove("active");
    });
    if (!state.activeNodeId) {
      return;
    }
    const activeGroup = state.body.querySelector('g[data-id="' + state.activeNodeId + '"]');
    if (activeGroup) {
      activeGroup.classList.add("active");
    }
  }

  function updateRenderedActiveNodeClasses(previousNodeId, nextNodeId) {
    if (!state.body || previousNodeId === nextNodeId) {
      return;
    }
    if (previousNodeId) {
      const previousGroup = state.body.querySelector('g[data-id="' + previousNodeId + '"]');
      if (previousGroup) {
        previousGroup.classList.remove("active");
      }
    }
    if (nextNodeId) {
      const nextGroup = state.body.querySelector('g[data-id="' + nextNodeId + '"]');
      if (nextGroup) {
        nextGroup.classList.add("active");
      }
    }
  }

  function getLatestNodeId() {
    let latestNode = null;
    for (const node of Object.values(state.tree.nodes)) {
      if (!node || node.id === state.tree.rootId) {
        continue;
      }
      if (!latestNode) {
        latestNode = node;
        continue;
      }

      const nodeIndex = Number.isFinite(node.promptIndex) ? node.promptIndex : -1;
      const latestIndex = Number.isFinite(latestNode.promptIndex) ? latestNode.promptIndex : -1;
      if (nodeIndex > latestIndex) {
        latestNode = node;
        continue;
      }
      if (nodeIndex === latestIndex && (node.createdAt || 0) > (latestNode.createdAt || 0)) {
        latestNode = node;
      }
    }
    return latestNode?.id || null;
  }

  function applyActiveHighlight() {
    const target = state.activeNodeId ? state.domNodeMap.get(state.activeNodeId) : null;
    if (activeHighlightMarker) {
      activeHighlightMarker.mark(target || null);
      return;
    }

    if (state.highlightedPromptEl && state.highlightedPromptEl !== target) {
      state.highlightedPromptEl.removeAttribute(CURRENT_ATTR);
    }
    state.highlightedPromptEl = target || null;
    if (target) {
      target.setAttribute(CURRENT_ATTR, "true");
    }
  }

  function clearActiveHighlight() {
    if (activeHighlightMarker) {
      activeHighlightMarker.clear();
      return;
    }
    if (state.highlightedPromptEl) {
      state.highlightedPromptEl.removeAttribute(CURRENT_ATTR);
      state.highlightedPromptEl = null;
    }
  }

  function isSearchMatch(nodeId) {
    return state.searchResults.includes(nodeId);
  }

  function isSearchCurrent(nodeId) {
    return state.searchResults[state.searchIndex] === nodeId;
  }

  function summarizeAnswer(text) {
    if (!text) {
      return "等待回复";
    }
    const normalized = normalizeText(text);
    return shorten(normalized, 42);
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeBlockText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
      .join("\n")
      .trim();
  }

  function normalizeTurnText(role, text) {
    const normalized = normalizeBlockText(text);
    if (role !== "user" || !normalized) {
      return normalized;
    }
    return normalized
      .replace(/^(?:you\s*said|yousaid)\s*[:：-]?\s*/i, "")
      .replace(/^你说\s*[:：-]?\s*/, "")
      .trim();
  }

  function shorten(text, length) {
    if (text.length <= length) {
      return text;
    }
    return text.slice(0, Math.max(0, length - 3)) + "...";
  }

  function buildSignature(text) {
    return normalizeText(text).toLowerCase().slice(0, 220);
  }

  function makeNodeId() {
    return "node_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }
})();
