"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [spaceName, setSpaceName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const router = useRouter();

  // 处理文件选择
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      // 生成预览
      const reader = new FileReader();
      reader.onload = (event) => {
        setPreview(event.target?.result as string);
      };
      reader.readAsDataURL(selectedFile);
      setResult(null);
    }
  };

  // 上传图片
  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    const formData = new FormData();
    formData.append("file", file);
    if (spaceName.trim()) {
      formData.append("spaceName", spaceName.trim());
    }

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.success) {
        setResult(data.data);
        alert("上传成功！大模型已完成分析");
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
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-md p-6">
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
            onChange={handleFileChange}
            className="w-full p-2 border border-gray-300 rounded-lg"
          />
        </div>

        {/* 空间名称（可选） */}
        <div className="mb-4">
          <label className="block mb-2 font-medium">
            空间名称 <span className="text-gray-400 text-sm">（可选）</span>
          </label>
          <input
            type="text"
            placeholder="例如：主卧、客厅、独立书房..."
            value={spaceName}
            onChange={(e) => setSpaceName(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">
            填写空间名称可以让 AI 分析结果更精准
          </p>
        </div>

        {/* 图片预览 */}
        {preview && (
          <div className="mb-6">
            <label className="block mb-2 font-medium">图片预览</label>
            <img
              src={preview}
              alt="预览"
              className="w-full max-h-96 object-contain rounded-lg border border-gray-200"
            />
          </div>
        )}

        {/* 上传按钮 */}
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className={`w-full py-3 rounded-lg font-medium transition-colors ${
            !file || loading
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-blue-500 text-white hover:bg-blue-600"
          }`}
        >
          {loading ? "正在上传并分析..." : "上传并分析"}
        </button>

        {/* 上传结果 */}
        {result && (
          <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <h3 className="font-semibold text-green-800 mb-2">上传成功！</h3>
            <p className="mb-2">
              <strong>标题:</strong> {result.title}
            </p>
            <p className="mb-2">
              <strong>总结:</strong> {result.summary}
            </p>
            <p className="mb-2">
              <strong>关键词:</strong> {result.tags?.join(", ")}
            </p>
            <div className="flex gap-2 mt-4">
              <a
                href={result.mdUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
              >
                查看 MD 总结
              </a>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
              >
                查看原图
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
