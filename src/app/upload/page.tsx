"use client";
import { useState, useCallback, useEffect, useRef } from "react";
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

interface LogLine {
  type: "info" | "ok" | "warn" | "error";
  text: string;
  ts: number;
}

interface CompressInfo {
  index: number;
  originalSize: number;
  compressedSize: number;
  sharp: boolean;
}

function loadRecentProjects(): string[] {
  if (typeof window === "undefined") return [];
  try {
    var raw = localStorage.getItem("recent_projects");
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function saveRecentProject(name: string) {
  if (!name || typeof window === "undefined") return;
  try {
    var existing = loadRecentProjects();
    var updated = [name].concat(existing.filter(function (n) { return n !== name; })).slice(0, 3);
    localStorage.setItem("recent_projects", JSON.stringify(updated));
  } catch (_) {}
}

function formatBytes(n: number): string {
  if (!n) return "0B";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "KB";
  return (n / 1024 / 1024).toFixed(2) + "MB";
}

export default function UploadPage() {
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [results, setResults] = useState<JobResultItem[]>([]);
  const [router] = useState(useRouter);

  const [projectName, setProjectName] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>([]);

  // 处理阶段
  const [stage, setStage] = useState<"idle" | "uploading" | "streaming" | "completed" | "failed">("idle");
  const [totalImages, setTotalImages] = useState(0);

  // 实时日志 + 压缩信息 + AI 内容
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [compressList, setCompressList] = useState<CompressInfo[]>([]);
  const [aiContent, setAiContent] = useState("");
  const [aiFirstFrameMs, setAiFirstFrameMs] = useState(0);
  const [aiSubmitted, setAiSubmitted] = useState(false);
  const [aiCurrentSec, setAiCurrentSec] = useState(0);
  const [aiSinceFirstSec, setAiSinceFirstSec] = useState(0);
  const [imageDoneList, setImageDoneList] = useState<{ index: number; status: string; title: string }[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const aiContentRef = useRef("");
  const stageRef = useRef<typeof stage>("idle");

  // 保持 stageRef 与 stage 同步，供 onerror 闭包读取最新值
  useEffect(function () { stageRef.current = stage; }, [stage]);

  // 预览
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "markdown">("image");
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewTags, setPreviewTags] = useState<string[]>([]);
  const [previewBatchId, setPreviewBatchId] = useState<string | number>("");

  useEffect(function () { setRecentProjects(loadRecentProjects()); }, []);

  // 页面加载时 fire-and-forget 触发后台工作进程，捡起上次关闭页面时遗留的任务（断点续跑）
  useEffect(function () {
    fetch("/api/process-queue").catch(function () {});
  }, []);

  // 关闭时清理 SSE
  useEffect(function () {
    return function () { if (esRef.current) esRef.current.close(); };
  }, []);

  const addLog = useCallback(function (type: LogLine["type"], text: string) {
    setLogs(function (prev) { return prev.concat([{ type: type, text: text, ts: Date.now() }]); });
  }, []);

  // ============ 客户端预压缩 ============
  async function compressImageClient(file: File, maxWidth = 1600, quality = 0.8): Promise<File> {
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

  const handleFileChange = useCallback(function (e: React.ChangeEvent<HTMLInputElement>) {
    var selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;
    var newItems: FileItem[] = [];
    var loadedCount = 0;
    selectedFiles.forEach(async function (file, index) {
      var fileToUse = file;
      if (file.type !== "image/jpeg" || file.size > 200 * 1024) {
        try { fileToUse = await compressImageClient(file); } catch (_) {}
      }
      var reader = new FileReader();
      reader.onload = function (event) {
        newItems[index] = { file: fileToUse, preview: (event.target?.result as string) || "", spaceNames: [] };
        loadedCount++;
        if (loadedCount === selectedFiles.length) {
          setFileItems(function (prev) { return prev.concat(newItems); });
          e.target.value = "";
        }
      };
      reader.readAsDataURL(fileToUse);
    });
  }, []);

  const removeFile = useCallback(function (index: number) {
    setFileItems(function (prev) { return prev.filter(function (_, i) { return i !== index; }); });
  }, []);

  const updateSpaceNames = useCallback(function (index: number, names: string[]) {
    setFileItems(function (prev) {
      return prev.map(function (item, i) { return i === index ? { ...item, spaceNames: names } : item; });
    });
  }, []);

  const togglePreset = useCallback(function (index: number, preset: string) {
    setFileItems(function (prev) {
      var item = prev[index]; if (!item) return prev;
      var exists = item.spaceNames.includes(preset);
      var newNames = exists ? item.spaceNames.filter(function (n) { return n !== preset; }) : item.spaceNames.concat([preset]);
      return prev.map(function (it, i) { return i === index ? { ...it, spaceNames: newNames } : it; });
    });
  }, []);

  // ============ 打开 SSE 流 ============
  const openStream = useCallback(function (jobId: string, count: number) {
    setStage("streaming");
    setTotalImages(count);
    setLogs([]);
    setCompressList([]);
    setAiContent("");
    aiContentRef.current = "";
    setAiFirstFrameMs(0);
    setAiSubmitted(false);
    setAiCurrentSec(0);
    setAiSinceFirstSec(0);
    setImageDoneList([]);

    addLog("info", "已建立实时连接，开始处理 " + count + " 张图片");

    var es = new EventSource("/api/process-stream?jobId=" + jobId);
    esRef.current = es;

    es.addEventListener("stage", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      if (d.stage === "downloading") addLog("info", "⬇ 下载图片 " + d.index + "/" + d.total);
      else if (d.stage === "compressing") addLog("info", "🗜 压缩图片 " + d.index + "/" + d.total + " ...");
      else if (d.stage === "resuming") addLog("info", "♻ 断点续跑：复用已压缩图片 " + d.index + "/" + d.total);
      else if (d.stage === "compress_failed") addLog("error", "压缩失败 " + d.index + "：" + d.error);
      else if (d.stage === "skip") addLog("warn", "跳过图片 " + d.index + "：" + d.reason);
      else if (d.stage === "ai_resumed") addLog("info", "♻ 断点续跑：复用已保存的 AI 结果，跳过调用");
    });

    es.addEventListener("compressed", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      setCompressList(function (prev) { return prev.concat([{ index: d.index, originalSize: d.originalSize, compressedSize: d.compressedSize, sharp: !!d.sharp }]); });
      // 压缩在浏览器上传前完成，服务端只报告最终尺寸
      if (d.sharp) {
        addLog("ok", "✓ 图片 " + d.index + " " + formatBytes(d.originalSize) + " → " + formatBytes(d.compressedSize));
      } else {
        addLog("ok", "✓ 图片 " + d.index + " 就绪 " + formatBytes(d.compressedSize));
      }
    });

    es.addEventListener("ai_submit", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      setAiSubmitted(true);
      setAiCurrentSec(0);
      addLog("info", "🤖 提交 AI 分析（" + d.totalImages + " 张，payload " + formatBytes(d.payloadBytes) + "，模型 " + (d.model || "?") + "）");
    });

    es.addEventListener("first_frame", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      setAiFirstFrameMs(d.elapsedMs);
      addLog("ok", "✓ AI 首帧已到达（" + (d.elapsedMs / 1000).toFixed(1) + "s）");
    });

    es.addEventListener("content", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      aiContentRef.current += d.chunk;
      setAiContent(aiContentRef.current);
    });

    es.addEventListener("tail_wait", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      setAiCurrentSec(d.elapsedSec);
      setAiSinceFirstSec(d.sinceFirstSec);
    });

    es.addEventListener("image_done", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      setImageDoneList(function (prev) { return prev.concat([{ index: d.index, status: d.status, title: d.title || "" }]); });
      if (d.status === "success") addLog("ok", "✓ 图 " + d.index + " 完成：" + d.title);
      else addLog("error", "✗ 图 " + d.index + " 失败：" + d.error);
    });

    es.addEventListener("complete", function (e: MessageEvent) {
      var d = JSON.parse(e.data);
      addLog("ok", "🎉 全部完成");
      setResults(d.results || []);
      setStage("completed");
      es.close();
    });

    es.addEventListener("fatal", function (e: MessageEvent) {
      try { var d = JSON.parse(e.data); addLog("error", "❌ " + (d.message || "处理失败")); } catch (_) {}
      setStage("failed");
      es.close();
    });

    // EventSource 原生 error（连接断开/服务端 500/被杀）。完成/失败事件已主动 close。
    // 用 ref 追踪当前 stage，避免闭包捕获旧值。
    es.onerror = function () {
      if (stageRef.current === "streaming") {
        addLog("warn", "连接中断，任务转入后台继续，稍后可在此页或管理后台查看结果");
        setStage("failed");
      }
      try { es.close(); } catch (_) {}
    };
  }, [addLog]);

  // ============ 上传（XHR 进度） ============
  const handleUpload = useCallback(function (mode: "batch" | "individual") {
    if (fileItems.length === 0) return;
    setLoading(true);
    setResults([]);
    setStage("uploading");
    setUploadProgress(0);

    if (projectName) { saveRecentProject(projectName); setRecentProjects(loadRecentProjects()); }

    var formData = new FormData();
    for (var i = 0; i < fileItems.length; i++) {
      formData.append("files", fileItems[i].file);
      formData.append("spaceNames", JSON.stringify(fileItems[i].spaceNames));
    }
    formData.append("mode", mode);
    formData.append("projectName", projectName);

    var xhr = new XMLHttpRequest();
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = function () {
      setLoading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data.success) {
            setFileItems([]);
            openStream(data.jobId, data.fileCount || 0);
          } else {
            addLog("error", "上传失败: " + (data.error || "未知错误"));
            setStage("failed");
          }
        } catch (_) { addLog("error", "上传失败: 响应解析错误"); setStage("failed"); }
      } else { addLog("error", "上传失败: HTTP " + xhr.status); setStage("failed"); }
    };
    xhr.onerror = function () { setLoading(false); addLog("error", "上传失败，请检查网络"); setStage("failed"); };
    xhr.open("POST", "/api/upload");
    xhr.send(formData);
  }, [fileItems, projectName, openStream, addLog]);

  const openPreview = useCallback(function (url: string, type: "image" | "markdown", title: string, tags?: string[], batchId?: string | number) {
    setPreviewUrl(url); setPreviewType(type); setPreviewTitle(title);
    setPreviewTags(tags || []); setPreviewBatchId(batchId || "");
  }, []);
  const closePreview = useCallback(function () { setPreviewUrl(null); }, []);

  var canUpload = fileItems.length > 0 && !loading && stage !== "streaming";
  var isLive = stage === "streaming";

  // 进度百分比
  var progressPct = 0;
  if (stage === "uploading") progressPct = uploadProgress;
  else if (stage === "streaming" && totalImages > 0) {
    var compressDone = compressList.length;
    var imageDone = imageDoneList.length;
    // 阶段权重：压缩占 40%，AI 占 40%，逐图写占 20%
    progressPct = Math.min(99, Math.round(compressDone / totalImages * 40 + (aiContent ? 40 : (aiSubmitted ? 20 : 0)) + imageDone / totalImages * 20));
  } else if (stage === "completed") progressPct = 100;

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold">上传图片</h1>
            <div className="flex gap-2">
              <a href="/" className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors">返回首页</a>
              <a href="/admin" className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">管理后台</a>
            </div>
          </div>

          {/* 项目名称 */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">项目名称（可选）</label>
            <input type="text" placeholder="输入项目名称" value={projectName}
              onChange={function (e) { setProjectName(e.target.value); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {recentProjects.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {recentProjects.map(function (name) {
                  return <button key={name} type="button" onClick={function () { setProjectName(name); }}
                    className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition-colors">{name}</button>;
                })}
                <span className="text-xs text-gray-400 self-center ml-1">最近使用</span>
              </div>
            )}
          </div>

          {/* 文件选择 */}
          <div className="mb-4">
            <label className="block mb-2 font-medium">选择图片文件</label>
            <input type="file" accept="image/*" multiple onChange={handleFileChange}
              className="w-full p-2 border border-gray-300 rounded-lg" />
            <p className="text-xs text-gray-400 mt-1">可同时选择多张图片。处理过程实时反馈，关闭页面会转入后台继续。</p>
          </div>

          {/* 上传按钮 */}
          <div className="flex gap-3">
            <button onClick={function () { handleUpload("individual"); }} disabled={!canUpload}
              className={"flex-1 py-3 rounded-lg font-medium transition-colors " + (!canUpload ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-blue-500 text-white hover:bg-blue-600")}>
              分张分析上传
            </button>
            <button onClick={function () { handleUpload("batch"); }} disabled={!canUpload}
              className={"flex-1 py-3 rounded-lg font-medium transition-colors " + (!canUpload ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-green-500 text-white hover:bg-green-600")}>
              批量分析上传
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">「分张」每张图分别分析、「批量」所有图一次分析</p>
        </div>

        {/* ===== 实时处理面板 ===== */}
        {(stage !== "idle") && (
          <div className={"bg-white rounded-lg shadow-md p-6 mb-6 border-l-4 " + (
            stage === "completed" ? "border-green-500" : stage === "failed" ? "border-red-500" : "border-blue-500"
          )}>
            {/* 顶部状态 + 进度条 */}
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-bold text-lg">
                {stage === "uploading" && "⏳ 上传文件中..."}
                {stage === "streaming" && (isLive ? "🔄 处理中" : "")}
                {stage === "completed" && "✅ 处理完成"}
                {stage === "failed" && "⚠️ 处理中断（已转入后台）"}
              </h2>
              {stage === "streaming" && totalImages > 0 && (
                <span className="text-sm text-gray-500">{imageDoneList.length}/{totalImages} 张完成</span>
              )}
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5 mb-3">
              <div className={"h-2.5 rounded-full transition-all duration-300 " + (
                stage === "failed" ? "bg-red-400" : stage === "completed" ? "bg-green-500" : "bg-blue-500"
              )} style={{ width: progressPct + "%" }} />
            </div>

            {/* 上传阶段进度 */}
            {stage === "uploading" && <p className="text-xs text-gray-500">{uploadProgress}% 已上传</p>}

            {/* 实时日志 */}
            {(stage === "streaming" || stage === "completed" || stage === "failed") && logs.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-gray-600 mb-1">实时日志</p>
                <div className="bg-gray-900 rounded-lg p-3 max-h-44 overflow-y-auto font-mono text-xs space-y-0.5">
                  {logs.map(function (log, i) {
                    var color = log.type === "ok" ? "text-green-400" : log.type === "warn" ? "text-yellow-400" : log.type === "error" ? "text-red-400" : "text-gray-300";
                    return <div key={i} className={color}>{log.text}</div>;
                  })}
                </div>
              </div>
            )}

            {/* AI 实时状态 */}
            {stage === "streaming" && aiSubmitted && (
              <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-amber-800">🤖 AI 分析</span>
                  <span className="text-xs text-amber-700">
                    {aiFirstFrameMs > 0 ? "首帧 " + (aiFirstFrameMs / 1000).toFixed(1) + "s · 已等待 " + aiCurrentSec + "s（首帧后 " + aiSinceFirstSec + "s）" : "等待首帧... " + aiCurrentSec + "s"}
                  </span>
                </div>
                {aiContent && (
                  <pre className="bg-gray-900 text-gray-200 rounded p-2 text-xs max-h-40 overflow-auto whitespace-pre-wrap break-all mt-1">{aiContent.slice(-1500)}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* 文件列表 */}
        {fileItems.length > 0 && (
          <div className="space-y-4">
            {fileItems.map(function (item, index) {
              return (
                <div key={index} className="bg-white rounded-lg shadow-md p-4">
                  <div className="flex gap-4">
                    <div className="w-28 h-28 flex-shrink-0">
                      <img src={item.preview} alt={item.file.name} className="w-full h-full object-cover rounded-lg border border-gray-200" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-500 mb-2 truncate">{item.file.name}</p>
                      <label className="block text-sm font-medium mb-1">空间名称</label>
                      <input type="text" placeholder="点击预设标签选择" value={item.spaceNames.join("、")}
                        onChange={function (e) { updateSpaceNames(index, e.target.value.split("、").map(function (s) { return s.trim(); }).filter(Boolean)); }}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {PRESET_SPACES.map(function (preset) {
                          return <button key={preset} type="button" onClick={function () { togglePreset(index, preset); }}
                            className={"px-2.5 py-1 text-xs rounded-full border transition-colors " + (item.spaceNames.includes(preset) ? "bg-blue-500 text-white border-blue-500" : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-blue-50 hover:border-blue-300")}>{preset}</button>;
                        })}
                      </div>
                    </div>
                    <button onClick={function () { removeFile(index); }}
                      className="flex-shrink-0 self-start w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors" title="移除此图片">✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 处理结果 */}
        {results.length > 0 && (
          <div className="mt-6 space-y-4">
            <h2 className="text-xl font-bold">处理结果（{results.length} 张）</h2>
            {results.map(function (result, index) {
              var spaceLabel = result.spaceNames && result.spaceNames.length > 0 ? result.spaceNames.join("、") : "";
              return (
                <div key={index} className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h3 className="font-semibold text-green-800 mb-2">图片 {index + 1}{spaceLabel ? " — " + spaceLabel : ""}</h3>
                  <p className="mb-1"><strong>标题:</strong> {result.title}</p>
                  <p className="mb-1"><strong>关键词:</strong> {(result.tags || []).join(", ") || "无"}</p>
                  <div className="flex gap-2 mt-3">
                    <button onClick={function () { openPreview(result.mdUrl, "markdown", result.title || "分析总结"); }}
                      className="px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors">查看总结</button>
                    <button onClick={function () { openPreview(result.url, "image", result.title || "原图", result.tags); }}
                      className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors">查看原图</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {previewUrl && (
        <PreviewModal url={previewUrl} type={previewType} title={previewTitle} tags={previewTags} batchId={previewBatchId} onClose={closePreview} />
      )}
    </main>
  );
}
