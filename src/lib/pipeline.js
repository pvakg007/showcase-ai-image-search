/**
 * 共享处理流水线 —— SSE 实时流 + 后台断点续跑 的单一事实来源。
 *
 * 两个调用方：
 *   - process-stream (SSE)：传入 onEvent，把每个阶段实时推给前端
 *   - process-queue  (后台)：onEvent 为空，静默跑完用于恢复/续跑
 *
 * 断点续跑（幂等）：
 *   - 每张图压缩完 → 存 file.compressedKey（续跑时直接从 images/ 下载，不再压缩）
 *   - AI 调用完成 → 存 job.aiRaw（续跑时跳过 AI，直接写结果 —— 省钱 + 守"一次批量调用"规则）
 *   - 文档 id = jobId*1000+index（稳定，续跑重复写为幂等 upsert）
 */

import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import path from "path";
import fs from "fs";

// 压缩由浏览器在上传前完成（1600px JPEG）。服务端不再依赖 sharp —— 它在 Vercel
// serverless 上 libvips.so 会被排除出函数包，反复加载失败。服务端只做透传并测量尺寸。

// ============================================================
// 工具函数
// ============================================================

export function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  var m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (_) {} }
  var b = text.match(/\{[\s\S]*\}/);
  if (b) { try { return JSON.parse(b[0]); } catch (_) {} }
  return null;
}

function extractKey(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch (_) { return null; }
}

/** 稳定的文档 id：jobId*1000 + 图片下标，续跑重复写为幂等 upsert */
function stableDocId(jobId, imageIndex) {
  var base = parseInt(jobId, 10) || Date.now();
  return base * 1000 + imageIndex;
}

/**
 * 提取搜索字段（title / summary / tags）
 * imageIndex: 1-based。批量模式下只提取匹配 (图N) 的空间数据
 * spaceNames: 用户标注的空间名称数组，追加到标题末尾
 *
 * 关键词规则（用户定义）：
 *   - 不取「设计手法」(designTechniques)
 *   - 「色彩·核心应用」(coreApplication)：仅按 + 号分段；/ , ， 等不算分隔符
 *   - 「运用材质」(materials)：全部
 *   - 「软装单品」(softDecorationItems.itemName)：全部
 */
export function extractSearchFields(analysis, imageIndex, spaceNames) {
  var title = "未命名图片", summary = "暂无总结", tags = [];
  try {
    var sd = analysis && analysis.styleDefinition;
    var oes = analysis && analysis.overallEmotionalStyle;
    var cds = analysis && analysis.colorDesignSummary;
    if (sd && sd.coreStyle) title = sd.coreStyle;
    // 标题追加用户标注的空间名称
    if (Array.isArray(spaceNames) && spaceNames.length > 0) {
      title = title + "，" + spaceNames.join("、");
    }
    var parts = [];
    if (oes && oes.coreTemperament) parts.push("核心气质：" + oes.coreTemperament);
    if (Array.isArray(oes && oes.detailedInterpretation)) parts.push.apply(parts, oes.detailedInterpretation);
    if (parts.length > 0) summary = parts.join("；");
    var tagSet = new Set();
    var splitInto = function (text) {
      if (!text) return;
      String(text).split(/[、,，/\/\s]+/).forEach(function (t) {
        var c = t.trim(); if (c) tagSet.add(c);
      });
    };
    if (sd) { splitInto(sd.coreStyle); splitInto(sd.emotionalTone); } // 不取 designTechniques
    // 核心应用：仅按 + 号分段（/ , ， 不算分隔符）
    if (cds && cds.coreApplication) {
      String(cds.coreApplication).split("+").forEach(function (t) {
        var c = t.trim(); if (c) tagSet.add(c);
      });
    }
    if (Array.isArray(analysis && analysis.spaceSoftDecorationAnalysis)) {
      analysis.spaceSoftDecorationAnalysis.forEach(function (s) {
        if (imageIndex) {
          var suffix = "（图" + imageIndex + "）";
          var suffixAlt = "(图" + imageIndex + ")";
          if (!s || !s.spaceName || (s.spaceName.indexOf(suffix) === -1 && s.spaceName.indexOf(suffixAlt) === -1)) return;
        }
        if (s && s.spaceName) tagSet.add(s.spaceName);
        if (Array.isArray(s && s.softDecorationItems)) s.softDecorationItems.forEach(function (i) { if (i && i.itemName) tagSet.add(i.itemName); });
        if (Array.isArray(s && s.materials)) s.materials.forEach(function (m) { if (m) tagSet.add(m); });
      });
    }
    tags = Array.from(tagSet).slice(0, 30);
  } catch (_) {}
  return { title: title, summary: summary, tags: tags };
}

