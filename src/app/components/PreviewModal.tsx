"use client";

import { useEffect, useState, useCallback } from "react";

interface PreviewModalProps {
  /** URL to show — image URL or MD file URL */
  url: string;
  /** Type of content */
  type: "image" | "markdown";
  /** Title displayed in header bar */
  title?: string;
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
  onClose,
}: PreviewModalProps) {
  const [mdContent, setMdContent] = useState("");
  const [loading, setLoading] = useState(false);

  // 如果是 markdown 类型，拉取内容
  useEffect(() => {
    if (type === "markdown") {
      setLoading(true);
      setMdContent("");
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error("加载失败");
          return res.text();
        })
        .then((text) => setMdContent(text))
        .catch(() => setMdContent("⚠ 加载失败，请检查链接是否有效"))
        .finally(() => setLoading(false));
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
            <img
              src={url}
              alt={title || "预览"}
              className="max-w-full h-auto mx-auto rounded"
            />
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
