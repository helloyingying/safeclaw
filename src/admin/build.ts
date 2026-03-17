import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AdminBuildLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type AdminBuildPaths = {
  sourceDir: string;
  entryPoint: string;
  outfile: string;
};

type AdminBuildResult = {
  state: "built" | "skipped";
  paths: AdminBuildPaths;
};

type AdminBuildOptions = {
  force?: boolean;
  logger?: AdminBuildLogger;
  paths?: Partial<AdminBuildPaths>;
};

type GlobalWithSecurityClawAdminBuild = typeof globalThis & {
  __securityclawAdminBuildPromise?: Promise<AdminBuildResult>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function resolvePaths(overrides: Partial<AdminBuildPaths> = {}): AdminBuildPaths {
  return {
    sourceDir: overrides.sourceDir ?? path.resolve(ROOT, "admin/src"),
    entryPoint: overrides.entryPoint ?? path.resolve(ROOT, "admin/src/app.jsx"),
    outfile: overrides.outfile ?? path.resolve(ROOT, "admin/public/app.js")
  };
}

function newestMtimeMs(target: string): number | undefined {
  if (!existsSync(target)) {
    return undefined;
  }
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let newest = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const candidate = newestMtimeMs(path.join(target, entry.name));
    if (candidate !== undefined && candidate > newest) {
      newest = candidate;
    }
  }
  return newest || stat.mtimeMs;
}

export function shouldBuildAdminAssets(options: Pick<AdminBuildOptions, "paths"> = {}): boolean {
  const paths = resolvePaths(options.paths);
  if (!existsSync(paths.outfile)) {
    return true;
  }
  const sourceMtimeMs = newestMtimeMs(paths.sourceDir);
  if (sourceMtimeMs === undefined) {
    return false;
  }
  return sourceMtimeMs > statSync(paths.outfile).mtimeMs;
}

export async function ensureAdminAssetsBuilt(options: AdminBuildOptions = {}): Promise<AdminBuildResult> {
  const paths = resolvePaths(options.paths);
  if (!options.force && !shouldBuildAdminAssets({ paths })) {
    return { state: "skipped", paths };
  }
  if (!existsSync(paths.entryPoint)) {
    throw new Error(`SecurityClaw admin entry point not found: ${paths.entryPoint}`);
  }

  const state = globalThis as GlobalWithSecurityClawAdminBuild;
  if (state.__securityclawAdminBuildPromise) {
    return state.__securityclawAdminBuildPromise;
  }

  const logger = options.logger ?? {};
  mkdirSync(path.dirname(paths.outfile), { recursive: true });

  const promise = build({
    entryPoints: [paths.entryPoint],
    outfile: paths.outfile,
    bundle: true,
    format: "esm",
    target: ["es2022"],
    sourcemap: false,
    minify: true,
    define: {
      "process.env.NODE_ENV": "\"production\""
    }
  }).then(() => {
    logger.info?.(`SecurityClaw admin bundle rebuilt: ${paths.outfile}`);
    return { state: "built" as const, paths };
  }).catch((error) => {
    logger.warn?.(`SecurityClaw admin bundle build failed (${String(error)})`);
    throw error;
  }).finally(() => {
    delete state.__securityclawAdminBuildPromise;
  });

  state.__securityclawAdminBuildPromise = promise;
  return promise;
}
