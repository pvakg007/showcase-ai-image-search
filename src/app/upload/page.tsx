"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import PreviewModal from "../components/PreviewModal";

/** 常用空间名称预选项 */
const PRESET_SPACES = [
  "客厅", "餐厅", "主卧", "次卧", "书房", "厨房", "卫生间",
  "玄关", "阳台", "衣帽间", "儿童房", "茶室", "健身房", "影音室",
];

interface FileItem {
  file: File;
  preview: string;
  spaceNames: string[];
}

interface JobResultItem {
  title: string;
  mdUrl: string;
  url: string;
  tags: string[];
  spaceNames: string[];
}

/**
 * 从 localStorage 加载最近项目名
 */
function loadRecentProjects(): string[] {
  if (typeof window === "undefined") return [];
  try {
    var raw = localStorage.getItem("recent_projects");
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

/**
 * 保存项目名到 localStorage（最多保留 3 个不重复的）
 */
function saveRecentProject(name: string) {
  if (!name || typeof window === "undefined") return;
  try {
    var existing = loadRecentProjects();
    var updated = [name].concat(existing.filter(function (n) { return n !== name; })).slice(0, 3);
    localStorage.setItem("recent_projects", JSON.stringify(updated));
  } catch (_) {}
}

export default function UploadPage() {
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<JobResultItem[]>([]);
  const [router] = useState(useRouter);

  // ========== 项目名称 ==========
  const [projectName, setProjectName] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>([]);

  // ========== 任务状态 ==========
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [jobProgress, setJobProgress] = useState({ total: 0, done: 0, failed: 0 });

  // ========== 预览弹窗 ==========
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "markdown">("image");
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewTags, setPreviewTags] = useState<string[]>([]);
  const [previewBatchId, setPreviewBatchId] = useState<string | number>("");

  // 初始化加载最近项目名
  useEffect(function () {
    setRecentProjects(loadRecentProjects());
  }, []);

  // 自动触发处理 + 轮询任务状态
  useEffect(function () {
    if (!lastJobId) return;
    var triggerCount = 0;

    // 1. 先主动触发处理
    async function triggerProcessing() {
      try {
        var res = await fetch("/api/process-queue");
        var data = await res.json();
        if (data.success) setJobStatus("processing");
      } catch (_) {}
    }
    triggerProcessing();

    // 2. 轮询状态，每隔 3 秒检查一次
    var timer = setInterval(async function () {
      try {
        var res = await fetch("/api/jobs/status?jobId=" + lastJobId);
        var data = await res.json();
        if (data.success) {
          setJobProgress({
            total: data.data.totalImages || 0,
            done: data.data.processed || 0,
            failed: data.data.failed || 0,
          });
          if (data.data.status === "completed") {
            setJobStatus("completed");
            setResults(data.data.results || []);
            clearInterval(timer);
            return;
          } else if (data.data.status === "failed") {
            setJobStatus("failed");
            clearInterval(timer);
            return;
          } else if (data.data.status === "processing") {
            setJobStatus("processing");
            return; // 状态已确认，不再需要额外触发
          }
        }

        // 3. 如果状态仍是 pending 超过 6 秒，重新触发处理
        triggerCount++;
        if (triggerCount <= 3) {
          fetch("/api/process-queue").catch(function () {});
        }
      } catch (_) {}
    }, 3000);
    return function () { clearInterval(timer); };
  }, [lastJobId]);

  // ========== 客户端图片压缩 ==========
  async function compressImage(file: File, maxWidth = 1600, quality = 0.8): Promise<File> {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        var w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
        if (h > maxWidth) { w = Math.round(w * maxWidth / h); h = maxWidth; }
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error("压缩失败")); return; }
          var newName = file.name.replace(/\.[^.]+$/, ".jpg");
          resolve(new File([blob], newName, { type: "image/jpeg" }));
        }, "image/jpeg", quality);
      };
      img.onerror = function () { reject(new Error("图片加载失败")); };
      var reader = new FileReader();
      reader.onload = function (e) { img.src = e.target!.result as string; };
      reader.readAsDataURL(file);
    });
  }

  // ========== 文件选择（自动压缩） ==========
  const handleFileChange = useCallback(function (e: React.ChangeEvent<HTMLInputElement>) {
    var selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    var newItems: FileItem[] = [];
    var loadedCount = 0;

    selectedFiles.forEach(async function (file, index) {
      // 非 JPEG 且 > 200KB 的图片先压缩
      var fileToUse = file;
      if (file.type !== "image/jpeg" || file.size > 200 * 1024) {
        try {
          fileToUse = await compressImage(file);
        } catch (_) { /* 压缩失败就用原文件 */ }
      }

      var reader = new FileReader();
      reader.onload = function (event) {
        newItems[index] = {
          file: fileToUse,
          preview: (event.target?.result as string) || "",
          spaceNames: [],
        };
        loadedCount++;
        if (loadedCount === selectedFiles.length) {
          setFileItems(function (prev) { return prev.concat(newItems); });
          setResults([]);
          setLastJobId(null);
          setJobStatus("");
          e.target.value = "";
        }
      };
      reader.readAsDataURL(fileToUse);
    });
  }, []);

  // ========== 删除文件 ==========
  const removeFile = useCallback(function (index: number) {
    setFileItems(function (prev) { return prev.filter(function (_, i) { return i !== index; }); });
  }, []);

  // ========== 更新空间名称 ==========
  const updateSpaceNames = useCallback(function (index: number, names: string[]) {
    setFileItems(function (prev) {
      return prev.map(function (item, i) {
        return i === index ? { ...item, spaceNames: names } : item;
      });
    });
  }, []);

  // ========== 预设按钮切换 ==========
  const togglePreset = useCallback(function (index: number, preset: string) {
    setFileItems(function (prev) {
      var item = prev[index];
      if (!item) return prev;
      var exists = item.spaceNames.includes(preset);
      var newNames = exists
        ? item.spaceNames.filter(function (n) { return n !== preset; })
        : item.spaceNames.concat([preset]);
      return prev.map(function (it, i) {
        return i === index ? { ...it, spaceNames: newNames } : it;
      });
    });
  }, []);

  // ========== 上传（异步：先传文件到 COS，后台处理） ==========
  const handleUpload = useCallback(async function (mode: "batch" | "individual") {
    if (fileItems.length === 0) return;

    setLoading(true);
    setResults([]);
    setLastJobId(null);
    setJobStatus("uploading");

    // 保存项目名
    if (projectName) {
      saveRecentProject(projectName);
      setRecentProjects(loadRecentProjects());
    }

    try {
      // 直接上传原始文件（不压缩）
      var formData = new FormData();
      for (var i = 0; i < fileItems.length; i++) {
        formData.append("files", fileItems[i].file);
        formData.append("spaceNames", JSON.stringify(fileItems[i].spaceNames));
      }
      formData.append("mode", mode);
      formData.append("projectName", projectName);

      var res = await fetch("/api/upload", { method: "POST", body: formData });
      var data = await res.json();

      if (data.success) {
        setLastJobId(data.jobId);
        setJobStatus("pending");
        setJobProgress({ total: data.fileCount || 0, done: 0, failed: 0 });
        setFileItems([]);
      } else {
        alert("上传失败: " + (data.error || "未知错误"));
        setJobStatus("");
      }
    } catch (err) {
      alert("上传失败，请重试");
      console.error(err);
      setJobStatus("");
    } finally {
      setLoading(false);
    }
  }, [fileItems, projectName]);

  // ========== 预览弹窗 ==========
  const openPreview = useCallback(function (
    url: string, type: "image" | "markdown", title: string,
    tags?: string[], batchId?: string | number
  ) {
    setPreviewUrl(url);
    setPreviewType(type);
    setPreviewTitle(title);
    setPreviewTags(tags || []);
    setPreviewBatchId(batchId || "");
  }, []);

  const closePreview = useCallback(function () {
    setPreviewUrl(null);
  }, []);

  // 判断上传按钮是否可点
  var canUpload = fileItems.length > 0 && !loading;

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold">上传图片</h1>
            <div className="flex gap-2">
              <a href="/" className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors">
                返回首页
              </a>
              <a href="/admin" className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
                管理后台
              </a>
            </div>
          </div>

          {/* ===== 项目名称 ===== */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">项目名称（可选）</label>
            <input
              type="text"
              placeholder="输入项目名称"
              value={projectName}
              onChange={function (e) { setProjectName(e.target.value); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {recentProjects.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {recentProjects.map(function (name) {
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={function () { setProjectName(name); }}
                      className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition-colors"
                    >
                      {name}
                    </button>
                  );
                })}
                <span className="text-xs text-gray-400 self-center ml-1">最近使用</span>
              </div>
            )}
          </div>

          {/* ===== 文件选择 ===== */}
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
              可同时选择多张图片。文件先上传到服务器，压缩和分析在后台进行。
            </p>
          </div>

          {/* ===== 上传按钮 ===== */}
          <div className="flex gap-3">
            <button
              onClick={function () { handleUpload("individual"); }}
              disabled={!canUpload}
              className={"flex-1 py-3 rounded-lg font-medium transition-colors " + (
                !canUpload
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-blue-500 text-white hover:bg-blue-600"
              )}
            >
              分张分析上传
            </button>
            <button
              onClick={function () { handleUpload("batch"); }}
              disabled={!canUpload}
              className={"flex-1 py-3 rounded-lg font-medium transition-colors " + (
                !canUpload
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-green-500 text-white hover:bg-green-600"
              )}
            >
              批量分析上传
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">
            「分张」每张图分别分析、「批量」所有图一次分析（视 API 能力）
          </p>

          {/* ===== 任务状态 ===== */}
          {jobStatus && jobStatus !== "" && (
            <div className={"mt-4 p-4 rounded-lg border " + (
              jobStatus === "completed" ? "bg-green-50 border-green-200" :
              jobStatus === "failed" ? "bg-red-50 border-red-200" :
              "bg-blue-50 border-blue-200"
            )}>
              <p className="font-medium">
                {jobStatus === "uploading" && "⏳ 上传文件中..."}
                {jobStatus === "pending" && "✅ 文件已上传，等待处理..."}
                {jobStatus === "processing" && "🔄 分析中..."}
                {jobStatus === "completed" && "✅ 处理完成！"}
                {jobStatus === "failed" && "❌ 处理失败"}
              </p>
              {(jobStatus === "pending" || jobStatus === "processing") && jobProgress.total > 0 && (
                <p className="text-sm text-gray-600 mt-1">
                  进度：{jobProgress.done}/{jobProgress.total}
                  {jobProgress.failed > 0 && " （" + jobProgress.failed + " 失败）"}
                </p>
              )}
              {jobStatus === "pending" && (
                <p className="text-xs text-gray-400 mt-1">
                  任务编号：{lastJobId}（可关闭页面，之后在管理后台查看结果）
                </p>
              )}
              {lastJobId && (
                <button
                  onClick={async function () {
                    var res = await fetch("/api/process-queue");
                    var data = await res.json();
                    alert(data.message || "已触发处理");
                  }}
                  className="mt-2 px-3 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                >
                  手动触发处理
                </button>
              )}
            </div>
          )}
        </div>

        {/* ===== 文件列表 ===== */}
        {fileItems.length > 0 && (
          <div className="space-y-4">
            {fileItems.map(function (item, index) {
              return (
                <div key={index} className="bg-white rounded-lg shadow-md p-4">
                  <div className="flex gap-4">
                    <div className="w-28 h-28 flex-shrink-0">
                      <img src={item.preview} alt={item.file.name}
                        className="w-full h-full object-cover rounded-lg border border-gray-200" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-500 mb-2 truncate">{item.file.name}</p>
                      <label className="block text-sm font-medium mb-1">空间名称</label>
                      <input
                        type="text"
                        placeholder="点击预设标签选择"
                        value={item.spaceNames.join("、")}
                        onChange={function (e) {
                          var names = e.target.value.split("、").map(function (s) { return s.trim(); }).filter(Boolean);
                          updateSpaceNames(index, names);
                        }}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                      />
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {PRESET_SPACES.map(function (preset) {
                          return (
                            <button key={preset} type="button" onClick={function () { togglePreset(index, preset); }}
                              className={"px-2.5 py-1 text-xs rounded-full border transition-colors " + (
                                item.spaceNames.includes(preset)
                                  ? "bg-blue-500 text-white border-blue-500"
                                  : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-blue-50 hover:border-blue-300"
                              )}
                            >{preset}</button>
                          );
                        })}
                      </div>
                      {item.spaceNames.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {item.spaceNames.map(function (name) {
                            return (
                              <span key={name}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full"
                              >
                                {name}
                                <button onClick={function () {
                                  updateSpaceNames(index, item.spaceNames.filter(function (n) { return n !== name; }));
                                }} className="text-blue-400 hover:text-blue-700 leading-none">×</button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <button onClick={function () { removeFile(index); }}
                      className="flex-shrink-0 self-start w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                      title="移除此图片">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ===== 处理结果 ===== */}
        {results.length > 0 && (
          <div className="mt-6 space-y-4">
            <h2 className="text-xl font-bold">处理结果（{results.length} 张）</h2>
            {results.map(function (result, index) {
              var spaceLabel = result.spaceNames && result.spaceNames.length > 0
                ? result.spaceNames.join("、") : "";
              return (
                <div key={index} className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h3 className="font-semibold text-green-800 mb-2">
                    图片 {index + 1}{spaceLabel ? " — " + spaceLabel : ""}
                  </h3>
                  <p className="mb-1"><strong>标题:</strong> {result.title}</p>
                  <p className="mb-1"><strong>关键词:</strong> {(result.tags || []).join(", ") || "无"}</p>
                  <div className="flex gap-2 mt-3">
                    <button onClick={function () {
                      openPreview(result.mdUrl, "markdown", result.title || "分析总结");
                    }} className="px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors">
                      查看总结
                    </button>
                    <button onClick={function () {
                      openPreview(result.url, "image", result.title || "原图", result.tags);
                    }} className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors">
                      查看原图
                    </button>
                  </div>
                </div>
              );
            })}
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
    </main>
  );
}
