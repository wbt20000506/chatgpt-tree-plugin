const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const hardAlgorithm = require("../hard-algorithm.js");
const contentCore = require("../content-core.js");

function testAnswerPointCache() {
  assert.equal(typeof hardAlgorithm.resetDiagnostics, "function");
  assert.equal(typeof hardAlgorithm.getDiagnostics, "function");

  hardAlgorithm.resetDiagnostics();
  const answer = [
    "缓存策略包括：",
    "1. 文本签名缓存：避免重复克隆 DOM。",
    "2. 要点缓存：同一个回答不要反复解析列表。",
    "3. 写入瘦身：本地状态不保存完整回答。"
  ].join("\n");

  const first = hardAlgorithm.matchPromptToAnswerPoint("什么是要点缓存", answer);
  const second = hardAlgorithm.matchPromptToAnswerPoint("什么是要点缓存", answer);
  const diagnostics = hardAlgorithm.getDiagnostics();

  assert.ok(first);
  assert.ok(second);
  assert.equal(diagnostics.answerPointsCache.misses, 1);
  assert.equal(diagnostics.answerPointsCache.hits, 1);
}

function testCompactTreeSerialization() {
  assert.equal(typeof contentCore.serializeTreeForStorage, "function");
  assert.equal(typeof contentCore.hasPersistedVolatileTreeData, "function");

  const serialized = contentCore.serializeTreeForStorage({
    rootId: "root",
    version: 3,
    panelCollapsed: true,
    panelPosition: { left: 12, top: 34 },
    searchQuery: "缓存",
    linearSortEnabled: false,
    ignoredPromptIndices: [2],
    ignoredSignatures: ["sig-old"],
    ignoredTitles: ["旧问题"],
    nodes: {
      root: {
        id: "root",
        parentId: null,
        children: ["node_1"],
        title: "对话",
        answer: "root answer should not be persisted",
        signature: "root",
        askedAt: 0,
        createdAt: 1,
        updatedAt: 2,
        collapsed: false,
        promptIndex: -1,
        lastSeenAt: 3
      },
      node_1: {
        id: "node_1",
        parentId: "root",
        children: [],
        title: "如何优化长对话性能？",
        answer: "完整回答很长，不应进入 localStorage。",
        signature: "sig-1",
        askedAt: 10,
        createdAt: 11,
        updatedAt: 12,
        collapsed: true,
        promptIndex: 0,
        lastSeenAt: 13
      }
    }
  });

  assert.equal(serialized.nodes.node_1.title, "如何优化长对话性能？");
  assert.equal(serialized.nodes.node_1.signature, "sig-1");
  assert.equal(serialized.nodes.node_1.collapsed, true);
  assert.equal("answer" in serialized.nodes.node_1, false);
  assert.equal("updatedAt" in serialized.nodes.node_1, false);
  assert.equal("lastSeenAt" in serialized.nodes.node_1, false);
  assert.equal(contentCore.hasPersistedVolatileTreeData(serialized), false);
  assert.equal(contentCore.hasPersistedVolatileTreeData({
    nodes: {
      node_1: {
        answer: "old persisted answer",
        updatedAt: 12,
        lastSeenAt: 13
      }
    }
  }), true);
}

