const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageDir = path.join(root, "node_modules", "@shiguredo", "rnnoise-wasm");
const dependency = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
if (dependency.version !== "2025.1.5") {
  throw new Error("The RNNoise adapter must be reviewed before changing the pinned WASM build.");
}

// The dependency embeds WASM in a window-only JS loader. Extract the unchanged
// binary at build time so our AudioWorklet can instantiate it without that loader.
const source = fs.readFileSync(path.join(packageDir, "dist", "rnnoise.js"), "utf8");
const encoded = source.match(/return FA\("([A-Za-z0-9+/=]+)"\);/);
if (!encoded) throw new Error("Could not locate the pinned RNNoise WASM binary.");
const binary = Buffer.from(encoded[1], "base64");
const module_ = new WebAssembly.Module(binary);
const imports = WebAssembly.Module.imports(module_).map(({ module, name, kind }) => `${module}.${name}:${kind}`).sort();
const expectedImports = [
  "env.__assert_fail:function", "env.emscripten_resize_heap:function", "wasi_snapshot_preview1.fd_write:function"
];
if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
  throw new Error("RNNoise WASM imports changed; update the worklet adapter first.");
}
const exported = new Set(WebAssembly.Module.exports(module_).map(({ name }) => name));
for (const name of ["memory", "emscripten_stack_init", "__wasm_call_ctors", "rnnoise_get_frame_size", "rnnoise_create", "rnnoise_process_frame", "rnnoise_destroy", "malloc", "free"]) {
  if (!exported.has(name)) throw new Error(`RNNoise WASM is missing ${name}.`);
}

const destination = path.join(root, "audio", "vendor");
fs.mkdirSync(destination, { recursive: true });
const target = path.join(destination, "rnnoise.wasm");
if (!fs.existsSync(target) || !fs.readFileSync(target).equals(binary)) fs.writeFileSync(target, binary);
console.log(`Prepared local RNNoise model (${binary.length} bytes).`);
