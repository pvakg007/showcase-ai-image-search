"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import PreviewModal from "../components/PreviewModal";

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
  spaceNames: string[];
}

interface UploadResult {
  url: string;
  mdUrl: string;
  title: string;
  summary: string;
  tags: string[];
  spaceName: string;
  spaceNames?: string[];
}

/**
 * 客户端图片压缩：若图片最大边 > maxPx，压缩为 JPEG 并缩放至 maxPx。
 * 否则返回原始 File 不变。
 */
/** 加载图片为 HTMLImageElement */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function compressIfNeeded(file: File, maxPx = 1600): Promise<File> {
  // 非图片类型直接跳过
  if (!file.type.startsWith("image/")) return file;

  const dataUrl = URL.createObjectURL(file);

  try {
    const img = await loadImage(dataUrl);

    const maxDim = Math.max(img.width, img.height);
    if (maxDim <= maxPx) return file;

    const scale = maxPx / maxDim;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.85);
    }) as Blob | null;
    if (!blob) return file;

    const jpgName = file.name.replace(/\.[^.]+$/, ".jpg");
    return new File([blob], jpgName, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(dataUrl);
  }
}

export default function UploadPage() {
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "markdown">(
    "image"
  );
  const [previewTitle, setPreviewTitle] = useState("");
  const router = useRouter();

  // ========== 文件选择 ==========
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
            spaceNames: [],
          };
          loadedCount++;

          if (loadedCount === selectedFiles.length) {
            setFileItems((prev) => [...prev, ...newItems]);
            setResults([]);
            // 重置 file input 以便重复选择同一文件
            e.target.value = "";
          }
        };
        reader.readAsDataURL(file);
      });
    },
    []
  );

  // ========== 删除文件 ==========
  const removeFile = useCallback((index: number) => {
    setFileItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ========== 更新空间名称数组 ==========
  const updateSpaceNames = useCallback(
    (index: number, names: string[]) => {
      setFileItems((prev) =>
        prev.map((item, i) =>
          i === index ? { ...item, spaceNames: names } : item
        )
      );
    },
    []
  );

  // ========== 预设按钮切换 ==========
  const togglePreset = useCallback(
    (index: number, preset: string) => {
      setFileItems((prev) => {
        const item = prev[index];
        if (!item) return prev;
        const exists = item.spaceNames.includes(preset);
        const newNames = exists
          ? item.spaceNames.filter((n) => n !== preset)
          : [...item.spaceNames, preset];
        return prev.map((it, i) =>
          i === index ? { ...it, spaceNames: newNames } : it
        );
      });
    },
    []
  );

  // ========== 上传所有图片 ==========
  const handleUpload = async () => {
    if (fileItems.length === 0) return;

    setLoading(true);
    setResults([]);

    try {
      // 先压缩所有需要压缩的图片
      const compressedItems = await Promise.all(
        fileItems.map(async (item) => ({
          file: await compressIfNeeded(item.file),
          spaceNames: item.spaceNames,
        }))
      );

      const formData = new FormData();
      for (const item of compressedItems) {
        formData.append("files", item.file);
        formData.append("spaceNames", JSON.stringify(item.spaceNames));
      }

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.success) {
        setResults(data.data || []);
        setFileItems([]);
      } else {
        alert("上传失败: " + (data.error || "未知错误"));
      }
    } catch (err) {
      alert("上传失败，请重试");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ========== 预览弹窗 ==========
  const openPreview = useCallback(
    (url: string, type: "image" | "markdown", title: string) => {
      setPreviewUrl(url);
      setPreviewType(type);
      setPreviewTitle(title);
    },
    []
  );

  const closePreview = useCallback(() => {
    setPreviewUrl(null);
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto">
        {/* ========== 头部 ========== */}
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
              可同时选择多张图片。最大边超过 1600px 的图片将自动压缩。
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
                ? "正在压缩、上传并分析（" + fileItems.length + " 张）..."
                : "上传 " + fileItems.length + " 张图片并分析"}
            </button>
          )}
        </div>

        {/* ========== 文件列表 ========== */}
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

                    {/* 空间名称输入（显示所有已选名称，可编辑） */}
                    <label className="block text-sm font-medium mb-1">
                      空间名称
                    </label>
                    <input
                      type="text"
                      placeholder="点击预设标签选择，或用顿号分隔多个自定义空间名"
                      value={item.spaceNames.join("、")}
                      onChange={(e) => {
                        const names = e.target.value
                          .split("、")
                          .map((s) => s.trim())
                          .filter(Boolean);
                        updateSpaceNames(index, names);
                      }}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                    />

                    {/* 预设空间名按钮（多选） */}
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {PRESET_SPACES.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => togglePreset(index, preset)}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            item.spaceNames.includes(preset)
                              ? "bg-blue-500 text-white border-blue-500"
                              : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-blue-50 hover:border-blue-300"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>

                    {/* 已选空间名标签 */}
                    {item.spaceNames.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {item.spaceNames.map((name) => (
                          <span
                            key={name}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full"
                          >
                            {name}
                            <button
                              onClick={() => {
                                const newNames = item.spaceNames.filter(
                                  (n) => n !== name
                                );
                                updateSpaceNames(index, newNames);
                              }}
                              className="text-blue-400 hover:text-blue-700 leading-none"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
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

        {/* ========== 上传结果列表 ========== */}
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
                  {result.spaceNames && result.spaceNames.length > 0
                    ? " — " + result.spaceNames.join("、")
                    : result.spaceName
                    ? " — " + result.spaceName
                    : ""}
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
                  <button
                    onClick={() =>
                      openPreview(
                        result.mdUrl,
                        "markdown",
                        result.title || "分析总结"
                      )
                    }
                    className="px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
                  >
                    查看总结
                  </button>
                  <button
                    onClick={() =>
                      openPreview(
                        result.url,
                        "image",
                        result.title || "原图"
                      )
                    }
                    className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                  >
                    查看原图
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ========== 预览弹窗 ========== */}
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
