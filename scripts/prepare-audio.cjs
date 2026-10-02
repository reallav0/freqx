const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const directory = path.join(root, "audio", "vendor", "deepfilter");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
if (manifest.upstream.commit !== "1695a9b3282e20515ab08eb97c83520f20d23138") {
  throw new Error("Review the DeepFilterNet worklet adapter before updating its pinned engine.");
}
for (const name of ["dfn3.wasm", "dfn3_weights.bin"]) {
  const binary = fs.readFileSync(path.join(directory, name));
  const expected = manifest.files[name];
  const hash = crypto.createHash("sha256").update(binary).digest("hex");
  if (!expected || binary.length !== expected.bytes || hash !== expected.sha256) {
    throw new Error("Packaged DeepFilterNet asset failed integrity validation: " + name);
  }
}
const module_ = new WebAssembly.Module(fs.readFileSync(path.join(directory, "dfn3.wasm")));
const imports = WebAssembly.Module.imports(module_).map(({ module, name, kind }) => module + "." + name + ":" + kind).sort();
const expectedImports = ["fd_close", "fd_seek", "fd_write"].map(name => "wasi_snapshot_preview1." + name + ":function");
if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
  throw new Error("DeepFilterNet WASM imports changed; review the worklet adapter.");
}
const exported = new Set(WebAssembly.Module.exports(module_).map(({ name }) => name));
for (const name of ["memory", "malloc", "free", "dfn3_wasm_create", "dfn3_wasm_destroy", "dfn3_wasm_process", "dfn3_wasm_get_input_ptr", "dfn3_wasm_get_output_ptr", "dfn3_wasm_get_input_size", "dfn3_wasm_get_output_size", "dfn3_wasm_set_atten_lim", "dfn3_wasm_set_post_filter_beta", "dfn3_wasm_set_input_agc", "dfn3_wasm_set_output_agc", "dfn3_wasm_set_hpf"]) {
  if (!exported.has(name)) throw new Error("DeepFilterNet WASM is missing " + name);
}
console.log("Verified packaged DeepFilterNet3 SIMD engine and local model. No download or runtime compiler required.");
const aecDirectory = path.join(root, 'audio/vendor/aec3');
const aecManifest = JSON.parse(fs.readFileSync(path.join(aecDirectory, 'manifest.json'), 'utf8'));
if (aecManifest.upstream.commit !== 'e1d663e86f2ab03269b9ae873af38d0103c4df3d') throw new Error('Review the AEC3 ABI before updating the pinned engine.');
const aecBinary = fs.readFileSync(path.join(aecDirectory, 'aec3.wasm'));
if (aecBinary.length !== aecManifest.files['aec3.wasm'].bytes || crypto.createHash('sha256').update(aecBinary).digest('hex') !== aecManifest.files['aec3.wasm'].sha256) throw new Error('AEC3 integrity validation failed.');
const aecModule = new WebAssembly.Module(aecBinary);
const aecImports = WebAssembly.Module.imports(aecModule).map(i => i.module + '.' + i.name + ':' + i.kind).sort();
if (JSON.stringify(aecImports) !== JSON.stringify(['a.a:memory', 'a.b:function', 'a.c:function', 'a.d:function', 'a.e:function', 'a.f:function', 'a.g:function'])) throw new Error('AEC3 imports changed.');
for (const name of 'hijklmnopqrstuvwxyzAB') if (!WebAssembly.Module.exports(aecModule).some(e => e.name === name && e.kind === 'function')) throw new Error('Missing AEC3 export: ' + name);
console.log('Verified pinned WebRTC AEC3 engine.');
require('./prepare-loopback.cjs');