/**
 * 构建单张图的 Markdown（imageIndex 过滤属于该图的空间）
 */
export function buildMarkdown(analysis, imageUrl, timestamp, spaceNames, imageIndex) {
  var lines = [];
  try {
    var sd = analysis && analysis.styleDefinition;
    var oes = analysis && analysis.overallEmotionalStyle;
    var cds = analysis && analysis.colorDesignSummary;
    var spaces = analysis && analysis.spaceSoftDecorationAnalysis;
    var ideas = analysis && analysis.generalMatchingIdeas;
    var spaceLabel = Array.isArray(spaceNames) && spaceNames.length > 0 ? spaceNames.join("、") : "";
    lines.push("# " + ((sd && sd.coreStyle) || spaceLabel || "设计分析"));
    lines.push("", "---", "");
    if (sd || spaceLabel) {
      lines.push("## 基本信息");
      lines.push("- **上传时间**: " + new Date(timestamp).toLocaleString());
      lines.push("- **图片链接**: [查看原图](" + imageUrl + ")");
      if (spaceLabel) lines.push("- **空间名称**: " + spaceLabel);
      lines.push("");
    }
    if (sd) {
      lines.push("## 风格定义");
      if (sd.coreStyle) lines.push("- **核心风格**: " + sd.coreStyle);
      if (sd.designTechniques) lines.push("- **设计手法**: " + sd.designTechniques);
      if (sd.emotionalTone) lines.push("- **情感基调**: " + sd.emotionalTone);
      lines.push("");
    }
    if (oes) {
      lines.push("## 整体情感格调");
      if (oes.coreTemperament) lines.push("- **核心气质**: " + oes.coreTemperament);
      if (Array.isArray(oes.detailedInterpretation)) {
        lines.push("", "### 详细解读");
        oes.detailedInterpretation.forEach(function (item, i) { lines.push((i + 1) + ". " + item); });
      }
      lines.push("");
    }
    if (cds) {
      lines.push("## 色彩设计总结");
      if (cds.coreApplication) lines.push("- **核心应用**: " + cds.coreApplication);
      if (cds.coreLogic) lines.push("- **核心逻辑**: " + cds.coreLogic);
      if (Array.isArray(cds.coreTechniques)) { lines.push("", "### 核心手法"); cds.coreTechniques.forEach(function (item, i) { lines.push((i + 1) + ". " + item); }); }
      if (Array.isArray(cds.balanceLogic)) { lines.push("", "### 平衡逻辑"); cds.balanceLogic.forEach(function (item, i) { lines.push((i + 1) + ". " + item); }); }
      lines.push("");
    }
    if (Array.isArray(spaces) && spaces.length > 0) {
      var filteredSpaces = spaces;
      if (imageIndex) {
        var figSuffix = "（图" + imageIndex + "）";
        var figSuffixAlt = "(图" + imageIndex + ")";
        filteredSpaces = spaces.filter(function (sp) {
          if (!sp.spaceName) return false;
          return sp.spaceName.indexOf(figSuffix) !== -1 || sp.spaceName.indexOf(figSuffixAlt) !== -1;
        });
      } else if (Array.isArray(spaceNames) && spaceNames.length > 0) {
        filteredSpaces = spaces.filter(function (sp) {
          if (!sp.spaceName) return false;
          return spaceNames.some(function (sn) {
            return sp.spaceName.indexOf(sn) !== -1 || sn.indexOf(sp.spaceName) !== -1;
          });
        });
      }
      if (filteredSpaces.length > 0) {
        lines.push("## 空间软装分析", "");
        filteredSpaces.forEach(function (space, si) {
          lines.push("### " + (si + 1) + ". " + (space.spaceName || "未命名空间"));
          if (space.functionalAdaptation) lines.push("- **功能适配**: " + space.functionalAdaptation);
          if (space.hardwareBase) lines.push("- **硬装基础**: " + space.hardwareBase);
          if (Array.isArray(space.materials)) {
            lines.push("", "**运用材质：**");
            space.materials.forEach(function (mat) { lines.push("- " + mat); });
          }
          if (Array.isArray(space.softDecorationItems)) {
            lines.push("", "**软装单品：**");
            space.softDecorationItems.forEach(function (item) { lines.push("- **" + item.itemName + "**: " + item.matchingLogic); });
          }
          lines.push("");
        });
      }
    }
    if (Array.isArray(ideas) && ideas.length > 0) {
      lines.push("## 通用搭配思路", "");
      ideas.forEach(function (idea) {
        lines.push("### " + (idea.principleName || "搭配原则"));
        if (Array.isArray(idea.detailedRules)) idea.detailedRules.forEach(function (rule) { lines.push("- " + rule); });
        lines.push("");
      });
    }
  } catch (_) { lines.push("分析数据解析异常，请查看原始分析结果。"); }
  return lines.join("\n");
}

