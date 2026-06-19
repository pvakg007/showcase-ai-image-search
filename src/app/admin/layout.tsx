/**
 * Admin 布局 — 仅用于导出 route segment config
 * 强制动态渲染，避免静态生成导致 404
 */
export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
