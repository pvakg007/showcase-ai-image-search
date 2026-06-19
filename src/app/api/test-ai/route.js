export const dynamic = "force-dynamic";

import axios from "axios";

/**
 * AI API 端点批量测试
 * POST /api/test-ai
 * Body: { apiKey: string }
 *
 * 遍历 4 个 URL × 多种格式 × 多种认证方式
 * 返回每个组合的耗时和结果
 */

// 用户提供的 4 个 URL
var TEST_URLS = [
  "https://llm-28jx4qmqak31ymc9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "https://ws-zwf60r4eps2lu9v2.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
];

var MESSAGE_CONTENT = "你是一个设计分析助手。请回复一句简短的话描述你看到的房间风格，仅回复一句话即可。不需要JSON。";

/**
 * 构建测试用例列表
 */
function buildTests(apiKey) {
  var tests = [];

  for (var ui = 0; ui < TEST_URLS.length; ui++) {
    var base = TEST_URLS[ui].replace(/\/+$/, "");

    // === 格式 1: OpenAI Chat API (Authorization Bearer) ===
    tests.push({
      name: "URL" + (ui + 1) + " OpenAI Bearer",
      url: base + "/chat/completions",
      data: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: MESSAGE_CONTENT }],
        max_tokens: 100,
      },
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
    });

    // === 格式 2: OpenAI Chat API (x-dashscope-api-key) ===
    tests.push({
      name: "URL" + (ui + 1) + " OpenAI x-dashscope-key",
      url: base + "/chat/completions",
      data: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: MESSAGE_CONTENT }],
        max_tokens: 100,
      },
      headers: {
        "Content-Type": "application/json",
        "x-dashscope-api-key": apiKey,
      },
    });

    // === 格式 3: OpenAI Chat API (双重认证) ===
    tests.push({
      name: "URL" + (ui + 1) + " OpenAI 双重认证",
      url: base + "/chat/completions",
      data: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: MESSAGE_CONTENT }],
        max_tokens: 100,
      },
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "x-dashscope-api-key": apiKey,
      },
    });

    // === 格式 4: 裸 URL（不加 /chat/completions） ===
    tests.push({
      name: "URL" + (ui + 1) + " 裸URL POST",
      url: base,
      data: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: MESSAGE_CONTENT }],
        max_tokens: 100,
      },
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "x-dashscope-api-key": apiKey,
      },
    });

    // === 格式 5: Anthropic Messages API（仅当 URL 不是 Anthropic 风格时也试一次） ===
    // 只对 dashscope.aliyuncs.com 测试 Anthropic 格式
    if (base.indexOf("dashscope") !== -1) {
      var anthropicUrl = base.replace(/\/v1\/?$/, "") + "/v1/messages";
      tests.push({
        name: "URL" + (ui + 1) + " Anthropic格式",
        url: anthropicUrl,
        data: {
          model: "qwen3.6-plus",
          max_tokens: 100,
          messages: [{ role: "user", content: MESSAGE_CONTENT }],
        },
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
    }

    // === 格式 6: Dashscope 原生 text-generation API ===
    // 仅对 dashscope.aliyuncs.com 测试
    if (base.indexOf("dashscope") !== -1) {
      tests.push({
        name: "URL" + (ui + 1) + " Dashscope原生",
        url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        data: {
          model: "qwen3.6-plus",
          input: {
            messages: [{ role: "user", content: MESSAGE_CONTENT }],
          },
          parameters: {
            result_format: "message",
          },
        },
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
      });
    }
  }

  return tests;
}

export async function POST(req) {
  try {
    var body = await req.json();
    var apiKey = body.apiKey || "";

    if (!apiKey) {
      return Response.json({ success: false, error: "请提供 API Key" });
    }

    var tests = buildTests(apiKey);
    var results = [];

    for (var i = 0; i < tests.length; i++) {
      var test = tests[i];
      var startTime = Date.now();
      var result = {
        name: test.name,
        url: test.url,
        status: "pending",
        httpStatus: 0,
        duration: 0,
        responsePreview: "",
        error: "",
      };

      try {
        var resp = await axios.post(test.url, test.data, {
          headers: test.headers,
          timeout: 30000,
          validateStatus: function () { return true; }, // 不抛异常，所有状态码都处理
        });

        result.httpStatus = resp.status;
        result.duration = Date.now() - startTime;

        var rd = resp.data;

        // 检查 OpenAI 格式成功响应
        if (rd && rd.choices && rd.choices[0] && rd.choices[0].message && rd.choices[0].message.content) {
          result.status = "success";
          result.responsePreview = rd.choices[0].message.content.substring(0, 200);
        }
        // 检查 Anthropic 格式成功响应
        else if (rd && rd.content && rd.content[0] && rd.content[0].text) {
          result.status = "success";
          result.responsePreview = rd.content[0].text.substring(0, 200);
        }
        // 检查 Dashscope 原生格式
        else if (rd && rd.output && rd.output.text) {
          result.status = "success";
          result.responsePreview = rd.output.text.substring(0, 200);
        }
        else if (rd && rd.output && rd.output.choices && rd.output.choices[0] && rd.output.choices[0].message) {
          result.status = "success";
          result.responsePreview = rd.output.choices[0].message.content.substring(0, 200);
        }
        // 检查平铺的 output 格式
        else if (rd && rd.output && typeof rd.output === "string") {
          result.status = "success";
          result.responsePreview = rd.output.substring(0, 200);
        }
        // 错误响应
        else {
          result.status = "error_response";
          result.responsePreview = JSON.stringify(rd).substring(0, 300);
        }
      } catch (err) {
        result.duration = Date.now() - startTime;
        result.status = "error";
        result.httpStatus = err.response?.status || 0;
        result.responsePreview = err.message || "未知错误";
        if (err.response && err.response.data) {
          result.responsePreview += " | " + JSON.stringify(err.response.data).substring(0, 200);
        }
      }

      results.push(result);
    }

    // 统计
    var successCount = results.filter(function (r) { return r.status === "success"; }).length;
    var totalCount = results.length;

    return Response.json({
      success: true,
      summary: "测试完成: " + successCount + "/" + totalCount + " 成功",
      successCount: successCount,
      totalCount: totalCount,
      results: results,
    });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
