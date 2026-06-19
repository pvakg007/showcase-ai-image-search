import COS from "cos-nodejs-sdk-v5";
import axios from "axios";
import fs from "fs";
import path from "path";

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

/**
 * 内嵌默认提示词（提示词.txt 不存在时的备用方案）
 */
const EMBEDDED_PROMPT = [
  "---",
  "**指令**：你是资深软装设计专家，请严格按照下方指定的JSON结构，对我上传的所有图片进行深度软装分析。",
  "**要求**：",
  "1.  我上传图片时会标注每张对应的空间名称（格式：图X：空间名称），请你严格按此对应生成spaceSoftDecorationAnalysis数组",
  "2.  不得新增、删除、修改任何顶级字段，所有内容必须填充到对应字段内",
  "3.  输出纯JSON代码，不包含任何额外说明文字、注释或Markdown格式",
  "4.  分析内容专业精准，覆盖风格定位、情感格调、硬装衔接、色彩轻重、材质呼应、单品搭配逻辑及通用思路",
  "5.  语言精简凝练，保留核心分析要点，避免冗余表述",
  "",
  JSON.stringify(
    {
      styleDefinition: {
        coreStyle: "1-2个核心风格定位词（如：现代东方禅意、北欧原木风）",
        designTechniques: "1-3个核心设计手法（如：留白、借景、材质碰撞）",
        emotionalTone: "1-4个核心情感基调词（如：宁静、雅致、温暖、治愈）",
      },
      overallEmotionalStyle: {
        coreTemperament: "核心气质总括（如：静、雅、空、缓）",
        detailedInterpretation: [
          "分点解释每个核心气质的营造逻辑，结合色调、材质、光线、空间结构等元素",
        ],
      },
      colorDesignSummary: {
        coreApplication: "本案例是【具体风格】下【对应色彩体系】的典型应用",
        coreLogic: "整体遵循【该风格核心色彩逻辑】",
        coreTechniques: [
          "第1点核心色彩手法（含具体执行方式）",
          "第2点核心色彩手法（含具体执行方式）",
        ],
        balanceLogic: [
          "第1点色彩平衡逻辑（含具体实现方式）",
          "第2点色彩平衡逻辑（含具体实现方式）",
        ],
      },
      spaceSoftDecorationAnalysis: [
        {
          spaceName: "对应你标注的空间名称（如：独立书房（图1））",
          functionalAdaptation: "一句话说明色彩如何适配该空间功能",
          hardwareBase:
            "该空间硬装基础描述，包含材质、色调、线条、结构、照明方式等核心特点",
          softDecorationItems: [
            {
              itemName: "软装单品全称",
              matchingLogic:
                "从硬装配合、色彩轻重、风格情感、材质呼应四个维度阐述搭配道理",
            },
          ],
        },
      ],
      generalMatchingIdeas: [
        {
          principleName: "复用搭配思路与原则",
          detailedRules: [
            "分点说明该原则的具体执行方法和注意事项",
          ],
        },
      ],
    },
    null,
    2
  ),
].join("\n");

/**
 * 尝试从大模型返回文本中解析 JSON（兼容多种返回格式）
 */
function tryParseJson(text) {
  if (!text) return null;
  // 直接解析
  try {
    return JSON.parse(text);
  } catch (_) {}
  // 尝试提取 ```json ... ``` 代码块
  var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (_) {}
  }
  // 尝试提取第一个 { ... }
  var braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (_) {}
  }
  return null;
}

/**
 * 从分析结果中提取简化的 title/summary/tags 用于 Meilisearch 索引
 */