/**
 * 服务端图片处理：透传 buffer（浏览器已在上传前压缩到 1600px JPEG），仅测量尺寸。
 * 返回 { buffer, originalSize, compressedSize, sharpUsed }
 */
export async function compressImage(buffer) {
  var size = buffer.length;
  return { buffer: buffer, originalSize: size, compressedSize: size, sharpUsed: false };
}

// ============================================================
// AI 设置 / 提示词
// ============================================================

async function makeCos() {
  return new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });
}

export async function readAiSettings(cos) {
  var aiUrl = process.env.SPARK_API_URL || "";
  var aiModel = process.env.SPARK_MODEL || "qwen3.6-plus";
  var aiKey = process.env.SPARK_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  var aiPrompt = "";
  try {
    var configData = await new Promise(function (resolve, reject) {
      cos.getObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: "config/ai-settings.json",
      }, function (err, d) { if (err) reject(err); else resolve(d); });
    });
    var configBody = Buffer.isBuffer(configData.Body) ? configData.Body : Buffer.from(configData.Body);
    var settings = JSON.parse(configBody.toString("utf-8"));
    if (settings.aiUrl) aiUrl = settings.aiUrl;
    if (settings.aiModel) aiModel = settings.aiModel;
    if (settings.aiPrompt) aiPrompt = settings.aiPrompt;
  } catch (_) {}
  return { aiUrl: aiUrl, aiModel: aiModel, aiKey: aiKey, aiPrompt: aiPrompt };
}

async function readPrompt(cos, aiSettings) {
  if (aiSettings.aiPrompt && aiSettings.aiPrompt.trim()) {
    return aiSettings.aiPrompt;
  }
  try {
    var filePrompt = fs.readFileSync(path.join(process.cwd(), "提示词.txt"), "utf-8");
    if (filePrompt && filePrompt.trim()) return filePrompt;
  } catch (_) {}
  return null; // 由调用方回退到内嵌提示词
}

// ============================================================
// 流式 AI 调用（SSE + 首帧检测 + onChunk 回调 + 读秒）
// ============================================================

/**
 * @param {object} opts
 *   - onChunk(text)        每收到一段 delta 触发（用于实时推送内容）
 *   - onFirstFrame(ms)     首帧到达
 *   - onTailWait(elapsedSec, sinceFirstSec)  读秒心跳（每秒一次，首帧后开始）
 */
export async function streamAiResponse(url, body, headers, opts) {
  opts = opts || {};
  var onChunk = opts.onChunk || function () {};
  var onFirstFrame = opts.onFirstFrame || function () {};
  var onTailWait = opts.onTailWait || function () {};
  var accumulatedContent = "";
  var firstChunkReceived = false;
  var FIRST_CHUNK_TIMEOUT = 20000;
  var FULL_TIMEOUT = 180000; // 单批 AI 上限 180s，保证一批+开销 < maxDuration(290s)，绝不批中途被杀
  var lastErrMsg = "";
  var startTime = Date.now();
  var firstFrameMs = 0;

  // 读秒心跳：首帧后每秒触发一次
  var tailTimer = null;

  try {
    var controller = new AbortController();
    var fullTimeoutId = setTimeout(function () { controller.abort(); }, FULL_TIMEOUT);

    var response = await fetch(url, {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(fullTimeoutId);
      var isAuth = response.status === 401 || response.status === 403;
      var errText = ""; try { errText = await response.text(); } catch (_) {}
      return { content: null, isAuthError: isAuth, error: "HTTP " + response.status + ": " + errText.substring(0, 200) };
    }
    if (!response.body) {
      clearTimeout(fullTimeoutId);
      return { content: null, isAuthError: false, error: "响应体为空" };
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    var firstChunkTimer = setTimeout(function () {
      if (!firstChunkReceived) {
        try { reader.cancel(); } catch (_) {}
        controller.abort();
        lastErrMsg = "首帧超时（20s 内未收到数据）";
      }
    }, FIRST_CHUNK_TIMEOUT);

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;
      var chunk = decoder.decode(readResult.value, { stream: true });
      buffer += chunk;
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (var li = 0; li < lines.length; li++) {
        var trimmed = lines[li].trim();
        if (!trimmed || trimmed === "data: [DONE]" || trimmed.indexOf("data: ") !== 0) continue;
        var jsonStr = trimmed.slice(6);
        try {
          var parsed = JSON.parse(jsonStr);
          var delta = (parsed.choices && parsed.choices[0] && (parsed.choices[0].delta || {}).content)
            || (parsed.choices && parsed.choices[0] && (parsed.choices[0].message || {}).content) || "";
          if (delta) {
            accumulatedContent += delta;
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              firstFrameMs = Date.now() - startTime;
              clearTimeout(firstChunkTimer);
              onFirstFrame(firstFrameMs);
              // 启动读秒心跳
              tailTimer = setInterval(function () {
                onTailWait(Math.floor((Date.now() - startTime) / 1000), Math.floor((Date.now() - startTime - firstFrameMs) / 1000));
              }, 1000);
            }
            onChunk(delta);
          }
        } catch (_) {}
      }
    }

    clearTimeout(firstChunkTimer);
    clearTimeout(fullTimeoutId);
    if (tailTimer) clearInterval(tailTimer);

    if (!accumulatedContent) {
      return { content: null, isAuthError: false, error: "流式响应结束但未获得有效内容" };
    }
    return { content: accumulatedContent, isAuthError: false, error: null, firstFrameMs: firstFrameMs };
  } catch (err) {
    clearTimeout(fullTimeoutId);
    if (tailTimer) clearInterval(tailTimer);
    if (err.name === "AbortError") {
      return { content: null, isAuthError: false, error: lastErrMsg || "请求超时（250s）" };
    }
    return { content: null, isAuthError: false, error: err.message };
  }
}

