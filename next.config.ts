import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["jspdf", "jspdf-autotable", "docx", "@google-cloud/storage"],
  env: {
    NEXT_PUBLIC_APP_VERSION: "0.3.2",
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