function extractSearchFields(analysis) {
  var title = "未命名图片";
  var summary = "暂无总结";
  var tags = ["设计图"];

  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    var cds = analysis?.colorDesignSummary;

    if (sd?.coreStyle) {
      title = sd.coreStyle + " 设计分析";
    }

    var parts = [];
    if (oes?.coreTemperament) {
      parts.push("核心气质：" + oes.coreTemperament);
    }
    if (Array.isArray(oes?.detailedInterpretation)) {
      parts.push.apply(parts, oes.detailedInterpretation);
    }
    if (cds?.coreApplication) {
      parts.push(cds.coreApplication);
    }
    if (cds?.coreLogic) {
      parts.push(cds.coreLogic);
    }
    if (parts.length > 0) {
      summary = parts.join("；");
    }

    var tagSet = new Set();
    tagSet.add("设计图");

    if (sd?.coreStyle) {
      sd.coreStyle.split(/[、,，/\/\s]+/).forEach(function (t) {
        var cleaned = t.trim();
        if (cleaned) tagSet.add(cleaned);
      });
    }
    if (sd?.designTechniques) {
      sd.designTechniques.split(/[、,，/\/\s]+/).forEach(function (t) {
        var cleaned = t.trim();
        if (cleaned) tagSet.add(cleaned);
      });
    }
    if (sd?.emotionalTone) {
      sd.emotionalTone.split(/[、,，/\/\s]+/).forEach(function (t) {
        var cleaned = t.trim();
        if (cleaned) tagSet.add(cleaned);
      });
    }
    if (Array.isArray(analysis?.spaceSoftDecorationAnalysis)) {
      analysis.spaceSoftDecorationAnalysis.forEach(function (space) {
        if (space?.spaceName) tagSet.add(space.spaceName);
        if (Array.isArray(space?.softDecorationItems)) {
          space.softDecorationItems.forEach(function (item) {
            if (item?.itemName) tagSet.add(item.itemName);
          });
        }
      });
    }
    if (Array.isArray(analysis?.generalMatchingIdeas)) {
      analysis.generalMatchingIdeas.forEach(function (idea) {
        if (idea?.principleName) tagSet.add(idea.principleName);
      });
    }

    tags = Array.from(tagSet).slice(0, 15);
  } catch (err) {
    console.error("提取搜索字段出错:", err);
  }

  return { title: title, summary: summary, tags: tags };
}

/**
 * 构建丰富的 Markdown 总结文件内容
 */
function buildMarkdown(analysis, imageUrl, timestamp, spaceNames) {
  var lines = [];

  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    var cds = analysis?.colorDesignSummary;
    var spaces = analysis?.spaceSoftDecorationAnalysis;
    var ideas = analysis?.generalMatchingIdeas;

    var spaceLabel = Array.isArray(spaceNames) && spaceNames.length > 0
      ? spaceNames.join("、")
      : "";

    lines.push(
      "# " + (sd?.coreStyle || (spaceLabel || "设计分析"))
    );
    lines.push("");
    lines.push("---");
    lines.push("");

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
      if (sd.designTechniques)
        lines.push("- **设计手法**: " + sd.designTechniques);
      if (sd.emotionalTone)
        lines.push("- **情感基调**: " + sd.emotionalTone);
      lines.push("");
    }

    if (oes) {
      lines.push("## 整体情感格调");
      if (oes.coreTemperament)
        lines.push("- **核心气质**: " + oes.coreTemperament);
      if (Array.isArray(oes.detailedInterpretation)) {
        lines.push("");
        lines.push("### 详细解读");
        oes.detailedInterpretation.forEach(function (item, i) {
          lines.push(i + 1 + ". " + item);
        });
      }
      lines.push("");
    }

    if (cds) {
      lines.push("## 色彩设计总结");
      if (cds.coreApplication)
        lines.push("- **核心应用**: " + cds.coreApplication);
      if (cds.coreLogic) lines.push("- **核心逻辑**: " + cds.coreLogic);
      if (Array.isArray(cds.coreTechniques)) {
        lines.push("");
        lines.push("### 核心手法");
        cds.coreTechniques.forEach(function (item, i) {
          lines.push(i + 1 + ". " + item);
        });
      }
      if (Array.isArray(cds.balanceLogic)) {
        lines.push("");
        lines.push("### 平衡逻辑");
        cds.balanceLogic.forEach(function (item, i) {
          lines.push(i + 1 + ". " + item);
        });
      }
      lines.push("");
    }

    if (Array.isArray(spaces) && spaces.length > 0) {
      lines.push("## 空间软装分析");
      lines.push("");
      spaces.forEach(function (space, si) {
        lines.push(
          "### " + (si + 1) + ". " + (space.spaceName || "未命名空间")
        );
        if (space.functionalAdaptation)
          lines.push("- **功能适配**: " + space.functionalAdaptation);
        if (space.hardwareBase)
          lines.push("- **硬装基础**: " + space.hardwareBase);
        if (Array.isArray(space.softDecorationItems)) {
          lines.push("");
          lines.push("**软装单品：**");
          space.softDecorationItems.forEach(function (item) {
            lines.push(
              "- **" + item.itemName + "**: " + item.matchingLogic
            );
          });
        }
        lines.push("");
      });
    }

    if (Array.isArray(ideas) && ideas.length > 0) {
      lines.push("## 通用搭配思路");
      lines.push("");
      ideas.forEach(function (idea) {
        lines.push("### " + (idea.principleName || "搭配原则"));
        if (Array.isArray(idea.detailedRules)) {
          idea.detailedRules.forEach(function (rule) {
            lines.push("- " + rule);
          });
        }
        lines.push("");
      });
    }
  } catch (err) {
    console.error("构建 Markdown 出错:", err);
    lines.push("分析数据解析异常，请查看原始分析结果。");
  }

  return lines.join("\n");
}

