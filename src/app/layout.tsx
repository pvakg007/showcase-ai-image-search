import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 设计资料库",
  description: "AI 驱动的软装设计图片搜索与管理平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
