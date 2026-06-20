"use client";

import { useState, useEffect, useCallback } from "react";
import PreviewModal from "../components/PreviewModal";

interface ImageItem {
  id: number;
  url: string;
  mdUrl: string;
  title: string;
  summary: string;
  tags: string[];
  spaceName?: string;
  spaceNames?: string[];
  createdAt: number;
}

interface StatsData {
  totalImages: number;
  cosFiles: {
    total: number;
    images: number;
    summaries: number;
    totalSizeFormatted: string;
  };
}

/** 从 sessionStorage 读取 token */
function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("admin_token");
}

/** 带认证的 fetch 封装 */
async function adminFetch(url: string, options: RequestInit = {}) {
  var token = getToken();
  var headers = { ...(options.headers || {}) } as Record<string, string>;
  if (token) headers["Authorization"] = "Basic " + token;
  if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  var res = await fetch(url, { ...options, headers });
  return res.json();
}

export default function AdminPage() {
  // ========== 认证 ==========
  var [authenticated, setAuthenticated] = useState(false);
  var [loginUser, setLoginUser] = useState("");
  var [loginPass, setLoginPass] = useState("");
  var [loginError, setLoginError] = useState("");

  // ========== 数据 ==========
  var [images, setImages] = useState<ImageItem[]>([]);
  var [stats, setStats] = useState<StatsData | null>(null);
  var [searchText, setSearchText] = useState("");
  var [loading, setLoading] = useState(false);

  // ========== 翻页 ==========
  var [adminPage, setAdminPage] = useState(1);
  var [adminTotalPages, setAdminTotalPages] = useState(1);
  var adminPerPage = 50;

  // ========== 批量选择 ==========
  var [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  var [batchLoading, setBatchLoading] = useState(false);

  // ========== 编辑弹窗 ==========
  var [editingItem, setEditingItem] = useState<ImageItem | null>(null);
  var [editTitle, setEditTitle] = useState("");
  var [editSummary, setEditSummary] = useState("");
  var [editTags, setEditTags] = useState("");

  // ========== 预览弹窗 ==========
  var [previewUrl, setPreviewUrl] = useState<string | null>(null);
  var [previewType, setPreviewType] = useState<"image" | "markdown">("image");
  var [previewTitle, setPreviewTitle] = useState("");

  // ========== 初始化 ==========
  useEffect(() => {
    var token = getToken();
    if (token) setAuthenticated(true);
  }, []);

  // 搜索文本变化时重置到第 1 页
  useEffect(() => {
    if (authenticated) {
      setAdminPage(1);
      loadData(1);
      loadStats();
    }
  }, [authenticated, searchText]);

  // 翻页变化时加载
  useEffect(() => {
    if (authenticated && adminPage > 1) {
      loadData(adminPage);
    }
  }, [adminPage]);

  // ========== AI 设置 ==========
  var [aiUrl, setAiUrl] = useState("");
  var [aiModel, setAiModel] = useState("");
  var [aiPrompt, setAiPrompt] = useState("");
  var [settingsLoading, setSettingsLoading] = useState(false);
  var [settingsMsg, setSettingsMsg] = useState("");

  // ========== 任务管理 ==========
  var [jobList, setJobList] = useState<any[]>([]);
  var [jobListLoading, setJobListLoading] = useState(false);
  var [jobFilter, setJobFilter] = useState("");

  // ========== 重新分析 ==========
  var [reprocessingId, setReprocessingId] = useState<number | null>(null);

  var loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    var result = await adminFetch("/api/admin/settings");
    if (result.success && result.data) {
      setAiUrl(result.data.aiUrl || "");
      setAiModel(result.data.aiModel || "");
      setAiPrompt(result.data.aiPrompt || "");
    }
    setSettingsLoading(false);
  }, []);

  var saveSettings = useCallback(async () => {
    setSettingsMsg("");
    var result = await adminFetch("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ aiUrl, aiModel, aiPrompt }),
    });
    if (result.success) {
      setSettingsMsg("✅ " + (result.message || "已保存"));
    } else {
      setSettingsMsg("❌ " + (result.error || "保存失败"));
    }
  }, [aiUrl, aiModel, aiPrompt]);

  // 认证后加载设置 + 任务列表
  useEffect(() => {
    if (authenticated) {
      loadSettings();
      loadJobList();
    }
  }, [authenticated, loadSettings]);

  // ========== 首次设置 ==========
  var [showSetup, setShowSetup] = useState(false);
  var [setupUser, setSetupUser] = useState("");
  var [setupPass, setSetupPass] = useState("");
  var [setupError, setSetupError] = useState("");

  var handleSetup = useCallback(async () => {
    setSetupError("");
    var result = await fetch("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: setupUser, password: setupPass }),
    });
    var data = await result.json();
    if (data.success && data.token) {
      sessionStorage.setItem("admin_token", data.token);
      setAuthenticated(true);
    } else {
      setSetupError(data.error || "初始化失败");
    }
  }, [setupUser, setupPass]);

  // ========== 登录 ==========
  var handleLogin = useCallback(async () => {
    setLoginError("");
    setShowSetup(false);
    var result = await adminFetch("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: loginUser,
        password: loginPass,
      }),
    });
    if (result.success && result.token) {
      sessionStorage.setItem("admin_token", result.token);
      setAuthenticated(true);
    } else if (result.needSetup) {
      setShowSetup(true);
      setLoginError("⚠ 管理员账号尚未初始化，请设置初始账号密码");
    } else {
      setLoginError(result.error || "登录失败");
    }
  }, [loginUser, loginPass]);

  // ========== 退出 ==========
  var handleLogout = useCallback(() => {
    sessionStorage.removeItem("admin_token");
    setAuthenticated(false);
    setImages([]);
    setStats(null);
  }, []);

  // ========== 加载数据 ==========
  var loadData = useCallback(async (pageNum?: number) => {
    setLoading(true);
    var p = pageNum || adminPage;
    var params = new URLSearchParams();
    if (searchText) params.set("q", searchText);
    params.set("limit", String(adminPerPage));
    params.set("page", String(p));
    var result = await adminFetch("/api/admin/images?" + params.toString());
    if (result.success) {
      setImages(result.data || []);
      var total = result.total || 0;
      setAdminTotalPages(Math.max(1, Math.ceil(total / adminPerPage)));
    }
    setLoading(false);
  }, [searchText]);

  var loadStats = useCallback(async () => {
    var result = await adminFetch("/api/admin/stats");
    if (result.success) {
      setStats(result.data);
    }
  }, []);

  // ========== 任务管理 ==========
  var loadJobList = useCallback(async (status?: string) => {
    setJobListLoading(true);
    var params = new URLSearchParams();
    params.set("limit", "50");
    if (status) params.set("status", status);
    var result = await adminFetch("/api/jobs/list?" + params.toString());
    if (result.success) {
      setJobList(result.data || []);
    }
    setJobListLoading(false);
  }, []);

  var retryJob = useCallback(async (jobId: string) => {
    var result = await adminFetch("/api/jobs/retry", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    if (result.success) {
      loadJobList(jobFilter);
    } else {
      alert("重试失败: " + (result.error || "未知错误"));
    }
  }, [jobFilter]);

  // ========== 重新分析 ==========
  var handleReprocess = useCallback(async (item: ImageItem) => {
    setReprocessingId(item.id);
    var result = await adminFetch("/api/jobs/reprocess", {
      method: "POST",
      body: JSON.stringify({
        id: item.id,
        url: item.url,
        mdUrl: item.mdUrl,
      }),
    });
    if (result.success && result.data) {
      setImages(function (prev) {
        return prev.map(function (img) {
          if (img.id === item.id) {
            return {
              ...img,
              title: result.data.title || img.title,
              summary: result.data.summary || img.summary,
              tags: result.data.tags || img.tags,
              mdUrl: result.data.mdUrl || img.mdUrl,
            };
          }
          return img;
        });
      });
    } else {
      alert("重新分析失败: " + (result.error || "未知错误"));
    }
    setReprocessingId(null);
  }, []);

  // ========== 编辑 ==========
  var openEdit = useCallback((item: ImageItem) => {
    setEditingItem(item);
    setEditTitle(item.title);
    setEditSummary(item.summary);
    setEditTags((item.tags || []).join("、"));
  }, []);

  var closeEdit = useCallback(() => {
    setEditingItem(null);
  }, []);

  var saveEdit = useCallback(async () => {
    if (!editingItem) return;
    var newTags = editTags
      .split(/[,，、]/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);

    var result = await adminFetch("/api/admin/images", {
      method: "PUT",
      body: JSON.stringify({
        id: editingItem.id,
        title: editTitle,
        summary: editSummary,
        tags: newTags,
      }),
    });

    if (result.success) {
      // 更新本地数据
      var targetId = editingItem.id; // 已通过前面 !editingItem 检查
      setImages(function (prev) {
        return prev.map(function (item) {
          if (item.id === targetId) {
            return {
              ...item,
              title: editTitle,
              summary: editSummary,
              tags: newTags,
            };
          }
          return item;
        });
      });
      closeEdit();
    } else {
      alert("保存失败: " + (result.error || "未知错误"));
    }
  }, [editingItem, editTitle, editSummary, editTags]);

  // ========== 删除 ==========
  var handleDelete = useCallback(
    async (item: ImageItem) => {
      if (!confirm("确定要删除「" + item.title + "」吗？此操作不可撤销。")) {
        return;
      }
      var result = await adminFetch("/api/admin/images", {
        method: "DELETE",
        body: JSON.stringify({
          id: item.id,
          url: item.url,
          mdUrl: item.mdUrl,
        }),
      });
      if (result.success) {
        setImages(function (prev) {
          return prev.filter(function (i) { return i.id !== item.id; });
        });
        alert("删除成功！" + (result.message || ""));
      } else {
        alert("删除失败: " + (result.error || "未知错误"));
      }
    },
    []
  );

  // ========== 预览 ==========
  var openPreview = useCallback(
    (url: string, type: "image" | "markdown", title: string) => {
      setPreviewUrl(url);
      setPreviewType(type);
      setPreviewTitle(title);
    },
    []
  );

  var closePreview = useCallback(() => {
    setPreviewUrl(null);
  }, []);

  // ========== 格式化时间 ==========
  var formatTime = function (ts: number) {
    if (!ts) return "";
    return new Date(ts).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  var formatBytes = function (n: number) {
    if (!n) return "0B";
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "KB";
    return (n / 1024 / 1024).toFixed(2) + "MB";
  };

  // ===== 未登录 → 登录/首次设置页面 =====
  if (!authenticated) {
    return (
      <main className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
          {!showSetup ? (
            <>
              <h1 className="text-2xl font-bold text-center mb-6">管理后台</h1>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">用户名</label>
                  <input
                    type="text"
                    value={loginUser}
                    onChange={(e) => setLoginUser(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="输入管理员用户名"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">密码</label>
                  <input
                    type="password"
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="输入密码"
                  />
                </div>
                {loginError && !showSetup && (
                  <p className="text-red-500 text-sm">{loginError}</p>
                )}
                <button
                  onClick={handleLogin}
                  className="w-full py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium transition-colors"
                >
                  登录
                </button>
              </div>
              <p className="text-xs text-gray-400 text-center mt-6">
                ⚠ 环境变量需设置 ADMIN_USERNAME 和 ADMIN_PASSWORD
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-center mb-2">首次初始化</h1>
              <p className="text-sm text-gray-500 text-center mb-6">设置管理员账号密码</p>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">管理员用户名</label>
                  <input
                    type="text"
                    value={setupUser}
                    onChange={(e) => setSetupUser(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSetup()}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="例如 admin"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">管理员密码</label>
                  <input
                    type="password"
                    value={setupPass}
                    onChange={(e) => setSetupPass(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSetup()}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="至少 4 个字符"
                  />
                </div>
                {setupError && (
                  <p className="text-red-500 text-sm">{setupError}</p>
                )}
                <button
                  onClick={handleSetup}
                  className="w-full py-2.5 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium transition-colors"
                >
                  初始化并登录
                </button>
                <button
                  onClick={() => { setShowSetup(false); setLoginError(""); }}
                  className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  返回登录
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  // ===== 已登录 → 管理面板 =====
  return (
    <main className="min-h-screen bg-gray-50">
      {/* 顶部栏 */}
      <div className="sticky top-0 bg-white shadow-sm z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl font-bold">管理后台</h1>
          <div className="flex items-center gap-3">
            {stats && (
              <span className="text-sm text-gray-500">
                共 {stats.totalImages} 张图片 · COS {stats.cosFiles.totalSizeFormatted}
              </span>
            )}
            <a
              href="/upload"
              className="px-3 py-1 text-sm bg-green-500 text-white hover:bg-green-600 rounded transition-colors"
            >
              ＋ 上传图片
            </a>
            <button
              onClick={loadStats}
              className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded transition-colors"
              title="刷新统计"
            >
              ↻
            </button>
            <a
              href="/"
              className="px-3 py-1 text-sm bg-blue-100 text-blue-700 hover:bg-blue-200 rounded transition-colors"
            >
              返回首页
            </a>
            <button
              onClick={handleLogout}
              className="px-3 py-1 text-sm bg-red-100 text-red-700 hover:bg-red-200 rounded transition-colors"
            >
              退出
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-4">
        {/* 搜索 */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="搜索图片（标题 / 总结 / 标签）..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={function () { loadData(adminPage); }}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              搜索
            </button>
          </div>
        </div>

        {/* AI 服务商设置 */}
        <details className="bg-white rounded-lg shadow-sm mb-4">
          <summary className="px-4 py-3 cursor-pointer font-medium text-sm text-gray-700 hover:bg-gray-50 rounded-lg select-none">
            ⚙ AI 服务商设置
          </summary>
          <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">API 地址</label>
              <input
                type="text"
                value={aiUrl}
                onChange={(e) => setAiUrl(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1（不要加 /chat/completions）"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">模型名称</label>
              <input
                type="text"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                placeholder="qwen3.6-plus"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">自定义提示词（可选，覆盖默认提示词）</label>
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
                placeholder="留空则使用默认提示词（提示词.txt）"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={saveSettings}
                disabled={settingsLoading}
                className="px-4 py-1.5 text-sm bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:bg-gray-300 transition-colors"
              >
                {settingsLoading ? "保存中..." : "保存设置"}
              </button>
              {settingsMsg && (
                <span className="text-sm">{settingsMsg}</span>
              )}
            </div>
          </div>
        </details>

        {/* ===== 任务管理 ===== */}
        <details className="bg-white rounded-lg shadow-sm mb-4">
          <summary className="px-4 py-3 cursor-pointer font-medium text-sm text-gray-700 hover:bg-gray-50 rounded-lg select-none">
            📋 任务管理
          </summary>
          <div className="px-4 pb-4 border-t border-gray-100 pt-3">
            <div className="flex gap-2 mb-3 flex-wrap">
              {[
                { key: "", label: "全部" },
                { key: "pending", label: "等待中" },
                { key: "processing", label: "处理中" },
                { key: "completed", label: "已完成" },
                { key: "failed", label: "失败" },
              ].map(function (s) {
                return (
                  <button
                    key={s.key}
                    onClick={function () { setJobFilter(s.key); loadJobList(s.key); }}
                    className={"px-3 py-1 text-xs rounded-full border transition-colors " + (
                      jobFilter === s.key
                        ? "bg-blue-500 text-white border-blue-500"
                        : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-blue-50"
                    )}
                  >
                    {s.label}
                  </button>
                );
              })}
              <button
                onClick={function () { loadJobList(jobFilter); }}
                className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors ml-auto"
              >
                刷新
              </button>
            </div>

            {jobListLoading ? (
              <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>
            ) : jobList.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">暂无任务</div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {jobList.map(function (job: any) {
                  var statusColor =
                    job.status === "completed" ? "text-green-600 bg-green-50" :
                    job.status === "failed" ? "text-red-600 bg-red-50" :
                    job.status === "processing" ? "text-blue-600 bg-blue-50" :
                    "text-yellow-600 bg-yellow-50";
                  var statusLabel =
                    job.status === "completed" ? "已完成" :
                    job.status === "failed" ? "失败" :
                    job.status === "processing" ? "处理中" :
                    job.status === "pending" ? "等待中" : "重试中";
                  var title = job.projectName || ("任务 " + String(job.id).slice(-8));
                  var compressedNote = (job.compressedCount > 0)
                    ? "已压缩/转换 " + job.compressedCount + "/" + job.totalImages
                    : "未压缩";
                  return (
                    <div key={job.id} className="p-3 bg-gray-50 rounded-lg text-sm">
                      {/* 行1：状态 + 项目名 + 时间 */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={"px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 " + statusColor}>
                            {statusLabel}
                          </span>
                          <span className="font-medium truncate">{title}</span>
                          <span className="text-gray-400 text-xs flex-shrink-0">{job.type}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {job.status === "failed" && (
                            <button
                              onClick={function () { retryJob(job.id); }}
                              className="px-2.5 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                            >
                              重试
                            </button>
                          )}
                        </div>
                      </div>
                      {/* 行2：统计信息 */}
                      <div className="text-gray-500 text-xs mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>🕐 {formatTime(job.createdAt)}</span>
                        <span>📊 {job.processed}/{job.totalImages} 成功{job.failed > 0 ? " · " + job.failed + " 失败" : ""}</span>
                        {job.retryCount > 0 && <span>🔁 重试 {job.retryCount}/{job.maxRetries}</span>}
                        <span>🗜 {compressedNote}</span>
                        {job.totalFinalSize > 0 && <span>📦 总 {formatBytes(job.totalFinalSize)}</span>}
                      </div>
                      {/* 行3：文件明细 */}
                      {Array.isArray(job.files) && job.files.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {job.files.map(function (f: any, fi: number) {
                            var fstat = f.status === "success" ? "✓" : f.status === "failed" ? "✗" : "⋯";
                            var fcolor = f.status === "success" ? "text-green-600" : f.status === "failed" ? "text-red-600" : "text-gray-400";
                            var spaces = (f.spaceNames && f.spaceNames.length) ? " · " + f.spaceNames.join("、") : "";
                            return (
                              <div key={fi} className="flex items-center gap-2 text-xs text-gray-600 pl-1">
                                <span className={fcolor + " flex-shrink-0"}>{fstat}</span>
                                <span className="truncate flex-1">{(f.originalName || "未命名") + spaces}</span>
                                {f.finalSize > 0 && <span className="text-gray-400 flex-shrink-0">{formatBytes(f.finalSize)}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* 失败错误信息 */}
                      {job.status === "failed" && job.error && (
                        <div className="mt-1.5 text-xs text-red-500 bg-red-50 rounded px-2 py-1 break-all">错误：{job.error}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </details>

        {/* 批量操作栏 */}
        {!loading && images.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={images.length > 0 && selectedIds.size === images.length}
                  onChange={function (e) {
                    if (e.target.checked) {
                      setSelectedIds(new Set(images.map(function (img) { return img.id; })));
                    } else {
                      setSelectedIds(new Set());
                    }
                  }}
                  className="w-4 h-4 rounded border-gray-300"
                />
                全选
              </label>
              <span className="text-sm text-gray-500">
                {selectedIds.size > 0 ? "已选 " + selectedIds.size + " 项" : ""}
              </span>
            </div>
            <div className="flex gap-2">
              {selectedIds.size > 0 && (
                <button
                  onClick={async function () {
                    if (!confirm("确定要删除选中的 " + selectedIds.size + " 张图片吗？此操作不可撤销。")) return;
                    setBatchLoading(true);
                    var itemsToDelete = images.filter(function (img) { return selectedIds.has(img.id); });
                    var items = itemsToDelete.map(function (img) { return { id: img.id, url: img.url, mdUrl: img.mdUrl }; });
                    var result = await adminFetch("/api/admin/images", {
                      method: "DELETE",
                      body: JSON.stringify({ items: items }),
                    });
                    if (result.success) {
                      setSelectedIds(new Set());
                      loadData(adminPage);
                      alert("批量删除完成！");
                    } else {
                      alert("批量删除失败: " + (result.error || "未知错误"));
                    }
                    setBatchLoading(false);
                  }}
                  disabled={batchLoading}
                  className="px-3 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 disabled:bg-gray-300 transition-colors"
                >
                  {batchLoading ? "删除中..." : "删除选中"}
                </button>
              )}
              <button
                onClick={function () { loadData(adminPage); }}
                className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
              >
                刷新
              </button>
            </div>
          </div>
        )}

        {/* 列表 */}
        {loading ? (
          <div className="text-center py-20 text-gray-500">加载中...</div>
        ) : images.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            {searchText ? "没有匹配的结果" : "暂无数据"}
          </div>
        ) : (
          <div className="space-y-3">
            {images.map(function (item) {
              var spaceLabel = "";
              if (item.spaceNames && item.spaceNames.length > 0) {
                spaceLabel = item.spaceNames.join("、");
              } else if (item.spaceName) {
                spaceLabel = item.spaceName;
              }
              var isSelected = selectedIds.has(item.id);
              return (
                <div
                  key={item.id}
                  className={"bg-white rounded-lg shadow-sm p-4 flex gap-4 transition-colors " + (isSelected ? "ring-2 ring-blue-400" : "")}
                >
                  {/* 复选框 */}
                  <div className="flex items-start pt-1 flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={function (e) {
                        var next = new Set(selectedIds);
                        if (e.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        setSelectedIds(next);
                      }}
                      className="w-4 h-4 mt-1 rounded border-gray-300 cursor-pointer"
                    />
                  </div>

                  {/* 缩略图 */}
                  <div
                    className="w-20 h-20 flex-shrink-0 cursor-pointer"
                    onClick={() =>
                      openPreview(item.url, "image", item.title)
                    }
                  >
                    <img
                      src={item.url}
                      alt={item.title}
                      className="w-full h-full object-cover rounded border border-gray-200"
                    />
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-800 truncate">
                          {item.title}
                        </h3>
                        {spaceLabel && (
                          <span className="text-xs text-amber-600">
                            📍 {spaceLabel}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap">
                        {formatTime(item.createdAt)}
                      </span>
                    </div>

                    <p className="text-sm text-gray-600 mt-1 line-clamp-2">
                      {item.summary}
                    </p>

                    <div className="flex flex-wrap gap-1 mt-2">
                      {(item.tags || []).slice(0, 8).map(function (tag) {
                        return (
                          <span
                            key={tag}
                            className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs"
                          >
                            {tag}
                          </span>
                        );
                      })}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => openEdit(item)}
                        className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() =>
                          openPreview(item.mdUrl, "markdown", item.title + " - 总结")
                        }
                        className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
                      >
                        查看总结
                      </button>
                      <button
                        onClick={() => handleReprocess(item)}
                        disabled={reprocessingId === item.id}
                        className={"px-3 py-1 text-xs rounded transition-colors " + (
                          reprocessingId === item.id
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                            : "bg-orange-100 text-orange-700 hover:bg-orange-200"
                        )}
                      >
                        {reprocessingId === item.id ? "分析中..." : "重新分析"}
                      </button>
                      <button
                        onClick={() => handleDelete(item)}
                        className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 翻页 */}
        {!loading && images.length > 0 && adminTotalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-6 mb-4">
            <button
              onClick={function () { setAdminPage(adminPage - 1); window.scrollTo(0, 0); }}
              disabled={adminPage <= 1}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors"
            >
              ← 上一页
            </button>
            {Array.from({ length: Math.min(adminTotalPages, 9) }, function (_, i) {
              var start = Math.max(1, adminPage - 4);
              var end = Math.min(adminTotalPages, start + 8);
              if (end - start < 8) start = Math.max(1, end - 8);
              var p = start + i;
              if (p > adminTotalPages) return null;
              return (
                <button
                  key={p}
                  onClick={function () { setAdminPage(p); window.scrollTo(0, 0); }}
                  className={"w-8 h-8 text-sm rounded-lg transition-colors " + (
                    p === adminPage
                      ? "bg-blue-500 text-white"
                      : "border border-gray-300 hover:bg-gray-100"
                  )}
                >
                  {p}
                </button>
              );
            })}
            <button
              onClick={function () { setAdminPage(adminPage + 1); window.scrollTo(0, 0); }}
              disabled={adminPage >= adminTotalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors"
            >
              下一页 →
            </button>
            <span className="text-sm text-gray-500 ml-2">
              {adminPage}/{adminTotalPages}
            </span>
          </div>
        )}
      </div>

      {/* ===== 编辑弹窗 ===== */}
      {editingItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEdit();
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b bg-gray-50">
              <h3 className="font-medium">编辑图片信息</h3>
              <button
                onClick={closeEdit}
                className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-200"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">标题</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">总结</label>
                <textarea
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  关键词（用逗号、顿号或空格分隔）
                </label>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t bg-gray-50">
              <button
                onClick={closeEdit}
                className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={saveEdit}
                className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 预览弹窗 ===== */}
      {previewUrl && (
        <PreviewModal
          url={previewUrl}
          type={previewType}
          title={previewTitle}
          onClose={closePreview}
        />
      )}
    </main>
  );
}
