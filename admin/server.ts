import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAdminServer } from "../src/admin/server_app.ts";

export { startAdminServer } from "../src/admin/server_app.ts";

const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryFile && entryFile === thisFile) {
  void startAdminServer().catch((error) => {
    console.error(`SecurityClaw admin startup failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
