"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";

/** 常用空间名称预选项 */
const PRESET_SPACES = [
  "客厅",
  "餐厅",
  "主卧",
  "次卧",
  "书房",
  "厨房",
  "卫生间",
  "玄关",
  "阳台",
  "衣帽间",
  "儿童房",
  "茶室",
  "健身房",
  "影音室",
];

interface FileItem {
  file: File;
  preview: string;
  spaceName: string;
}

interface UploadResult {
  url: string;
  mdUrl: string;
  title: string;
  summary: string;
  tags: string[];
  spaceName: string;
}

export default function UploadPage() {
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const router = useRouter();

  // 处理文件选择（多选）
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files || []);
      if (selectedFiles.length === 0) return;

      const newItems: FileItem[] = [];
      let loadedCount = 0;

      selectedFiles.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          newItems[index] = {
            file,
            preview: event.target?.result as string,
            spaceName: "",
          };
          loadedCount++;

          // 所有文件读取完成后一并设置
          if (loadedCount === selectedFiles.length) {
            setFileItems((prev) => [...prev, ...newItems]);
            setResults([]);
          }
        };
        reader.readAsDataURL(file);
      });
    },
    []
  );

  // 删除某个文件项
  const removeFile = useCallback((index: number) => {
    setFileItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // 更新空间名称
  const updateSpaceName = useCallback(
    (index: number, name: string) => {
      setFileItems((prev) =>
        prev.map((item, i) =>
          i === index ? { ...item, spaceName: name } : item
        )
      );
    },
    []
  );

  // 点击预设按钮
  const applyPreset = useCallback(
    (index: number, preset: string) => {
      updateSpaceName(index, preset);
    },
    [updateSpaceName]
  );

  // 上传所有图片
  const handleUpload = async () => {
    if (fileItems.length === 0) return;

    setLoading(true);
    setResults([]);

    const formData = new FormData();
    fileItems.forEach((item) => {
      formData.append("files", item.file);
      formData.append("spaceNames", item.spaceName.trim());
    });

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.success) {
        setResults(data.data || []);
        setFileItems([]); // 清空文件列表
      } else {
        alert("上传失败: " + data.error);
      }
    } catch (err) {
      alert("上传失败，请重试");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto">
        {/* 头部 */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold">上传图片</h1>
            <button
              onClick={() => router.push("/")}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors"
            >
              返回首页
            </button>
          </div>

          {/* 文件选择 */}
          <div className="mb-4">
            <label className="block mb-2 font-medium">选择图片文件</label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
              className="w-full p-2 border border-gray-300 rounded-lg"
            />
            <p className="text-xs text-gray-400 mt-1">
              可同时选择多张图片
            </p>
          </div>

          {/* 上传按钮 */}
          {fileItems.length > 0 && (
            <button
              onClick={handleUpload}
              disabled={loading}
              className={`w-full py-3 rounded-lg font-medium transition-colors ${
                loading
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-blue-500 text-white hover:bg-blue-600"
              }`}
            >
              {loading
                ? "正在上传并分析（" + fileItems.length + " 张）..."
                : "上传 " + fileItems.length + " 张图片并分析"}
            </button>
          )}
        </div>

        {/* 文件列表（每张图独立空间名称配置） */}
        {fileItems.length > 0 && (
          <div className="space-y-4">
            {fileItems.map((item, index) => (
              <div
                key={index}
                className="bg-white rounded-lg shadow-md p-4"
              >
                <div className="flex gap-4">
                  {/* 缩略图 */}
                  <div className="w-28 h-28 flex-shrink-0">
                    <img
                      src={item.preview}
                      alt={item.file.name}
                      className="w-full h-full object-cover rounded-lg border border-gray-200"
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* 文件名 */}
                    <p className="text-sm text-gray-500 mb-2 truncate">
                      {item.file.name}
                    </p>

                    {/* 空间名称输入 */}
                    <label className="block text-sm font-medium mb-1">
                      空间名称
                    </label>
                    <input
                      type="text"
                      placeholder="例如：主卧、客厅..."
                      value={item.spaceName}
                      onChange={(e) => updateSpaceName(index, e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                    />

                    {/* 预设空间名按钮 */}
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {PRESET_SPACES.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => applyPreset(index, preset)}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            item.spaceName === preset
                              ? "bg-blue-500 text-white border-blue-500"
                              : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-blue-50 hover:border-blue-300"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 删除按钮 */}
                  <button
                    onClick={() => removeFile(index)}
                    className="flex-shrink-0 self-start w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                    title="移除此图片"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 上传结果列表 */}
        {results.length > 0 && (
          <div className="mt-6 space-y-4">
            <h2 className="text-xl font-bold">
              上传结果（{results.length} 张）
            </h2>
            {results.map((result, index) => (
              <div
                key={index}
                className="bg-green-50 border border-green-200 rounded-lg p-4"
              >
                <h3 className="font-semibold text-green-800 mb-2">
                  图片 {index + 1}
                  {result.spaceName ? " — " + result.spaceName : ""}
                </h3>
                <p className="mb-1">
                  <strong>标题:</strong> {result.title}
                </p>
                <p className="mb-1">
                  <strong>总结:</strong> {result.summary}
                </p>
                <p className="mb-1">
                  <strong>关键词:</strong>{" "}
                  {result.tags?.join(", ") || "无"}
                </p>
                <div className="flex gap-2 mt-3">
                  <a
                    href={result.mdUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
                  >
                    查看 MD 总结
                  </a>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                  >
                    查看原图
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
