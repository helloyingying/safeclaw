import assert from "node:assert/strict";
import test from "node:test";

import { inferSensitivityLabels } from "../src/domain/services/sensitivity_label_inference.ts";
import type { SensitivePathRule } from "../src/types.ts";

test("inferSensitivityLabels marks credential stores from common filesystem paths", () => {
  const labels = inferSensitivityLabels(
    "filesystem",
    ["/Users/liuzhuangm4/.aws/credentials"],
    undefined,
  );

  assert(labels.assetLabels.includes("credential"));
  assert(labels.dataLabels.includes("secret"));
});

test("inferSensitivityLabels marks browser profile and secret stores from filesystem paths", () => {
  const labels = inferSensitivityLabels(
    "filesystem",
    ["/Users/liuzhuangm4/Library/Application Support/Google/Chrome/Default/Cookies"],
    undefined,
  );

  assert(labels.assetLabels.includes("browser_profile"));
  assert(labels.assetLabels.includes("browser_secret_store"));
  assert(labels.dataLabels.includes("browser_secret"));
});

test("inferSensitivityLabels marks communication stores from local message history paths", () => {
  const labels = inferSensitivityLabels(
    "filesystem",
    ["/Users/liuzhuangm4/Library/Messages/chat.db"],
    undefined,
  );

  assert(labels.assetLabels.includes("communication_store"));
  assert(labels.dataLabels.includes("communications"));
});

test("inferSensitivityLabels marks download staging directories from path segments", () => {
  const labels = inferSensitivityLabels(
    "filesystem",
    ["/tmp/workspace/Downloads"],
    undefined,
  );

  assert(labels.assetLabels.includes("download_staging"));
});

test("inferSensitivityLabels marks personal content directories from user home paths", () => {
  const labels = inferSensitivityLabels(
    "filesystem",
    ["/Users/liuzhuangm4/Documents"],
    undefined,
  );

  assert(labels.assetLabels.includes("personal_content"));
});

test("inferSensitivityLabels supports runtime custom path rules", () => {
  const customRules: SensitivePathRule[] = [
    {
      id: "custom-finance-share",
      asset_label: "financial",
      match_type: "prefix",
      pattern: "/srv/finance",
      source: "custom"
    }
  ];

  const labels = inferSensitivityLabels(
    "filesystem",
    ["/srv/finance/quarterly-report.xlsx"],
    undefined,
    customRules,
  );

  assert(labels.assetLabels.includes("financial"));
});
