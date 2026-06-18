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
 * 从 GLM 分析结果中提取简化的 title/summary/tags 用于 Meilisearch 索引
 */
function extractSearchFields(analysis) {
  let title = "未命名图片";
  let summary = "暂无总结";
  let tags = ["设计图"];

  try {
    const sd = analysis?.styleDefinition;
    const oes = analysis?.overallEmotionalStyle;
    const cds = analysis?.colorDesignSummary;

    if (sd?.coreStyle) {
      title = sd.coreStyle + " 设计分析";
    }

    const parts = [];
    if (oes?.coreTemperament) {
      parts.push("核心气质：" + oes.coreTemperament);
    }
    if (Array.isArray(oes?.detailedInterpretation)) {
      parts.push(...oes.detailedInterpretation);
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

    const tagSet = new Set();
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

  return { title, summary, tags };
}

/**
 * 构建丰富的 Markdown 总结文件内容
 */
function buildMarkdown(analysis, imageUrl, timestamp) {
  var lines = [];

  try {
    var sd = analysis?.styleDefinition;
    var oes = analysis?.overallEmotionalStyle;
    var cds = analysis?.colorDesignSummary;
    var spaces = analysis?.spaceSoftDecorationAnalysis;
    var ideas = analysis?.generalMatchingIdeas;

    lines.push("# " + (sd?.coreStyle || "设计分析"));
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 基本信息");
    lines.push("- **上传时间**: " + new Date(timestamp).toLocaleString());
    lines.push("- **图片链接**: [查看原图](" + imageUrl + ")");
    lines.push("");

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
          lines.push((i + 1) + ". " + item);
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
          lines.push((i + 1) + ". " + item);
        });
      }
      if (Array.isArray(cds.balanceLogic)) {
        lines.push("");
        lines.push("### 平衡逻辑");
        cds.balanceLogic.forEach(function (item, i) {
          lines.push((i + 1) + ". " + item);
        });
      }
      lines.push("");
    }

    if (Array.isArray(spaces) && spaces.length > 0) {
      lines.push("## 空间软装分析");
      lines.push("");
      spaces.forEach(function (space, si) {
        lines.push("### " + (si + 1) + ". " + (space.spaceName || "未命名空间"));
        if (space.functionalAdaptation)
          lines.push("- **功能适配**: " + space.functionalAdaptation);
        if (space.hardwareBase)
          lines.push("- **硬装基础**: " + space.hardwareBase);
        if (Array.isArray(space.softDecorationItems)) {
          lines.push("");
          lines.push("**软装单品：**");
          space.softDecorationItems.forEach(function (item) {
            lines.push("- **" + item.itemName + "**: " + item.matchingLogic);
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

export async function POST(req) {
  try {
    // 1. 获取上传的图片
    const formData = await req.formData();
    const file = formData.get("file");
    const spaceName = formData.get("spaceName") || "";

    if (!file) {
      return Response.json(
        { success: false, error: "未选择文件" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const timestamp = Date.now();
    const imageFilename = "images/" + timestamp + "-" + file.name;

    // 2. 上传图片到腾讯云 COS
    var imageResult = await cos.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: imageFilename,
      Body: buffer,
    });
    var imageUrl = "https://" + imageResult.Location;

    // 3. 读取提示词文件（文件不存在时使用内嵌默认提示词）
    var promptContent = "";
    try {
      var promptPath = path.join(process.cwd(), "提示词.txt");
      promptContent = fs.readFileSync(promptPath, "utf-8");
    } catch (err) {
      console.warn("提示词文件读取失败，使用内嵌默认提示词:", err.message);
      promptContent = EMBEDDED_PROMPT;
    }

    // 如果有空间名称，附加到提示词中
    if (spaceName) {
      promptContent = "图 1：" + spaceName + "\n\n" + promptContent;
    }

    // 4. 调用 GLM-4V 大模型分析图片
    var analysis = null;
    var analysisRaw = "";

    try {
      var glmRes = await axios.post(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        {
          model: "glm-4v",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptContent },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          response_format: { type: "json_object" },
        },
        {
          headers: {
            Authorization: "Bearer " + process.env.GLM_API_KEY,
          },
        }
      );

      analysisRaw = glmRes.data.choices[0].message.content;
      analysis = JSON.parse(analysisRaw);
    } catch (err) {
      console.error("GLM 分析错误:", err);
    }

    // 5. 提取用于搜索的简化字段
    var searchFields = extractSearchFields(analysis);
    var title = searchFields.title;
    var summary = searchFields.summary;
    var tags = searchFields.tags;

    // 6. 生成丰富的 MD 总结文件
    var mdContent = buildMarkdown(analysis, imageUrl, timestamp);
    var mdFilename =
      "summaries/" +
      timestamp +
      "-" +
      file.name.replace(/\.[^/.]+$/, "") +
      ".md";

    // 7. 上传 .md 文件到腾讯云 COS
    var mdResult = await cos.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: mdFilename,
      Body: Buffer.from(mdContent, "utf-8"),
      ContentType: "text/markdown; charset=utf-8",
    });
    var mdUrl = "https://" + mdResult.Location;

    // 8. 尝试将原始分析 JSON 也保存一份（用于调试或后续处理）
    var rawJsonUrl = "";
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
        });
        rawJsonUrl = "https://" + rawResult.Location;
      } catch (err) {
        console.warn("原始 JSON 保存失败:", err.message);
      }
    }

    // 9. 存入 Meilisearch 搜索引擎
    var document = {
      id: timestamp,
      url: imageUrl,
      mdUrl: mdUrl,
      title: title,
      summary: summary,
      tags: tags,
      createdAt: timestamp,
    };

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

    return Response.json({
      success: true,
      message: "上传并分析成功",
      data: document,
    });
  } catch (error) {
    console.error("上传错误:", error);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