/**
 * 处理单个文件的完整流程：上传COS → Spark API 分析 → 生成MD → 索引Meilisearch
 */
async function processFile(file, spaceNameArr, index, batchId) {
  var arrayBuffer = await file.arrayBuffer();
  var buffer = Buffer.from(arrayBuffer);
  var timestamp = Date.now() + index;
  var imageFilename = "images/" + timestamp + "-" + file.name;

  // 1. 上传图片到腾讯云 COS（公共读权限）
  var imageResult = await cos.putObject({
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: imageFilename,
    Body: buffer,
    ACL: "public-read",
  });
  var imageUrl = "https://" + imageResult.Location;

  // 2. 读取提示词文件
  var promptContent = "";
  try {
    var promptPath = path.join(process.cwd(), "提示词.txt");
    promptContent = fs.readFileSync(promptPath, "utf-8");
  } catch (err) {
    console.warn("提示词文件读取失败，使用内嵌默认提示词:", err.message);
    promptContent = EMBEDDED_PROMPT;
  }

  // 将空间名称嵌入提示词
  var spaceLabel = Array.isArray(spaceNameArr) && spaceNameArr.length > 0
    ? spaceNameArr.join("、")
    : "未命名空间";
  promptContent = "图 " + (index + 1) + "：" + spaceLabel + "\n\n" + promptContent;

  // 3. 调用 Spark API (Anthropic 兼容) 分析图片
  var analysis = null;
  var analysisRaw = "";

  try {
    var base64Image = buffer.toString("base64");
    var mimeType = file.type || "image/jpeg";

    // 尝试两个路径：/v1/messages（标准 Anthropic）→ 原始地址
    var apiBase = process.env.SPARK_API_URL || "https://maas-api.cn-huabei-1.xf-yun.com/anthropic";
    // Vercel Hobby 60s 限制，每个尝试 25s
    var SPARK_TIMEOUT = 25000;

    var sparkRes = null;
    var lastErr = null;

    // 第1轮：尝试 /v1/messages
    var urlsToTry = [
      apiBase.replace(/\/+$/, "") + "/v1/messages",
      apiBase.replace(/\/+$/, ""),
    ];

    for (var u = 0; u < urlsToTry.length; u++) {
      try {
        console.log("Spark API 尝试 #" + (u + 1) + ":", urlsToTry[u]);
        sparkRes = await axios.post(
          urlsToTry[u],
          {
            model: process.env.SPARK_MODEL || "xopqwen36v35b",
            max_tokens: 4096,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: promptContent },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mimeType,
                      data: base64Image,
                    },
                  },
                ],
              },
            ],
          },
          {
            headers: {
              "x-api-key": process.env.SPARK_API_KEY || "",
              "Content-Type": "application/json",
            },
            timeout: SPARK_TIMEOUT,
          }
        );
        // 请求成功则跳出循环
        if (sparkRes && sparkRes.status < 500) break;
      } catch (err) {
        lastErr = err;
        console.warn("Spark API 尝试 #" + (u + 1) + " 失败:", err.message);
        // 非网络错误（如 4xx）直接跳出，不继续尝试
        if (err.response && err.response.status < 500) {
          console.error("服务器拒绝了请求 (HTTP " + err.response.status + "):",
            JSON.stringify(err.response.data).slice(0, 300));
          break;
        }
      }
    }

    if (sparkRes && sparkRes.data && sparkRes.data.content && sparkRes.data.content[0]) {
      analysisRaw = sparkRes.data.content[0].text || "";
      analysis = tryParseJson(analysisRaw);
      console.log(
        "Spark 分析结果:",
        analysis ? (analysis.styleDefinition?.coreStyle || "JSON OK") : "非JSON，前200字: " + (analysisRaw?.slice(0, 200) || "空")
      );
    } else {
      if (lastErr) {
        console.error("Spark API 最终失败（第" + (index + 1) + "张图）:", lastErr.message);
        if (lastErr.response) {
          console.error(
            "状态:", lastErr.response.status,
            "数据:", JSON.stringify(lastErr.response.data).slice(0, 500)
          );
        }
      } else {
        console.warn("Spark API 返回空响应（第" + (index + 1) + "张图）");
      }
    }
  } catch (err) {
    console.error("Spark API 调用异常（第" + (index + 1) + "张图）:", err.message);
  }

  // 4. 提取用于搜索的字段
  var searchFields = extractSearchFields(analysis);

  // 兜底：分析失败但有空间名称
  if (!analysis && spaceLabel && spaceLabel !== "未命名空间") {
    searchFields.title = spaceLabel + " 设计图片";
    searchFields.summary = "空间名称：" + spaceLabel + "（AI 分析暂不可用，请稍后重试）";
    spaceNameArr.forEach(function (name) {
      if (searchFields.tags.indexOf(name) === -1) {
        searchFields.tags.push(name);
      }
    });
  } else if (!analysis) {
    searchFields.title = "设计图片 " + (index + 1);
    searchFields.summary = "等待 AI 分析完成";
  }

  var title = searchFields.title;
  var summary = searchFields.summary;
  var tags = searchFields.tags;

  // 5. 生成 MD 总结文件
  var mdContent = buildMarkdown(analysis, imageUrl, timestamp, spaceNameArr);
  var mdFilename =
    "summaries/" +
    timestamp +
    "-" +
    file.name.replace(/\.[^/.]+$/, "") +
    ".md";

  // 6. 上传 .md 文件到腾讯云 COS（公共读权限）
  var mdResult = await cos.putObject({
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: mdFilename,
    Body: Buffer.from(mdContent, "utf-8"),
    ContentType: "text/markdown; charset=utf-8",
    ACL: "public-read",
  });
  var mdUrl = "https://" + mdResult.Location;

  // 7. 保存原始分析文本到 COS
  if (analysisRaw) {
    try {
      var rawFilename =
        "summaries/" +
        timestamp +
        "-" +
        file.name.replace(/\.[^/.]+$/, "") +
        ".json";
      var rawResult = await cos.putObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: rawFilename,
        Body: Buffer.from(analysisRaw, "utf-8"),
        ContentType: "application/json; charset=utf-8",
        ACL: "public-read",
      });
    } catch (err) {
      console.warn("原始 JSON 保存失败:", err.message);
    }
  }

  // 8. 存入 Meilisearch
  var document = {
    id: timestamp,
    url: imageUrl,
    mdUrl: mdUrl,
    title: title,
    summary: summary,
    tags: tags,
    spaceNames: spaceNameArr || [],
    spaceName: (Array.isArray(spaceNameArr) ? spaceNameArr.join("、") : spaceNameArr || ""),
    createdAt: timestamp,
    batchId: batchId || "",
  };

  try {
    await axios.post(
      process.env.MEILISEARCH_HOST + "/indexes/design_images/documents",
      [document],
      {
        headers: {
          Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Meilisearch 索引成功：" + title);
  } catch (err) {
    console.error("Meilisearch 索引失败:", err.message);
  }

  return document;
}

export async function POST(req) {
  try {
    // 生成批次 ID，用于关联同一次上传的多张图片
    var batchId = Date.now().toString();

    // 配置 Meilisearch 索引（幂等操作，只执行一次）
    try {
      axios.patch(
        process.env.MEILISEARCH_HOST + "/indexes/design_images/settings",
        { filterableAttributes: ["batchId"] },
        {
          headers: {
            Authorization: "Bearer " + process.env.MEILISEARCH_API_KEY,
            "Content-Type": "application/json",
          },
        }
      ).catch(function () {}); // 静默失败，不影响上传流程
    } catch (_) {}

    var formData = await req.formData();

    // 获取文件列表（兼容新老字段名）
    var files = formData.getAll("files");
    if (!files || files.length === 0) {
      var singleFile = formData.get("file");
      if (singleFile) files = [singleFile];
    }

    if (!files || files.length === 0) {
      return Response.json(
        { success: false, error: "未选择文件" },
        { status: 400 }
      );
    }

    // 获取空间名称列表
    var rawSpaceNames = formData.getAll("spaceNames") || [];
    if (rawSpaceNames.length === 0 && formData.get("spaceName")) {
      rawSpaceNames = [formData.get("spaceName")];
    }

    var results = [];

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file || typeof file === "string") continue;

      // 解析 spaceNames（可能是 JSON 数组字符串或普通字符串）
      var raw = rawSpaceNames[i] || "";
      var parsedNames = [];
      try {
        parsedNames = JSON.parse(raw);
        if (!Array.isArray(parsedNames)) parsedNames = [raw];
      } catch (_) {
        parsedNames = raw ? [raw] : [];
      }
      parsedNames = parsedNames.filter(Boolean);

      console.log(
        "处理第" +
          (i + 1) +
          "/" +
          files.length +
          "张图片:",
        file.name,
        "空间:" + (parsedNames.length > 0 ? parsedNames.join("、") : "未指定")
      );

      var doc = await processFile(file, parsedNames, i, batchId);
      results.push(doc);
    }

    return Response.json({
      success: true,
      message: "上传成功！共处理 " + results.length + " 张图片",
      count: results.length,
      data: results,
    });
  } catch (error) {
    console.error("上传错误:", error);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
