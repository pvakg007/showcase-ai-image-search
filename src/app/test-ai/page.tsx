"use client";
import { useState } from "react";

interface TestResult {
  name: string;
  url: string;
  status: string;
  httpStatus: number;
  duration: number;
  responsePreview: string;
  error: string;
}

export default function TestAIPage() {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [summary, setSummary] = useState("");

  async function runTests() {
    if (!apiKey.trim()) {
      alert("请输入 API Key");
      return;
    }
    setLoading(true);
    setResults([]);
    setSummary("测试中...");

    try {
      var res = await fetch("/api/test-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      var data = await res.json();
      if (data.success) {
        setResults(data.results || []);
        setSummary(data.summary || "");
      } else {
        alert("测试失败: " + (data.error || "未知错误"));
      }
    } catch (err) {
      alert("请求失败: " + String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">🔍 AI API 端点批量测试</h1>
        <p className="text-gray-400 text-sm mb-6">
          遍历 4 个 URL × 多种 API 格式，找出哪种组合能连通 Dashscope
        </p>

        {/* API Key 输入 */}
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <label className="block text-sm font-medium mb-2">
            Dashscope API Key &nbsp;
            <span className="text-gray-500">（sk-ws-... 开头的工作台应用 Key）</span>
          </label>
          <div className="flex gap-3">
            <input
              type="password"
              placeholder="输入你的 API Key"
              value={apiKey}
              onChange={function (e) { setApiKey(e.target.value); }}
              className="flex-1 px-4 py-2.5 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-100"
            />
            <button
              onClick={runTests}
              disabled={loading}
              className={"px-6 py-2.5 rounded-lg font-medium transition-colors " + (
                loading
                  ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-500"
              )}
            >
              {loading ? "测试中..." : "开始测试"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            API Key 仅用于本次测试，不会保存。每个测试超时 30 秒，请耐心等待。
          </p>
        </div>

        {/* 正在测试的 URL 列表 */}
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium mb-2">测试的 URL（4 个）</h2>
          <ul className="text-xs text-gray-400 space-y-1">
            <li>1. llm-28jx4qmqak31ymc9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1</li>
            <li>2. ws-zwf60r4eps2lu9v2.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1</li>
            <li>3. dashscope-us.aliyuncs.com/compatible-mode/v1</li>
            <li>4. dashscope.aliyuncs.com/compatible-mode/v1</li>
          </ul>
          <p className="text-xs text-gray-500 mt-2">
            每个 URL 测试 4-6 种格式：OpenAI Bearer / x-dashscope / 双重认证 / Anthropic / Dashscope原生
          </p>
        </div>

        {/* 汇总 */}
        {summary && (
          <div className={"text-lg font-bold mb-4 px-4 py-3 rounded-lg " + (
            results.filter(function (r) { return r.status === "success"; }).length > 0
              ? "bg-green-900/50 text-green-300"
              : "bg-red-900/50 text-red-300"
          )}>
            {summary}
          </div>
        )}

        {/* 结果列表 */}
        {results.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-bold mb-3">详细结果</h2>
            {results.map(function (r, i) {
              var statusColor = "bg-gray-700";
              var statusText = r.status;
              var badgeColor = "bg-gray-600";
              if (r.status === "success") { statusColor = "bg-green-900/30 border-green-700"; badgeColor = "bg-green-600"; }
              else if (r.status === "error_response") { statusColor = "bg-yellow-900/30 border-yellow-700"; badgeColor = "bg-yellow-600"; }
              else { statusColor = "bg-red-900/30 border-red-700"; badgeColor = "bg-red-600"; }

              return (
                <div key={i} className={"border rounded-lg p-4 " + statusColor}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={"px-2 py-0.5 rounded text-xs font-mono text-white " + badgeColor}>
                        {r.status === "success" ? "✅ 成功" : r.status === "error_response" ? "⚠️ 错误响应" : "❌ 失败"}
                      </span>
                      <span className="font-mono text-sm font-bold">{r.name}</span>
                    </div>
                    <div className="text-xs text-gray-400">
                      HTTP {r.httpStatus} | {r.duration}ms
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 font-mono mb-2 break-all">{r.url}</div>
                  <div className="text-sm bg-gray-900/50 rounded p-2 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                    {r.status === "success" ? (
                      <span className="text-green-300">{r.responsePreview}</span>
                    ) : (
                      <span className="text-gray-400">{r.responsePreview}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
