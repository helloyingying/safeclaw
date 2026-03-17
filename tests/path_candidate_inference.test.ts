import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractEmbeddedPathCandidates,
  resolvePathCandidate,
} from "../src/domain/services/path_candidate_inference.ts";

test("extractEmbeddedPathCandidates finds quoted $HOME shell paths", () => {
  const candidates = extractEmbeddedPathCandidates(
    "find \"$HOME/Downloads\" -maxdepth 1 -type f ! -name '.*' -print | head -n 1",
  );

  assert.deepEqual(candidates, ["$HOME/Downloads"]);
});

test("extractEmbeddedPathCandidates finds assigned braced env paths", () => {
  const candidates = extractEmbeddedPathCandidates("--path=\"${HOME}/.ssh/config\" --output=/tmp/result.txt");

  assert.deepEqual(candidates, ["${HOME}/.ssh/config", "/tmp/result.txt"]);
});

test("resolvePathCandidate expands shell environment variables", () => {
  assert.equal(resolvePathCandidate("$HOME/Downloads"), path.join(os.homedir(), "Downloads"));
  assert.equal(resolvePathCandidate("${HOME}/.ssh/config"), path.join(os.homedir(), ".ssh/config"));
});
