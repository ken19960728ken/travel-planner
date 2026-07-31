import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // exceljs 是大型 CJS 套件，只在 server route 用寫入 API——顯式外部化避免 bundler 內聯進 server bundle
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
