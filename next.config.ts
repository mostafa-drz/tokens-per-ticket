import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app reads tokens-per-ticket.yaml at request time. Make sure Vercel's
  // output tracing ships it with every route's function.
  outputFileTracingIncludes: {
    "/**": ["./tokens-per-ticket.yaml"],
  },
};

export default nextConfig;
