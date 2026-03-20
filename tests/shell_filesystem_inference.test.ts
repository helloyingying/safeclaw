import assert from "node:assert/strict";
import test from "node:test";

import { inferShellFilesystemSemantic } from "../src/domain/services/shell_filesystem_inference.ts";

test("inferShellFilesystemSemantic classifies listing operations", () => {
  const semantic = inferShellFilesystemSemantic("find ~/Downloads -maxdepth 1 -type f", []);
  assert.deepEqual(semantic, { operation: "list", toolName: "filesystem.list" });
});

test("inferShellFilesystemSemantic classifies read/search operations", () => {
  const read = inferShellFilesystemSemantic("cat ~/.ssh/config", []);
  const search = inferShellFilesystemSemantic("rg -n token ./src", []);
  assert.deepEqual(read, { operation: "read", toolName: "filesystem.read" });
  assert.deepEqual(search, { operation: "search", toolName: "filesystem.search" });
});

test("inferShellFilesystemSemantic classifies write/delete/archive operations", () => {
  const write = inferShellFilesystemSemantic("echo hello > /tmp/demo.txt", []);
  const del = inferShellFilesystemSemantic("rm -rf /tmp/demo", []);
  const archive = inferShellFilesystemSemantic("tar -czf backup.tar.gz ./docs", []);
  assert.deepEqual(write, { operation: "write", toolName: "filesystem.write" });
  assert.deepEqual(del, { operation: "delete", toolName: "filesystem.delete" });
  assert.deepEqual(archive, { operation: "archive", toolName: "filesystem.archive" });
});

test("inferShellFilesystemSemantic treats extraction as write", () => {
  const extract = inferShellFilesystemSemantic("tar -xzf backup.tar.gz -C /tmp/restore", []);
  assert.deepEqual(extract, { operation: "write", toolName: "filesystem.write" });
});

test("inferShellFilesystemSemantic falls back to read when path-only context exists", () => {
  const semantic = inferShellFilesystemSemantic("custom-tool --inspect", ["/Users/liuzhuangm4/Downloads"]);
  assert.deepEqual(semantic, { operation: "read", toolName: "filesystem.read" });
});

test("inferShellFilesystemSemantic returns undefined for non-filesystem shell commands", () => {
  const semantic = inferShellFilesystemSemantic("sleep 1", []);
  assert.equal(semantic, undefined);
});

test("inferShellFilesystemSemantic ignores heredoc body operators and falls back to read", () => {
  const semantic = inferShellFilesystemSemantic(
    [
      "python3 - <<'PY'",
      "depth = 3",
      "max_depth = 2",
      "if depth>max_depth:",
      "    print('skip')",
      "PY",
    ].join("\n"),
    ["/Users/liuzhuangm4/.openclaw"],
  );
  assert.deepEqual(semantic, { operation: "read", toolName: "filesystem.read" });
});
