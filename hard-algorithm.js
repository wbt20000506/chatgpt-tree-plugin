(function (globalScope) {
  "use strict";

  const ROOT_PARENT_SIGNATURE = "__cgpt_tree_root__";
  const ANSWER_POINTS_CACHE_MAX = 320;
  const ANSWER_MATCH_TEXT_MAX_CHARS = 2000;
  const PARENT_MATCH_CANDIDATE_LIMIT = 12;
  const ANSWER_POINT_MAX_COUNT = 32;
  const ANSWER_POINT_TEXT_MAX_CHARS = 180;
  const MATCH_VARIANT_MAX_CHARS = 160;
  const answerPointsCache = new Map();
  const diagnostics = {
    answerPointsCacheHits: 0,
    answerPointsCacheMisses: 0,
    pointMatchCalls: 0,
    pointScoreCalls: 0
  };

  function extractPromptEntries(turns) {
    const entries = [];
    const answeredPrompts = [];
    let currentPrompt = null;

    for (const turn of Array.isArray(turns) ? turns : []) {
      const role = turn?.role;
      const answerText = role === "assistant"
        ? normalizeBlockText(turn?.text || turn?.markdown || "")
        : "";
      const matchSourceText = role === "assistant"
        ? normalizeBlockText(turn?.matchText || turn?.markdown || answerText)
        : "";
      const text = role === "assistant"
        ? answerText
        : normalizeBlockText(turn?.text || "");
      if (!text) {
        continue;
      }

      if (role === "user") {
        const promptText = normalizePromptText(text);
        if (!promptText) {
          continue;
        }
        const parentMatch = findPromptParentMatch(promptText, answeredPrompts);
        currentPrompt = {
          analysisId: "question_" + entries.length,
          title: promptText,
          fullText: promptText,
          answer: "",
          answerSketch: "",
          signature: buildSignature(promptText),
          answerSignature: "",
          promptEl: turn?.promptEl || null,
          parentSignature: parentMatch ? parentMatch.parentSignature : "",
          matchedPoint: parentMatch ? parentMatch.point.text : ""
        };
        entries.push(currentPrompt);
        continue;
      }

      if (role === "assistant" && currentPrompt) {
        currentPrompt.answer = normalizeBlockText([currentPrompt.answer, text].filter(Boolean).join("\n"));

        const sketchPart = extractAnswerSketch(matchSourceText || text);
        if (sketchPart) {
          currentPrompt.answerSketch = normalizeBlockText([currentPrompt.answerSketch, sketchPart].filter(Boolean).join("\n"));
        }

        // Keep full answer for display/export, but only feed compact text into matching.
        const signatureSource = buildAnswerMatchText(currentPrompt.answerSketch, matchSourceText || currentPrompt.answer);
        currentPrompt.answerSignature = buildSignature(signatureSource);
        currentPrompt.answerMatchText = normalizeBlockText(signatureSource);
        if (!answeredPrompts.includes(currentPrompt)) {
          answeredPrompts.push(currentPrompt);
        }
      }
    }

    return entries;
  }

  function buildAnswerMatchText(answerSketch, answerText) {
    const sketch = normalizeBlockText(answerSketch);
    if (sketch) {
      return truncateMatchText(sketch);
    }
    return compactAnswerForMatch(answerText);
  }

  function compactAnswerForMatch(answerText) {
    const text = normalizeBlockText(answerText);
    if (text.length <= ANSWER_MATCH_TEXT_MAX_CHARS) {
      return text;
    }

    const lines = text
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean);
    const picked = [];
    let totalChars = 0;

    const pushLine = (line) => {
      if (!line || totalChars >= ANSWER_MATCH_TEXT_MAX_CHARS) {
        return;
      }
      const remaining = ANSWER_MATCH_TEXT_MAX_CHARS - totalChars;
      const value = line.length > remaining ? line.slice(0, remaining) : line;
      picked.push(value);
      totalChars += value.length + 1;
    };

    for (const line of lines) {
      if (picked.length >= 18 || totalChars >= ANSWER_MATCH_TEXT_MAX_CHARS) {
        break;
      }
      pushLine(line);
    }

    return truncateMatchText(picked.join("\n") || text);
  }

  function truncateMatchText(text) {
    const normalized = normalizeBlockText(text);
    if (normalized.length <= ANSWER_MATCH_TEXT_MAX_CHARS) {
      return normalized;
    }
    return normalized.slice(0, ANSWER_MATCH_TEXT_MAX_CHARS).trim();
  }

  function getCandidateAnswerForMatch(candidate) {
    if (typeof candidate?.answerMatchText === "string") {
      return candidate.answerMatchText;
    }
    return normalizeBlockText(candidate?.answerSketch || candidate?.answer || "");
  }

  function findPromptParentMatch(promptText, answeredPrompts) {
    if (!answeredPrompts.length) {
      return null;
    }

    let bestPointMatch = null;
    const candidates = answeredPrompts.length > PARENT_MATCH_CANDIDATE_LIMIT
      ? answeredPrompts.slice(-PARENT_MATCH_CANDIDATE_LIMIT)
      : answeredPrompts;

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      const candidateAnswer = getCandidateAnswerForMatch(candidate);
      if (!candidateAnswer) {
        continue;
      }

      const pointMatch = matchPromptToAnswerPoint(promptText, candidateAnswer);
      if (!pointMatch) {
        continue;
      }

      const distance = candidates.length - 1 - index;
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

  function extractAnswerSketch(answerText) {
    const text = normalizeBlockText(answerText);
    if (!text) {
      return "";
    }

    const lines = text
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const picked = [];
    let totalChars = 0;

    const pushLine = (value) => {
      const normalized = normalizeText(value);
      if (!normalized) {
        return;
      }
      if (picked.length >= 28 || totalChars >= 1600) {
        return;
      }
      picked.push(normalized);
      totalChars += normalized.length;
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/^\s*(?:>\s*)?/, "").trim();
      if (!line) {
        continue;
      }

      // Markdown headings (small titles)
      const mdHeading = line.match(/^#{1,4}\s+(.+)$/);
      if (mdHeading) {
        pushLine(mdHeading[1]);
        continue;
      }

      // "一、二、1." style short section headings
      const shortHeading = line.match(/^(?:\d{1,3}[.)、]|[一二三四五六七八九十]+[、.）)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*([^:：]{2,28})$/);
      if (shortHeading) {
        pushLine(shortHeading[1]);
        continue;
      }

      // Lines that are essentially a bold title, optionally with a short explanation.
      const boldMatch = line.match(/^(?:[-*•·▪◦]\s*)?(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*(?:[：:.-]\s*(.+))?$/);
      if (boldMatch) {
        pushLine([boldMatch[1], boldMatch[2]].filter(Boolean).join("："));
        continue;
      }
    }

    return picked.join("\n").trim();
  }

  function matchPromptToAnswerPoint(promptText, answerText) {
    diagnostics.pointMatchCalls += 1;
    const points = getCachedAnswerPoints(answerText);
    if (!points.length) {
      return null;
    }

    const promptProfiles = buildPromptMatchVariants(promptText)
      .map((variant) => buildPromptProfile(variant))
      .filter((profile) => profile.compact);
    if (!promptProfiles.length) {
      return null;
    }

    let bestMatch = null;

    for (const point of points) {
      let score = 0;
      const pointProfiles = point.variantProfiles || point.variants.map((variant) => buildMatchProfile(variant));
      const headProfile = point.headProfile || buildMatchProfile(point.head);

      for (const promptProfile of promptProfiles) {
        for (const pointProfile of pointProfiles) {
          diagnostics.pointScoreCalls += 1;
          score = Math.max(score, scorePromptPointProfileMatch(promptProfile, headProfile, pointProfile));
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

  function getCachedAnswerPoints(answerText) {
    const text = normalizeBlockText(answerText);
    if (!text) {
      return [];
    }
    const key = buildAnswerPointsCacheKey(text);
    if (answerPointsCache.has(key)) {
      diagnostics.answerPointsCacheHits += 1;
      const cached = answerPointsCache.get(key);
      answerPointsCache.delete(key);
      answerPointsCache.set(key, cached);
      return cached;
    }

    diagnostics.answerPointsCacheMisses += 1;
    const points = extractAnswerPoints(text);
    answerPointsCache.set(key, points);
    while (answerPointsCache.size > ANSWER_POINTS_CACHE_MAX) {
      const oldestKey = answerPointsCache.keys().next().value;
      answerPointsCache.delete(oldestKey);
    }
    return points;
  }

  function buildAnswerPointsCacheKey(text) {
    const normalized = normalizeBlockText(text);
    let hash = 5381;
    for (let index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
    }
    return normalized.length + ":" + (hash >>> 0).toString(36);
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
      if (points.length >= ANSWER_POINT_MAX_COUNT) {
        return;
      }
      const compactPointText = compactAnswerPointText(pointText);
      const normalizedPoint = normalizeForMatch(compactPointText);
      if (!normalizedPoint || seen.has(normalizedPoint)) {
        return;
      }

      const head = extractPointHead(compactPointText);
      if (!head) {
        return;
      }

      const context = shorten(normalizeText(contextText || ""), 60);
      const variants = buildPointMatchVariants(compactPointText, head, context);
      seen.add(normalizedPoint);
      points.push({
        text: compactPointText,
        head,
        context,
        variants,
        variantProfiles: variants.map((variant) => buildPointVariantProfile(variant)),
        headProfile: buildPointVariantProfile(head)
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
      if (points.length >= ANSWER_POINT_MAX_COUNT) {
        break;
      }
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

      currentPoint = compactAnswerPointText(currentPoint + " " + stripContinuationPrefix(line));
      currentContext = extractPointContext(currentPoint);
    }

    pushPoint();
    return points;
  }

  function compactAnswerPointText(text) {
    const normalized = cleanupPointText(text);
    if (normalized.length <= ANSWER_POINT_TEXT_MAX_CHARS) {
      return normalized;
    }

    const sentenceParts = normalized.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
    const picked = [];
    let totalChars = 0;
    for (const part of sentenceParts) {
      if (!part || totalChars + part.length > ANSWER_POINT_TEXT_MAX_CHARS) {
        break;
      }
      picked.push(part);
      totalChars += part.length;
    }
    const compact = picked.join("") || normalized;
    return compact.slice(0, ANSWER_POINT_TEXT_MAX_CHARS).trim();
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
    return Array.from(new Set([
      stripped,
      normalized,
      subjectLike,
      compactSubject
    ].filter((item) => item && item.length >= 2)));
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
      .map((item) => truncateMatchVariant(stripQuestionSuffix(normalizeForMatch(item))))
      .filter((item) => item && item.length >= 2)));
  }

  function truncateMatchVariant(text) {
    const normalized = normalizeText(text);
    if (normalized.length <= MATCH_VARIANT_MAX_CHARS) {
      return normalized;
    }
    return normalized.slice(0, MATCH_VARIANT_MAX_CHARS).trim();
  }

  function scorePromptPointProfileMatch(promptProfile, headProfile, pointProfile) {
    const promptCoreProfile = promptProfile.coreProfile || buildMatchProfile(stripPromptIntent(promptProfile.normalized) || promptProfile.normalized);
    const pointCoreProfile = pointProfile.coreProfile || buildMatchProfile(stripQuestionSuffix(pointProfile.normalized) || pointProfile.normalized);
    const headCoreProfile = headProfile.coreProfile || buildMatchProfile(stripQuestionSuffix(headProfile.normalized) || headProfile.normalized);
    let score = Math.max(
      getProfileSimilarityScore(promptCoreProfile, pointCoreProfile) + 4,
      getProfileSimilarityScore(promptCoreProfile, headCoreProfile) + 2
    );

    if (promptCoreProfile.compact === headCoreProfile.compact) {
      score += 18;
    }
    if (pointCoreProfile.compact.includes(promptCoreProfile.compact)) {
      score += Math.min(12, promptCoreProfile.compact.length * 2);
    }
    if (isGenericPointHead(headCoreProfile.normalized)) {
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
    const previousAnswer = normalizeForMatch(getCandidateAnswerForMatch(candidate));
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
    return extractMatchTokensFromNormalized(normalizeForMatch(text));
  }

  function extractMatchTokensFromNormalized(normalized) {
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
    return getProfileSimilarityScore(buildMatchProfile(left), buildMatchProfile(right));
  }

  function getProfileSimilarityScore(leftProfile, rightProfile) {
    if (!leftProfile.compact || !rightProfile.compact) {
      return 0;
    }

    let score = 0;

    if (leftProfile.compact === rightProfile.compact) {
      score = Math.max(score, 90);
    } else if (leftProfile.compact.includes(rightProfile.compact) || rightProfile.compact.includes(leftProfile.compact)) {
      score = Math.max(score, 58 + Math.min(leftProfile.compact.length, rightProfile.compact.length));
    }

    const overlap = getProfileTokenOverlapScore(leftProfile, rightProfile);
    const coverage = getProfileTokenCoverageScore(leftProfile, rightProfile);
    const ngramScore = getProfileNGramScore(leftProfile, rightProfile);

    score = Math.max(score, overlap + coverage + ngramScore);
    return score;
  }

  function buildMatchProfile(text) {
    const normalized = normalizeForMatch(text);
    const compact = normalized.replace(/\s+/g, "");
    const tokens = extractMatchTokensFromNormalized(normalized);
    const ngrams = extractCharacterNGramsFromCompact(compact);
    return {
      normalized,
      compact,
      tokens,
      tokenSet: new Set(tokens),
      ngrams,
      ngramSet: new Set(ngrams)
    };
  }

  function buildPromptProfile(text) {
    const profile = buildMatchProfile(text);
    profile.coreProfile = buildMatchProfile(stripPromptIntent(profile.normalized) || profile.normalized);
    return profile;
  }

  function buildPointVariantProfile(text) {
    const profile = buildMatchProfile(text);
    profile.coreProfile = buildMatchProfile(stripQuestionSuffix(profile.normalized) || profile.normalized);
    return profile;
  }

  function getProfileTokenOverlapScore(leftProfile, rightProfile) {
    if (!leftProfile.tokens.length || !rightProfile.tokenSet.size) {
      return 0;
    }

    let score = 0;
    for (const token of leftProfile.tokens) {
      if (token.length < 2) {
        continue;
      }
      if (rightProfile.tokenSet.has(token)) {
        score += token.length >= 4 ? 4 : 2;
      }
    }
    return score;
  }

  function getProfileTokenCoverageScore(leftProfile, rightProfile) {
    const leftTokens = leftProfile.tokens.filter((token) => token.length >= 2);
    if (!leftTokens.length || !rightProfile.tokenSet.size) {
      return 0;
    }

    let matched = 0;
    for (const token of leftTokens) {
      if (rightProfile.tokenSet.has(token)) {
        matched += 1;
      }
    }

    return Math.round((matched / leftTokens.length) * 16);
  }

  function getProfileNGramScore(leftProfile, rightProfile) {
    if (!leftProfile.ngrams.length || !rightProfile.ngramSet.size) {
      return 0;
    }

    let matched = 0;
    for (const gram of leftProfile.ngrams) {
      if (rightProfile.ngramSet.has(gram)) {
        matched += 1;
      }
    }

    return Math.round((2 * matched / (leftProfile.ngrams.length + rightProfile.ngrams.length)) * 18);
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
    return extractCharacterNGramsFromCompact(compactMatchText(text));
  }

  function extractCharacterNGramsFromCompact(compact) {
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

    if (compactLeft.includes(compactRight) || compactRight.includes(compactLeft)) {
      return 16;
    }

    const shorter = compactLeft.length <= compactRight.length ? compactLeft : compactRight;
    const longer = compactLeft.length <= compactRight.length ? compactRight : compactLeft;
    const maxSize = Math.min(shorter.length, 24);
    for (let size = maxSize; size >= 2; size -= 1) {
      for (let index = 0; index <= shorter.length - size; index += 1) {
        if (longer.includes(shorter.slice(index, index + size))) {
          return Math.round((size / Math.max(1, Math.min(compactLeft.length, compactRight.length))) * 16);
        }
      }
    }

    return 0;
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

  function normalizePromptText(text) {
    return normalizeBlockText(text)
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

  function getDiagnostics() {
    return {
      answerPointsCache: {
        size: answerPointsCache.size,
        hits: diagnostics.answerPointsCacheHits,
        misses: diagnostics.answerPointsCacheMisses
      },
      pointMatchCalls: diagnostics.pointMatchCalls,
      pointScoreCalls: diagnostics.pointScoreCalls
    };
  }

  function resetDiagnostics() {
    answerPointsCache.clear();
    diagnostics.answerPointsCacheHits = 0;
    diagnostics.answerPointsCacheMisses = 0;
    diagnostics.pointMatchCalls = 0;
    diagnostics.pointScoreCalls = 0;
  }

  const api = {
    ROOT_PARENT_SIGNATURE,
    buildSignature,
    extractAnswerPoints,
    extractPromptEntries,
    findPromptContinuationParent,
    findPromptParentMatch,
    getDiagnostics,
    matchPromptToAnswerPoint,
    normalizeBlockText,
    normalizeText,
    resetDiagnostics
  };

  globalScope.CGPTTreeHardAlgorithm = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
