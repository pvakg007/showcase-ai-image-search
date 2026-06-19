"use client";

import { useState, useEffect } from "react";

interface ImageItem {
  id: number;
  url: string;
  mdUrl: string;
  title: string;
  summary: string;
  tags: string[];
  spaceName?: string;
  createdAt: number;
}

/**
 * 防抖 Hook：延迟更新值，避免频繁触发搜索请求
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

  // 防抖后的搜索文本
  const debouncedSearchText = useDebounce(searchText, 300);

  // 页面加载和搜索条件变化时自动搜索
  useEffect(() => {
    fetchData();
  }, [debouncedSearchText, selectedTags]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 构建搜索查询
      const query: { q: string; filter?: string } = {
        q: debouncedSearchText,
      };

      // Meilisearch 筛选语法：tags = "tag1" AND tags = "tag2"
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
      setImages(data.hits || []);
    } catch (err) {
      console.error("搜索错误:", err);
    } finally {
      setLoading(false);
    }
  };

  // 点击标签添加/移除筛选
  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag));
    } else {
      setSelectedTags([...selectedTags, tag]);
    }
  };

  // 清除所有筛选
  const clearFilters = () => {
    setSearchText("");
    setSelectedTags([]);
  };

  // 从搜索框中删除指定关键词
  const removeSearchTag = (tag: string) => {
    setSelectedTags(selectedTags.filter((t) => t !== tag));
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
            <a
              href="/upload"
              className="px-4 py-2 bg-blue-500 text-white hover:bg-blue-600 rounded-lg transition-colors"
            >
              上传图片
            </a>
          </div>

          {/* 已选中的关键词标签 */}
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
            {images.map((img) => (
              <div
                key={img.id}
                className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow"
              >
                {/* 图片 */}
                <div className="aspect-square overflow-hidden">
                  <img
                    src={img.url}
                    alt={img.title}
                    className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                  />
                </div>

                {/* 内容 */}
                <div className="p-4">
                  <h3 className="font-semibold text-lg mb-2 truncate">
                    {img.title}
                  </h3>
                  {img.spaceName && (
                    <p className="text-amber-700 text-xs mb-1">
                      📍 {img.spaceName}
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

                  {/* 操作按钮 */}
                  <div className="flex gap-2">
                    <a
                      href={img.mdUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-center text-sm transition-colors"
                    >
                      查看总结
                    </a>
                    <a
                      href={img.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 px-3 py-1 bg-blue-100 text-blue-700 hover:bg-blue-200 rounded text-center text-sm transition-colors"
                    >
                      查看原图
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
