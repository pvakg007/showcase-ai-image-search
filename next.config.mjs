/** @type {import('next').NextConfig} */
const nextConfig = {
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
