import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig(),
  // OpenNext's build step delegates to the regular Next build, which generates
  // Prisma Client before typechecking and emits the standalone artifacts used
  // by the Docker/Render deployment too.
  buildCommand: "bun run build:standalone",
};
