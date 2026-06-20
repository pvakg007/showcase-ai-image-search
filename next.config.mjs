/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp 是原生二进制模块（libvips），必须外部化才能在 Vercel serverless 上正确加载。
  // 否则 Next.js 会把它打进 bundle，二进制丢失 → require('sharp') 失败 → 图片不压缩 → AI 超时。
  experimental: {
    serverComponentsExternalPackages: ["sharp"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.cos.**.myqcloud.com",
      },
      {
        protocol: "https",
        hostname: "*.cos.*.myqcloud.com",
      },
    ],
  },
};

export default nextConfig;
