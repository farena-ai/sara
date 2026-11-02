// Phase 126 (docs/design/WAKE.md §3.1 W1, §4.2): the Hey Sara pack, pinned. Every file a device uses is
// listed one by one with its size and SHA-256 (measured from the upstream sherpa-onnx v1.13.8 and
// kws-models release assets on 2026-11-02); the apps carry a copy of these numbers (desktop/windows
// wake.cpp, android Wake.java) and check every file before it is used, on every load. The engine is
// downloaded only where that is allowed (Windows, Linux); on Android it is part of the signed app
// (Google Play forbids downloaded native code) and only the model is downloaded.
//
// Where the files come from: the mirror (Sara's own `wake-pack-1` release assets and
// backstagecoding.com/sara/wake/1/, byte-identical copies), or, until the mirror is up, the upstream
// tarballs themselves (also pinned) unpacked with the system tar (Windows' tar.exe reads .tar.bz2).

export const WAKE_PACK_VERSION = 'wake-pack-1';
export const SHERPA_VERSION = 'v1.13.8';
const UP = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const MODEL_DIR = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';

export interface PackFile {
  /** The name on the device (in the pack folder). */
  name: string;
  size: number;
  sha256: string;
  /** Where it sits inside the upstream tarball. */
  inTar: string;
  tar: 'model' | 'engine';
}
export interface PackEntry {
  platform: 'windows' | 'android' | 'linux' | 'mac';
  arch: string;
  files: PackFile[];
  /** The upstream tarballs these files are in (pinned), for devices that unpack (Windows). */
  tars: Partial<Record<'model' | 'engine', { url: string; size: number; sha256: string }>>;
  /** Total bytes the device downloads (the tarballs where it unpacks them, else the files). */
  download: number;
}

/** The model (5.4 MB on the device): the int8 encoder and joiner, chunk 16 (320 ms), one thread. */
export const MODEL_FILES: PackFile[] = [
  { name: 'encoder.int8.onnx', size: 4_599_656, sha256: '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48', inTar: `${MODEL_DIR}/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx`, tar: 'model' },
  { name: 'decoder.onnx', size: 759_829, sha256: '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21', inTar: `${MODEL_DIR}/decoder-epoch-13-avg-2-chunk-16-left-64.onnx`, tar: 'model' },
  { name: 'joiner.int8.onnx', size: 86_629, sha256: '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1', inTar: `${MODEL_DIR}/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx`, tar: 'model' },
  { name: 'tokens.txt', size: 1_928, sha256: '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0', inTar: `${MODEL_DIR}/tokens.txt`, tar: 'model' },
];
export const MODEL_TAR = { url: `${UP}/kws-models/${MODEL_DIR}.tar.bz2`, size: 32_885_699, sha256: '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6' };

/** The English lexicon (server only, for custom phrases; §5.8). */
export const LEXICON = { name: 'en.phone', size: 3_330_061, sha256: 'f7000ec3a90544c0c7c16090d8951779c2b322e14dad5006290f498567d439ea', inTar: `${MODEL_DIR}/en.phone`, tar: MODEL_TAR };

const WIN_X64 = 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts';
const WIN_ARM64 = 'sherpa-onnx-v1.13.8-win-arm64-shared-MD-Release-no-tts';

export const WAKE_PACKS: PackEntry[] = [
  {
    platform: 'windows',
    arch: 'x64',
    files: [
      ...MODEL_FILES,
      { name: 'sherpa-onnx-c-api.dll', size: 2_882_048, sha256: '5616605dc07ffbcf1cd6a001c2c76e826b9e1710e0fe17dfc3412de3a28df6a5', inTar: `${WIN_X64}/lib/sherpa-onnx-c-api.dll`, tar: 'engine' },
      { name: 'onnxruntime.dll', size: 17_136_128, sha256: '422d776ab0e3218260f7f628fcb84606aaa5c21116f720c8619a6da5e0b2e0f9', inTar: `${WIN_X64}/lib/onnxruntime.dll`, tar: 'engine' },
      { name: 'onnxruntime_providers_shared.dll', size: 10_752, sha256: '0190137dee4933261c065c5d030c3568a68c7aa43cad942b4726a07011738bc2', inTar: `${WIN_X64}/lib/onnxruntime_providers_shared.dll`, tar: 'engine' },
    ],
    tars: { model: MODEL_TAR, engine: { url: `${UP}/${SHERPA_VERSION}/${WIN_X64}.tar.bz2`, size: 19_164_933, sha256: '876e6b89b8cf84a3a1b375a397507f2cfe9c227c2a945411a11a668475fcb5d3' } },
    download: 32_885_699 + 19_164_933,
  },
  {
    platform: 'windows',
    arch: 'arm64',
    files: [...MODEL_FILES],
    // The arm64 engine files are pinned when the arm64 build is tested (owner check); until then x64 only.
    tars: { model: MODEL_TAR, engine: { url: `${UP}/${SHERPA_VERSION}/${WIN_ARM64}.tar.bz2`, size: 18_407_595, sha256: '39446be8a2a933308bb0b4b7a77fd21fdffaa68d3d73fc6f1e63634bb42d9cca' } },
    download: 32_885_699 + 18_407_595,
  },
  // Android: the engine is in the APK (jniLibs from sherpa-onnx-v1.13.8-android.tar.bz2, SHA-256
  // 2ff63469…4f44, checked by android/fetch-wake-libs.sh at build time); the model is downloaded.
  { platform: 'android', arch: 'any', files: [...MODEL_FILES], tars: {}, download: MODEL_FILES.reduce((n, f) => n + f.size, 0) },
];

/** The pack entry for a device (undefined: no pack for it in this release). */
export function packFor(platform: string, arch = 'x64'): PackEntry | undefined {
  return WAKE_PACKS.find((p) => p.platform === platform && (p.arch === arch || p.arch === 'any')) ?? (platform === 'windows' ? WAKE_PACKS[0] : undefined);
}

/** The files mirrored as `wake-pack-1/<name>` (release assets + backstagecoding.com/sara/wake/1/). */
export const MIRRORS = ['https://github.com/farena-ai/sara/releases/download/wake-pack-1/', 'https://backstagecoding.com/sara/wake/1/'];

export const PACK_LICENCE = 'sherpa-onnx (k2-fsa), Apache-2.0; keyword model sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, Apache-2.0 (ModelScope pkufool/icefall-kws-zipformer-zh-en-3M-2025-12-20, licence confirmed by the maintainers in k2-fsa/sherpa-onnx#3802).';