// ============================================================
// Meilisearch 辅助
// ============================================================

async function updateJob(jobId, fields) {
  await axios.post(
    process.env.MEILISEARCH_HOST + "/indexes/processing_jobs/documents",
    [Object.assign({ id: jobId }, fields)],
    { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
  );
}

// ============================================================
// 主流水线
// ============================================================

/**
 * 运行完整流水线（带断点续跑 + 事件回调）。
 * @param {object} job 任务文档
 * @param {object} opts
 *   - onEvent(type, data)  每个阶段触发（type 见下方）
 *   - heartbeat()          定期调用（SSE 模式下用于刷新 processingLock，防被恢复机制误抢）
 * @returns {Promise<{success:boolean, results:Array, error:?string}>}
 */
export async function runPipeline(job, opts) {
  opts = opts || {};
  var onEvent = opts.onEvent || function () {};
  var heartbeat = opts.heartbeat || function () {};
  var jobId = job.id;
  var files = job.files || [];

  // ===== 逐步日志：相对启动时间的毫秒数，便于定位卡在哪一步 =====
  var pipeStart = Date.now();
  function plog(msg) { console.log("[pipe +" + (Date.now() - pipeStart) + "ms] job=" + jobId + " " + msg); }
  plog("启动流水线，共 " + files.length + " 张图片，模式=" + (opts.onEvent ? "stream" : "background"));

  // ===== 定时心跳：整个流水线期间每 20s 刷一次 processingLock。
  // 关键：AI 首帧可能要 100s+，期间无数据流 → 旧的"按 chunk 触发 heartbeat"不生效，
  // 锁会超过 recoverStuckJobs 阈值被误重置。用独立定时器保活，不依赖数据流。 =====
  var keepalive = setInterval(function () { try { heartbeat(); } catch (_) {} }, 20000);

  var cos = await makeCos();
  var aiSettings = await readAiSettings(cos);
  plog("读取 AI 设置完成: model=" + aiSettings.aiModel + " url=" + (aiSettings.aiUrl || "(空)"));
  var bucketDomain = (process.env.COS_BUCKET || "") + ".cos." + (process.env.COS_REGION || "") + ".myqcloud.com";

  var results = Array.isArray(job.results) ? job.results.slice() : [];

  // ============ Phase 1: 下载 + 压缩（并行 + 断点续跑 + 合并 checkpoint）============
  // 并行处理所有图片，避免逐张串行 + 逐张写 Meilisearch 导致移动端 5 图超时。
  heartbeat();
  plog("Phase1 开始：下载+压缩（并行 " + files.length + "）");
  var updatedFiles = (job.files || []).slice(); // 副本，最后一次性写回

  var imageList = await Promise.all(files.map(function (fi, i) {
    return (async function () {
      if (!fi || !fi.cosKey) {
        onEvent("stage", { stage: "skip", index: i + 1, total: files.length, reason: "缺少 COS key" });
        return { compressed: null, compressedKey: "", url: "", spaceNames: (fi && fi.spaceNames) || [], idx: i, error: "缺少 COS key" };
      }

      // 断点续跑：已有 compressedKey → 直接从 images/ 下载已压缩版（不再压缩）
      if (fi.compressedKey) {
        onEvent("stage", { stage: "resuming", index: i + 1, total: files.length });
        try {
          var resumeData = await new Promise(function (resolve, reject) {
            cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.compressedKey },
              function (err, d) { if (err) reject(err); else resolve(d); });
          });
          var resumeBuf = Buffer.isBuffer(resumeData.Body) ? resumeData.Body : Buffer.from(resumeData.Body);
          onEvent("compressed", { index: i + 1, total: files.length, originalSize: fi.originalSize || resumeBuf.length, compressedSize: resumeBuf.length, sharp: true });
          return {
            compressed: resumeBuf, compressedKey: fi.compressedKey,
            url: "https://" + bucketDomain + "/" + fi.compressedKey,
            spaceNames: fi.spaceNames || [], idx: i,
            originalSize: fi.originalSize || resumeBuf.length, compressedSize: resumeBuf.length,
            sharpUsed: true, error: null,
          };
        } catch (err) {
          console.warn("[resume] 已压缩版丢失，回退重压缩:", fi.compressedKey, err.message);
        }
      }

      onEvent("stage", { stage: "downloading", index: i + 1, total: files.length });
      try {
        var dlT0 = Date.now();
        var dlData = await new Promise(function (resolve, reject) {
          cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey },
            function (err, d) { if (err) reject(err); else resolve(d); });
        });
        var buf = Buffer.isBuffer(dlData.Body) ? dlData.Body : Buffer.from(dlData.Body);
        var originalSize = buf.length;
        plog("图" + (i + 1) + " 下载完成: " + originalSize + "B (" + (Date.now() - dlT0) + "ms)");

        onEvent("stage", { stage: "compressing", index: i + 1, total: files.length });
        var comp = await compressImage(buf);
        plog("图" + (i + 1) + " 压缩完成: " + originalSize + "B → " + comp.compressedSize + "B (sharp=" + comp.sharpUsed + ")");
        var compressedKey = fi.cosKey.replace(/^temp\//, "images/").replace(/\.[^.]+$/, ".jpg");

        var putT0 = Date.now();
        await new Promise(function (resolve, reject) {
          cos.putObject({
            Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
            Key: compressedKey, Body: comp.buffer, ACL: "public-read", ContentType: "image/jpeg",
          }, function (err) { if (err) reject(err); else resolve(); });
        });
        plog("图" + (i + 1) + " 上传压缩版完成 (" + (Date.now() - putT0) + "ms)");

        // 删除临时原图
        cos.deleteObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: fi.cosKey }, function () {});

        // 记录到副本（合并 checkpoint，最后统一写一次）
        updatedFiles[i] = Object.assign({}, fi, {
          compressedKey: compressedKey, originalSize: originalSize, compressedSize: comp.compressedSize,
        });

        onEvent("compressed", {
          index: i + 1, total: files.length,
          originalSize: originalSize, compressedSize: comp.compressedSize, sharp: comp.sharpUsed,
        });

        return {
          compressed: comp.buffer, compressedKey: compressedKey,
          url: "https://" + bucketDomain + "/" + compressedKey,
          spaceNames: fi.spaceNames || [], idx: i,
          originalSize: originalSize, compressedSize: comp.compressedSize,
          sharpUsed: comp.sharpUsed, error: null,
        };
      } catch (err) {
        plog("图" + (i + 1) + " 处理失败: " + err.message);
        onEvent("stage", { stage: "compress_failed", index: i + 1, total: files.length, error: err.message });
        return { compressed: null, compressedKey: "", url: "", spaceNames: fi.spaceNames || [], idx: i, error: err.message };
      }
    })();
  }));

  // 合并 checkpoint：一次性写回所有 compressedKey（替代之前的逐张写，省 N 次 Meilisearch 往返）
  try {
    await updateJob(jobId, { files: updatedFiles });
    job.files = updatedFiles;
    plog("Phase1 完成：checkpoint 已写回（" + updatedFiles.length + " 文件）");
  } catch (err) {
    plog("Phase1 checkpoint 写回失败（不阻塞）: " + err.message);
  }
  heartbeat();

  // ============ Phase 2+3: 按 BATCH_SIZE 张分批调用 AI，每批返回后立即写结果 ============
  var BATCH_SIZE = 5;
  // 时间预算：maxDuration(290s) - 单批AI(180s) - 写入/收尾(30s) = 80s。
  // 仅当"已耗时 < 预算"才启动【新的】批（bi>0）；首批必跑。保证每批都能在 maxDuration 内完成，
  // 绝不出现"开了第2批却中途被杀"。超预算 → stopped，交给后台下一轮续跑。
  var TIME_BUDGET_MS = 80000;

  // 确定性分批（按全局顺序），续跑时划分一致
  var batchGroups = [];
  for (var bg = 0; bg < imageList.length; bg += BATCH_SIZE) {
    batchGroups.push(imageList.slice(bg, bg + BATCH_SIZE));
  }
  var totalBatches = batchGroups.length;

  // batches checkpoint（断点续跑用）
  var batches = (Array.isArray(job.batches) && job.batches.length === totalBatches)
    ? job.batches.slice()
    : batchGroups.map(function (_, bi) { return { index: bi, status: "pending", startedAt: 0, completedAt: 0, error: "" }; });

  // progressLog（内存维护，随 checkpoint 一起写回）
  var progressLog = Array.isArray(job.progressLog) ? job.progressLog.slice() : [];
  function logProgress(event, msg) {
    progressLog.push({ ts: Date.now(), event: event, msg: msg });
    if (progressLog.length > 30) progressLog = progressLog.slice(-30);
  }
  async function checkpointBatches() {
    // 每次都带上 files，防止任何局部写入意外丢失 files 字段（后台续跑依赖它）
    try { await updateJob(jobId, { batches: batches, results: results, progressLog: progressLog, files: job.files || [] }); }
    catch (err) { plog("checkpoint 写回失败（不阻塞）: " + err.message); }
  }

  var promptContent = await readPrompt(cos, aiSettings);
  if (!promptContent) promptContent = getDefaultPrompt();
  var baseUrl = aiSettings.aiUrl.replace(/\/+$/, "");
  var chatUrl = baseUrl.indexOf("/chat/completions") === -1 ? baseUrl + "/chat/completions" : baseUrl;
  var openaiHeaders = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + aiSettings.aiKey,
    "x-dashscope-api-key": aiSettings.aiKey,
  };

  plog("Phase2+3 开始：共 " + totalBatches + " 批（每批≤" + BATCH_SIZE + "）");
  var stopped = false; // 是否因时间预算中止（仍有 pending 批，需后台续跑）

  for (var bi = 0; bi < batchGroups.length; bi++) {
    heartbeat();
    // 时间预算守卫：仅对【非首批】生效。剩余时间不够再跑一批(FULL_TIMEOUT+收尾) → 安全停，交给后台续跑。
    // 首批必跑（保证每次调用至少推进一批）；这样绝不会"开了批却中途被杀"。
    if (bi > 0 && (Date.now() - pipeStart) > TIME_BUDGET_MS) {
      plog("时间预算用尽，安全中止，剩余 " + (totalBatches - bi) + " 批待后台续跑");
      logProgress("time_budget_stop", "剩余" + (totalBatches - bi) + "批等待后台续跑");
      await checkpointBatches();
      stopped = true;
      break;
    }

    // 已完成的批 → 跳过（断点续跑）
    if (batches[bi] && batches[bi].status === "done") {
      plog("批 " + (bi + 1) + "/" + totalBatches + " 跳过（已完成）");
      continue;
    }

    var batchImages = batchGroups[bi];
    var globalBase = bi * BATCH_SIZE; // 该批首图全局下标
    var validBatch = batchImages.filter(function (x) { return !x.error; });

    // 该批全是错误图 → 直接标记 done（无需 AI）
    if (validBatch.length === 0) {
      batchImages.forEach(function (img, k) {
        results[globalBase + k] = { imageIndex: globalBase + k, status: "failed", error: (img && img.error) || "无有效图片", spaceNames: img.spaceNames };
      });
      batches[bi] = { index: bi, status: "done", startedAt: 0, completedAt: Date.now(), error: "" };
      await checkpointBatches();
      plog("批 " + (bi + 1) + "/" + totalBatches + " 无有效图，直接完成");
      continue;
    }

    // 构建本批 prompt（本地图索引 1..K，仅该批有效图）
    var promptLabels = validBatch.map(function (img, k) {
      var label = Array.isArray(img.spaceNames) && img.spaceNames.length > 0 ? img.spaceNames.join("、") : "未命名空间";
      return "图" + (k + 1) + "：" + label;
    });
    var fullPrompt = "本次分析共 " + validBatch.length + " 张图片：\n" + promptLabels.join("\n") + "\n\n" + promptContent;

    var messages = [{ role: "user", content: [{ type: "text", text: fullPrompt }] }];
    var payloadBytes = 0;
    validBatch.forEach(function (img) {
      if (img.compressed) {
        var b64 = img.compressed.toString("base64");
        payloadBytes += b64.length;
        messages[0].content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } });
      }
    });
    var openaiBody = { model: aiSettings.aiModel, stream: true, max_tokens: 8192, messages: messages };

    onEvent("batch_start", { batch: bi + 1, totalBatches: totalBatches, imageCount: validBatch.length, model: aiSettings.aiModel });
    onEvent("ai_submit", { totalImages: validBatch.length, payloadBytes: payloadBytes, model: aiSettings.aiModel, batch: bi + 1 });
    heartbeat();
    var aiT0 = Date.now();
    plog("批 " + (bi + 1) + "/" + totalBatches + " 提交 AI: " + validBatch.length + " 张，payload " + (payloadBytes / 1024 / 1024).toFixed(2) + "MB");

    batches[bi] = { index: bi, status: "processing", startedAt: Date.now(), completedAt: 0, error: "" };
    await updateJob(jobId, { batches: batches });

    var streamResult = await streamAiResponse(chatUrl, openaiBody, openaiHeaders, {
      onFirstFrame: function (ms) { plog("批 " + (bi + 1) + " 首帧: " + ms + "ms"); onEvent("first_frame", { elapsedMs: ms, batch: bi + 1 }); },
      onChunk: function (delta) { onEvent("content", { chunk: delta, batch: bi + 1 }); heartbeat(); },
      onTailWait: function (elapsedSec, sinceFirstSec) { onEvent("tail_wait", { elapsedSec: elapsedSec, sinceFirstSec: sinceFirstSec }); },
    });
    plog("批 " + (bi + 1) + " AI 返回: " + (streamResult && streamResult.content ? "成功 " + streamResult.content.length + "字符" : "失败 " + (streamResult && streamResult.error)) + " (" + (Date.now() - aiT0) + "ms)");

    // 失败处理：标记该批 failed，该批结果置失败，继续下一批（不整体中止）
    if (!streamResult || !streamResult.content) {
      var aiErr = (streamResult && streamResult.error) || "AI 分析未返回有效内容";
      plog("批 " + (bi + 1) + " 失败: " + aiErr);
      batches[bi] = { index: bi, status: "failed", startedAt: batches[bi].startedAt, completedAt: Date.now(), error: aiErr };
      batchImages.forEach(function (img, k) {
        results[globalBase + k] = { imageIndex: globalBase + k, status: "failed", error: (img && img.error) || aiErr, spaceNames: img.spaceNames };
      });
      logProgress("batch_failed", "批" + (bi + 1) + "/" + totalBatches + "失败: " + aiErr);
      await checkpointBatches();
      onEvent("batch_done", { batch: bi + 1, totalBatches: totalBatches, status: "failed", error: aiErr });
      continue;
    }

    var analysisRaw = streamResult.content;
    var analysis = tryParseJson(analysisRaw);
    if (!analysis) {
      plog("批 " + (bi + 1) + " AI 返回非 JSON");
      batches[bi] = { index: bi, status: "failed", startedAt: batches[bi].startedAt, completedAt: Date.now(), error: "AI 返回非 JSON" };
      batchImages.forEach(function (img, k) {
        results[globalBase + k] = { imageIndex: globalBase + k, status: "failed", error: (img && img.error) || "AI 返回非 JSON", spaceNames: img.spaceNames };
      });
      logProgress("batch_failed", "批" + (bi + 1) + "/" + totalBatches + " AI 返回非 JSON");
      await checkpointBatches();
      onEvent("batch_done", { batch: bi + 1, totalBatches: totalBatches, status: "failed", error: "AI 返回非 JSON" });
      continue;
    }

    // 该批 AI 成功 → 立即为每张图写结果（用批内本地索引过滤 (图K)）
    for (var k = 0; k < batchImages.length; k++) {
      heartbeat();
      var img2 = batchImages[k];
      var globalIdx = globalBase + k;
      if (img2.error) {
        results[globalIdx] = { imageIndex: globalIdx, status: "failed", error: img2.error, spaceNames: img2.spaceNames };
        onEvent("image_done", { index: globalIdx + 1, total: imageList.length, status: "failed", error: img2.error });
        continue;
      }
      // 找该图在 validBatch 中的本地位置（1-based）
      var localIndex = 1;
      for (var vk = 0; vk < validBatch.length; vk++) {
        if (validBatch[vk] === img2) { localIndex = vk + 1; break; }
      }
      var searchFields = extractSearchFields(analysis, localIndex, img2.spaceNames);
      var docId = stableDocId(jobId, globalIdx);
      var ts = docId;

      var mdContent = buildMarkdown(analysis, img2.url, ts, img2.spaceNames, localIndex);
      var basename = path.basename(img2.compressedKey).replace(/\.[^.]+$/, "");
      var mdKey = "summaries/" + ts + "-" + basename + ".md";

      try {
        await new Promise(function (resolve, reject) {
          cos.putObject({
            Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
            Key: mdKey, Body: Buffer.from(mdContent, "utf-8"),
            ContentType: "text/markdown; charset=utf-8", ACL: "public-read",
          }, function (err) { if (err) reject(err); else resolve(); });
        });
      } catch (err) {
        plog("图" + (globalIdx + 1) + " MD 写入失败: " + err.message);
      }
      var mdUrl = "https://" + bucketDomain + "/" + mdKey;

      // 原始分析 JSON
      cos.putObject({
        Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION,
        Key: mdKey.replace(/\.md$/, ".json"), Body: Buffer.from(analysisRaw, "utf-8"),
        ContentType: "application/json; charset=utf-8", ACL: "public-read",
      }, function () {});

      // 索引到 Meilisearch（幂等 upsert，id 稳定）
      var doc = {
        id: docId, url: img2.url, mdUrl: mdUrl,
        title: searchFields.title, summary: searchFields.summary, tags: searchFields.tags,
        spaceNames: img2.spaceNames || [],
        spaceName: (img2.spaceNames || []).join("、"),
        projectName: job.projectName || "",
        createdAt: ts, batchId: jobId || "",
      };
      try {
        await axios.post(
          process.env.MEILISEARCH_HOST + "/indexes/design_images/documents", [doc],
          { headers: { Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY, "Content-Type": "application/json" } }
        );
      } catch (err) {
        console.warn("Meilisearch 索引失败:", err.message);
      }

      results[globalIdx] = {
        imageIndex: globalIdx, status: "success",
        title: searchFields.title, summary: searchFields.summary,
        tags: searchFields.tags, mdUrl: mdUrl, url: img2.url, spaceNames: img2.spaceNames,
      };
      plog("图" + (globalIdx + 1) + " 结果写入完成: " + searchFields.title);
      onEvent("image_done", { index: globalIdx + 1, total: imageList.length, status: "success", title: searchFields.title });
    }

    batches[bi] = { index: bi, status: "done", startedAt: batches[bi].startedAt, completedAt: Date.now(), error: "" };
    logProgress("batch_done", "批" + (bi + 1) + "/" + totalBatches + "完成（" + validBatch.length + "张）");
    await checkpointBatches();
    onEvent("batch_done", { batch: bi + 1, totalBatches: totalBatches, status: "success" });
    plog("批 " + (bi + 1) + "/" + totalBatches + " 完成");
  }

  // 汇总结果
  var anyBatchFailed = batches.some(function (b) { return b && b.status === "failed"; });
  var finalError = stopped
    ? "时间预算中止，等待后台续跑"
    : (anyBatchFailed ? "部分批次失败" : null);
  plog("流水线结束: " + (finalError || "全部成功") + " (总耗时 " + (Date.now() - pipeStart) + "ms)");
  clearInterval(keepalive);
  return { success: !finalError, stopped: stopped, results: results, batches: batches, error: finalError };
}