function testDebugLoggerExport() {
  assert.equal(typeof contentCore.createDebugLogger, "function");

  const logger = contentCore.createDebugLogger({
    source: "test",
    maxEntries: 2
  });
  logger.info("scan-start", { count: 2 });
  logger.warn("scan-slow", { ms: 1500 });
  logger.error("scan-error", new Error("scan failed"));

  const entries = logger.getEntries();
  const text = logger.exportText({
    diagnostics: {
      chatKey: "test-chat"
    }
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "scan-slow");
  assert.equal(entries[1].payload.message, "scan failed");
  assert.match(text, /scan-slow/);
  assert.match(text, /scan-error/);
  assert.match(text, /chatKey/);
}

function testDebugLoggerRedactedExport() {
  const logger = contentCore.createDebugLogger({
    source: "test",
    maxEntries: 5
  });
  logger.debug("jump-found-target", {
    href: "https://chatgpt.com/c/6969189c-d7d4-8320-9fcb-04f0fbfaced9",
    chatKey: "6969189c-d7d4-8320-9fcb-04f0fbfaced9",
    title: "吐哈盆地绿洲研究",
    text: "你现在是遥感地理学研究方向的计算机博士",
    durationMs: 123
  });

  const text = logger.exportText({
    redact: true,
    diagnostics: {
      href: "https://chatgpt.com/c/6969189c-d7d4-8320-9fcb-04f0fbfaced9",
      title: "吐哈盆地绿洲研究",
      userAgent: "Mozilla/5.0",
      nodeCount: 64
    }
  });

  assert.doesNotMatch(text, /6969189c-d7d4-8320-9fcb-04f0fbfaced9/);
  assert.doesNotMatch(text, /吐哈盆地绿洲研究/);
  assert.doesNotMatch(text, /遥感地理学/);
  assert.doesNotMatch(text, /Mozilla\/5\.0/);
  assert.match(text, /durationMs/);
  assert.match(text, /nodeCount/);
}

function testSingleAttributeMarkerClearsOnlyPreviousElement() {
  assert.equal(typeof contentCore.createSingleAttributeMarker, "function");

  const operations = [];
  const first = {
    setAttribute: (name, value) => operations.push(["first", "set", name, value]),
    removeAttribute: (name) => operations.push(["first", "remove", name])
  };
  const second = {
    setAttribute: (name, value) => operations.push(["second", "set", name, value]),
    removeAttribute: (name) => operations.push(["second", "remove", name])
  };
  const marker = contentCore.createSingleAttributeMarker("data-current");

  marker.mark(first);
  marker.mark(second);
  marker.clear();

  assert.deepEqual(operations, [
    ["first", "set", "data-current", "true"],
    ["first", "remove", "data-current"],
    ["second", "set", "data-current", "true"],
    ["second", "remove", "data-current"]
  ]);
  assert.equal(marker.getCurrent(), null);
}

function testClickPathAvoidsKnownFullDomScans() {
  const contentScript = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

  assert.doesNotMatch(contentScript, /queryAllDeep\([^)]*CURRENT_ATTR/);
  assert.doesNotMatch(contentScript, /document\.body\.querySelectorAll\(["']\*["']\)/);
}

function testLongPlainAnswerUsesBoundedMatchText() {
  const longAnswer = Array.from({ length: 400 }, (_, index) => {
    return "这是第 " + index + " 段关于吐哈盆地绿洲系统水土过程、生态承载、土地退化风险和遥感识别方法的长回答内容。";
  }).join("\n");
  const entries = hardAlgorithm.extractPromptEntries([
    { role: "user", text: "请介绍吐哈盆地绿洲系统", promptEl: {} },
    { role: "assistant", text: longAnswer, promptEl: {} },
    { role: "user", text: "这个风险怎么表述", promptEl: {} }
  ]);

  assert.ok(entries[0].answer.length > 10000);
  assert.ok(entries[0].answerMatchText.length <= 2200, "answerMatchText should be capped for long plain answers");
}

function testScanExtractionAvoidsFullDomClone() {
  const contentScript = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

  assert.doesNotMatch(extractFunctionSource(contentScript, "getGenericTurnText"), /cloneNode\(true\)/);
  assert.doesNotMatch(extractFunctionSource(contentScript, "extractAssistantMarkdown"), /cloneNode\(true\)/);
}

function testParentMatchingUsesBoundedRecentHistory() {
  hardAlgorithm.resetDiagnostics();
  const turns = [];
  for (let index = 0; index < 50; index += 1) {
    turns.push({
      role: "user",
      text: "第 " + index + " 个绿洲问题",
      promptEl: {}
    });
    turns.push({
      role: "assistant",
      text: "1. 生态承载：说明绿洲水土过程。\n2. 风险识别：说明土地退化风险。",
      promptEl: {}
    });
  }

  hardAlgorithm.extractPromptEntries(turns);
  const diagnostics = hardAlgorithm.getDiagnostics();
  const matchCalls = diagnostics.answerPointsCache.hits + diagnostics.answerPointsCache.misses;

  assert.ok(matchCalls <= 900, "parent matching should only scan a bounded recent history");
}

function testExtractedAnswerPointsStaySmallForLongBullets() {
  const longClause = "吐哈盆地绿洲系统涉及水土过程、生态承载、遥感识别、土地退化风险和荒漠化响应，需要在论文中谨慎表述。";
  const answer = Array.from({ length: 80 }, (_, index) => {
    return (index + 1) + ". 生态承载要点" + index + "：" + longClause.repeat(8);
  }).join("\n");
  const points = hardAlgorithm.extractAnswerPoints(answer);

  assert.ok(points.length <= 36, "answer point extraction should cap point count");
  assert.ok(points.every((point) => point.text.length <= 220), "answer point text should be capped");
  assert.ok(points.every((point) => point.variants.every((variant) => variant.length <= 180)), "match variants should be capped");
}

function testAlgorithmHandlesLongStructuredConversationQuickly() {
  hardAlgorithm.resetDiagnostics();
  const turns = [];
  const answer = Array.from({ length: 40 }, (_, index) => {
    return (index + 1) + ". 绿洲系统第" + index + "项：吐哈盆地绿洲系统涉及水土过程生态承载遥感识别土地退化风险荒漠化响应论文表述精准性和时空格局分析，需要综合说明驱动机制与区域生态安全。";
  }).join("\n");
  for (let index = 0; index < 66; index += 1) {
    turns.push({
      role: "user",
      text: "第" + index + "个问题 绿洲风险怎么表述",
      promptEl: {}
    });
    turns.push({
      role: "assistant",
      text: answer,
      promptEl: {}
    });
  }

  const startedAt = performance.now();
  hardAlgorithm.extractPromptEntries(turns);
  const durationMs = performance.now() - startedAt;

  assert.ok(durationMs < 1000, "long structured conversation algorithm took " + Math.round(durationMs) + "ms");
}

function extractFunctionSource(source, functionName) {
  const marker = "function " + functionName + "(";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "missing function " + functionName);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      bodyStarted = true;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (bodyStarted && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error("unterminated function " + functionName);
}

testAnswerPointCache();
testCompactTreeSerialization();
testDebugLoggerExport();
testDebugLoggerRedactedExport();
testSingleAttributeMarkerClearsOnlyPreviousElement();
testClickPathAvoidsKnownFullDomScans();
testLongPlainAnswerUsesBoundedMatchText();
testScanExtractionAvoidsFullDomClone();
testParentMatchingUsesBoundedRecentHistory();
testExtractedAnswerPointsStaySmallForLongBullets();
testAlgorithmHandlesLongStructuredConversationQuickly();
console.log("performance optimization tests passed");
