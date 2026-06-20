"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import PreviewModal from "./components/PreviewModal";

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

/**
 * 防抖 Hook
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

export default function Home() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // 翻页（初始页在 mount 时从 URL ?page=N 读取，刷新后保持）
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const perPage = 20;

  // 请求令牌：丢弃过期响应，避免翻页+搜索竞争时显示错页
  const fetchTokenRef = useRef(0);

  // mount 时从 URL 读取初始页码（刷新保持页码）
  useEffect(() => {
    if (typeof window !== "undefined") {
      var p = parseInt(new URLSearchParams(window.location.search).get("page") || "1", 10) || 1;
      if (p > 1) setPage(p);
    }
  }, []);

  // 预览弹窗状态
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "markdown">(
    "image"
  );
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewTags, setPreviewTags] = useState<string[]>([]);
  const [previewBatchId, setPreviewBatchId] = useState<string | number>("");

  // 登录弹窗状态
  const [showLogin, setShowLogin] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const debouncedSearchText = useDebounce(searchText, 300);

  // 页面加载时 fire-and-forget 触发后台工作进程，捡起遗留任务（断点续跑）
  useEffect(() => { fetch("/api/process-queue").catch(() => {}); }, []);

  // 搜索/标签变化 → 回到第 1 页（由下方 effect 统一拉取，避免重复请求）
  useEffect(() => {
    setPage(1);
  }, [debouncedSearchText, selectedTags]);

  // 数据获取：page / 搜索 / 标签 任一变化都拉取（含点击回到第 1 页）
  useEffect(() => {
    fetchData(page);
    // 同步 URL，使刷新后保持当前页（不触发滚动/重渲染）
    if (typeof window !== "undefined") {
      var params = new URLSearchParams(window.location.search);
      if (page > 1) params.set("page", String(page)); else params.delete("page");
      var qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearchText, selectedTags]);

  const fetchData = async (pageNum?: number) => {
    var token = ++fetchTokenRef.current;
    setLoading(true);
    try {
      var currentPage = pageNum || page;
      var query: { q: string; filter?: string; page?: number } = {
        q: debouncedSearchText,
        page: currentPage,
      };

      if (selectedTags.length > 0) {
        query.filter = selectedTags
          .map((tag) => `tags = "${tag}"`)
          .join(" AND ");
      }

      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });

      const data = await res.json();
      // 丢弃过期响应（用户在此请求返回前又翻页/搜索了）
      if (token !== fetchTokenRef.current) return;
      setImages(data.hits || []);
      var total = data.estimatedTotalHits || 0;
      setTotalPages(Math.max(1, Math.ceil(total / perPage)));
    } catch (err) {
      console.error("搜索错误:", err);
    } finally {
      if (token === fetchTokenRef.current) setLoading(false);
    }
  };

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag));
    } else {
      setSelectedTags([...selectedTags, tag]);
    }
  };

  const clearFilters = () => {
    setSearchText("");
    setSelectedTags([]);
  };

  const removeSearchTag = (tag: string) => {
    setSelectedTags(selectedTags.filter((t) => t !== tag));
  };

  // 打开预览弹窗
  const openPreview = useCallback(
    (url: string, type: "image" | "markdown", title: string, tags?: string[], batchId?: string | number) => {
      setPreviewUrl(url);
      setPreviewType(type);
      setPreviewTitle(title);
      setPreviewTags(tags || []);
      setPreviewBatchId(batchId || "");
    },
    []
  );

  const closePreview = useCallback(() => {
    setPreviewUrl(null);
  }, []);

  // ========== 登录 ==========
  const handleAdminLogin = useCallback(async () => {
    setLoginError("");
    setLoginLoading(true);
    try {
      var res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
      });
      var data = await res.json();
      if (data.success && data.token) {
        sessionStorage.setItem("admin_token", data.token);
        window.location.href = "/admin";
      } else {
        setLoginError(data.error || "登录失败");
      }
    } catch (err) {
      setLoginError("网络错误");
    } finally {
      setLoginLoading(false);
    }
  }, [loginUser, loginPass]);

  // 获取显示用的空间名称
  const displaySpaceName = (img: ImageItem): string => {
    if (img.spaceNames && img.spaceNames.length > 0)
      return img.spaceNames.join("、");
    if (img.spaceName) return img.spaceName;
    return "";
  };

  return (
    <main className="min-h-screen bg-gray-50">
      {/* 顶部搜索栏 */}
      <div className="sticky top-0 bg-white shadow-sm z-10 p-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold mb-4">AI 设计资料库</h1>

          <div className="flex gap-2 mb-4">
            <input
              type="text"
              placeholder="搜索图片或总结内容..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={clearFilters}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors"
            >
              清除筛选
            </button>
            <button
              onClick={() => setShowLogin(true)}
              className="px-4 py-2 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors text-sm"
            >
              管理登录
            </button>
          </div>

          {selectedTags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              <span className="text-gray-600">已选关键词:</span>
              {selectedTags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-sm flex items-center gap-1 cursor-pointer hover:bg-blue-200"
                  onClick={() => removeSearchTag(tag)}
                >
                  {tag} ×
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 图片网格 */}
      <div className="max-w-7xl mx-auto p-4">
        {loading ? (
          <div className="text-center py-20 text-gray-500">加载中...</div>
        ) : images.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            没有找到匹配的图片，试试上传一些吧！
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {images.map((img) => {
              const spaceLabel = displaySpaceName(img);
              return (
                <div
                  key={img.id}
                  className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow"
                >
                  {/* 图片 */}
                  <div
                    className="aspect-square overflow-hidden cursor-pointer"
                    onClick={() =>
                      openPreview(img.url, "image", img.title, img.tags, (img as any).batchId)
                    }
                  >
                    <img
                      src={img.url}
                      alt={img.title}
                      className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                    />
                  </div>

                  <div className="p-4">
                    <h3 className="font-semibold text-lg mb-2 truncate">
                      {img.title}
                    </h3>
                    {spaceLabel && (
                      <p className="text-amber-700 text-xs mb-1">
                        📍 {spaceLabel}
                      </p>
                    )}
                    <p className="text-gray-600 text-sm mb-3 line-clamp-2">
                      {img.summary}
                    </p>

                    {/* 关键词标签 */}
                    <div className="flex flex-wrap gap-1 mb-3">
                      {img.tags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className={`px-2 py-1 rounded-full text-xs cursor-pointer transition-colors ${
                            selectedTags.includes(tag)
                              ? "bg-blue-500 text-white"
                              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          }`}
                          onClick={() => toggleTag(tag)}
                        >
                          {tag}
                        </span>
                      ))}
                      {img.tags.length > 5 && (
                        <span className="px-2 py-1 bg-gray-100 text-gray-500 rounded-full text-xs">
                          +{img.tags.length - 5}
                        </span>
                      )}
                    </div>

                    {/* 操作按钮 — 同页面预览 */}
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          openPreview(
                            img.mdUrl,
                            "markdown",
                            img.title + " - 分析总结"
                          )
                        }
                        className="flex-1 px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-center text-sm transition-colors"
                      >
                        查看总结
                      </button>
                      <button
                        onClick={() =>
                          window.open(img.url, "_blank")
                        }
                        className="flex-1 px-3 py-1 bg-blue-100 text-blue-700 hover:bg-blue-200 rounded text-center text-sm transition-colors"
                      >
                        查看原图
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 翻页 */}
        {!loading && images.length > 0 && totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-6 mb-4">
            <button
              onClick={() => { setPage(page - 1); window.scrollTo(0, 0); }}
              disabled={page <= 1}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors"
            >
              ← 上一页
            </button>
            {Array.from({ length: Math.min(totalPages, 9) }, function (_, i) {
              var start = Math.max(1, page - 4);
              var end = Math.min(totalPages, start + 8);
              if (end - start < 8) start = Math.max(1, end - 8);
              var p = start + i;
              if (p > totalPages) return null;
              return (
                <button
                  key={p}
                  onClick={() => { setPage(p); window.scrollTo(0, 0); }}
                  className={"w-8 h-8 text-sm rounded-lg transition-colors " + (
                    p === page
                      ? "bg-blue-500 text-white"
                      : "border border-gray-300 hover:bg-gray-100"
                  )}
                >
                  {p}
                </button>
              );
            })}
            <button
              onClick={() => { setPage(page + 1); window.scrollTo(0, 0); }}
              disabled={page >= totalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 transition-colors"
            >
              下一页 →
            </button>
            <span className="text-sm text-gray-500 ml-2">
              {page}/{totalPages}
            </span>
          </div>
        )}
      </div>

      {/* 预览弹窗 */}
      {previewUrl && (
        <PreviewModal
          url={previewUrl}
          type={previewType}
          title={previewTitle}
          tags={previewTags}
          batchId={previewBatchId}
          onClose={closePreview}
        />
      )}

      {/* 登录弹窗 */}
      {showLogin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLogin(false); }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">管理员登录</h2>
              <button
                onClick={() => { setShowLogin(false); setLoginError(""); }}
                className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-200"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">用户名</label>
                <input
                  type="text"
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
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
                  onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="输入密码"
                />
              </div>
              {loginError && (
                <p className="text-red-500 text-sm">{loginError}</p>
              )}
              <button
                onClick={handleAdminLogin}
                disabled={loginLoading}
                className="w-full py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 font-medium transition-colors"
              >
                {loginLoading ? "登录中..." : "登录"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
