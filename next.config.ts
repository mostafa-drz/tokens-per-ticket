import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app reads ticket-contract.yaml at request time. Make sure Vercel's
  // output tracing ships it with every route's function.
  outputFileTracingIncludes: {
    "/**": ["./ticket-contract.yaml"],
  },
};

export default nextConfig;