// ============================================================
// 内嵌默认提示词（与提示词.txt 一致，作为最终回退）
// ============================================================
export function getDefaultPrompt() {
  return [
    "---",
    "**指令**：你是资深软装设计专家，请严格按照下方指定的JSON结构，对所有上传图片进行深度软装分析。",
    "**要求**：",
    "1.  我上传的图片会按\"图X：空间名称\"标注（如：图1：客厅、图2：卧室）。",
    "    spaceSoftDecorationAnalysis 中的每一条记录必须通过 spaceName 中的\"（图X）\"明确归属到对应图片，不同图片的分析内容不得混杂。",
    "2.  不得新增、删除、修改任何顶级字段，所有内容必须填充到对应字段内",
    "3.  输出纯JSON代码，不包含任何额外说明文字、注释或Markdown格式",
    "4.  分析内容专业精准，覆盖风格定位、情感格调、硬装衔接、色彩轻重、材质呼应、单品搭配逻辑及通用思路",
    "5.  coreApplication 只返回色彩体系关键词（如'黑白灰+深木色'），不写完整句子",
    "6.  materials 数组位于 spaceSoftDecorationAnalysis 内部，只列出属于当前空间/图片的材质名称，不包含 usage 字段",
    "",
    JSON.stringify({
      styleDefinition: { coreStyle: "", designTechniques: "", emotionalTone: "" },
      overallEmotionalStyle: { coreTemperament: "", detailedInterpretation: [] },
      colorDesignSummary: { coreApplication: "", coreLogic: "", coreTechniques: [], balanceLogic: [] },
      spaceSoftDecorationAnalysis: [],
      generalMatchingIdeas: [],
    }, null, 2),
  ].join("\n");
}
