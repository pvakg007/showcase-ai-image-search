"use client";

import { useEffect, useState, useCallback } from "react";

interface BatchImageItem {
  id: number;
  url: string;
  title: string;
  tags?: string[];
}

interface PreviewModalProps {
  /** URL to show — image URL or MD file URL */
  url: string;
  /** Type of content */
  type: "image" | "markdown";
  /** Title displayed in header bar */
  title?: string;
  /** Tags displayed below image (仅 image 类型) */
  tags?: string[];
  /** 批次 ID，用于同案例图片关联 */
  batchId?: string | number;
  /** Close handler */
  onClose: () => void;
}

/**
 * 全屏悬浮预览弹窗，黑色半透明遮罩。
 * 点击背景或 ✕ 按钮关闭，按 Escape 键关闭。
 */
export default function PreviewModal({
  url,
  type,
  title,
  tags,
  batchId,
  onClose,
}: PreviewModalProps) {
  const [mdContent, setMdContent] = useState("");
  const [loading, setLoading] = useState(false);

  // 同案例图片
  const [batchImages, setBatchImages] = useState<BatchImageItem[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [showBatch, setShowBatch] = useState(false);

  // 如果是 markdown 类型，通过代理拉取内容（避免 COS CORS 限制）
  useEffect(() => {
    if (type === "markdown") {
      setLoading(true);
      setMdContent("");
      setShowBatch(false);
      setBatchImages([]);
      var fetchUrl = url.startsWith("http")
        ? "/api/raw?url=" + encodeURIComponent(url)
        : url;
      fetch(fetchUrl)
        .then(function (res) {
          if (!res.ok) throw new Error("加载失败 (HTTP " + res.status + ")");
          return res.text();
        })
        .then(function (text) {
          setMdContent(text);
        })
        .catch(function (err) {
          setMdContent("⚠ " + err.message);
        })
        .finally(function () {
          setLoading(false);
        });
    }
  }, [url, type]);

  // Escape 键关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // 锁定背景滚动
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // 加载同案例图片
  var loadBatchImages = useCallback(async function () {
    if (!batchId) return;
    setBatchLoading(true);
    try {
      var res = await fetch("/api/images/by-batch?batchId=" + batchId);
      var data = await res.json();
      if (data.success) {
        // 排除当前图片
        var others = (data.data || []).filter(function (img: BatchImageItem) {
          return img.url !== url;
        });
        setBatchImages(others);
        setShowBatch(true);
      }
    } catch (_) {} finally {
      setBatchLoading(false);
    }
  }, [batchId, url]);

  // 简单的 markdown 行渲染
  const renderMarkdownLine = useCallback((line: string, i: number) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("# ")) {
      return (
        <h1 key={i} className="text-xl font-bold mb-3 mt-2">
          {trimmed.slice(2)}
        </h1>
      );
    }
    if (trimmed.startsWith("## ")) {
      return (
        <h2 key={i} className="text-lg font-semibold mb-2 mt-4 text-gray-800">
          {trimmed.slice(3)}
        </h2>
      );
    }
    if (trimmed.startsWith("### ")) {
      return (
        <h3 key={i} className="text-base font-semibold mb-1 mt-3 text-gray-700">
          {trimmed.slice(4)}
        </h3>
      );
    }
    if (trimmed.startsWith("---")) {
      return <hr key={i} className="my-4 border-gray-300" />;
    }
    if (trimmed === "") {
      return <div key={i} className="h-3" />;
    }
    if (trimmed.startsWith("- **") && trimmed.includes("**: ")) {
      const match = trimmed.match(/^- \*\*(.+?)\*\*:?\s*(.*)/);
      if (match) {
        return (
          <p key={i} className="mb-1 text-gray-800">
            <strong className="text-gray-900">{match[1]}</strong>
            {match[2] ? "：" + match[2] : ""}
          </p>
        );
      }
    }
    if (trimmed.startsWith("- ")) {
      return (
        <li key={i} className="ml-5 mb-0.5 text-gray-700 list-disc">
          {trimmed.slice(2)}
        </li>
      );
    }
    if (/^\d+\.\s/.test(trimmed)) {
      return (
        <li key={i} className="ml-5 mb-0.5 text-gray-700 list-decimal">
          {trimmed.replace(/^\d+\.\s*/, "")}
        </li>
      );
    }

    // 处理行内加粗 **text** 和链接 [text](url)
    const withHtml = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[(.+?)\]\((.+?)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline hover:text-blue-800">$1</a>'
      );
    return (
      <p
        key={i}
        className="mb-1 text-gray-700"
        dangerouslySetInnerHTML={{ __html: withHtml }}
      />
    );
  }, []);

  // 过滤掉 "设计图" 的标签
  var displayTags = (tags || []).filter(function (t) {
    return t !== "设计图";
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 md:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b bg-gray-50 shrink-0">
          <h3 className="font-medium text-gray-800 truncate pr-4">
            {title || ""}
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-full transition-colors shrink-0"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto p-5">
          {type === "image" ? (
            <>
              {/* 大图 */}
              <img
                src={url}
                alt={title || "预览"}
                className="max-w-full h-auto mx-auto rounded"
              />

              {/* 标签显示 */}
              {displayTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-4 justify-center">
                  {displayTags.map(function (tag) {
                    return (
                      <span
                        key={tag}
                        className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm"
                      >
                        {tag}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* 同案例图片按钮 */}
              {batchId && !showBatch && (
                <div className="mt-4 text-center">
                  <button
                    onClick={loadBatchImages}
                    disabled={batchLoading}
                    className="px-5 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500 transition-colors text-sm"
                  >
                    {batchLoading ? "加载中..." : "同案例图片"}
                  </button>
                </div>
              )}

              {/* 同案例图片网格 */}
              {showBatch && batchImages.length > 0 && (
                <div className="mt-5">
                  <h4 className="text-sm font-semibold text-gray-600 mb-3 text-center">
                    同案例图片（共 {batchImages.length + 1} 张）
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {batchImages.map(function (img) {
                      return (
                        <div
                          key={img.id}
                          className="cursor-pointer group"
                          onClick={function () {
                            // 在当前位置打开该图片（模拟点击图片切换）
                            window.open(img.url, "_blank");
                          }}
                        >
                          <div className="aspect-square overflow-hidden rounded-lg border border-gray-200">
                            <img
                              src={img.url}
                              alt={img.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1 truncate">
                            {img.title}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          ) : loading ? (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <svg
                className="animate-spin h-6 w-6 mr-2"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              加载中...
            </div>
          ) : (
            <div className="prose prose-sm max-w-none">
              {mdContent.split("\n").map((line, i) => renderMarkdownLine(line, i))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
