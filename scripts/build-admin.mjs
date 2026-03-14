import { build } from "esbuild";

await build({
  entryPoints: ["admin/src/app.jsx"],
  outfile: "admin/public/app.js",
  bundle: true,
  format: "esm",
  target: ["es2022"],
  sourcemap: false,
  minify: true,
  define: {
    "process.env.NODE_ENV": "\"production\""
  }
});
