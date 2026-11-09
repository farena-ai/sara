// Phase 126 (docs/design/WAKE.md §3.1 W1, §4.2): the Hey Sara pack, pinned. Every file a device uses is
// listed one by one with its size and SHA-256 (measured from the upstream sherpa-onnx v1.13.8 and
// kws-models release assets on 2026-11-02); the apps carry a copy of these numbers (desktop/windows
// wake.cpp, android Wake.java) and check every file before it is used, on every load. The engine is
// downloaded only where that is allowed (Windows, Linux); on Android and the Mac it is part of the
// signed app (Google Play forbids downloaded native code; the Mac's hardened runtime won't load an
// unsigned library) and only the model is downloaded.
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
export const LINUX_X64 = 'sherpa-onnx-v1.13.8-linux-x64-shared-no-tts';

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
  // C17 Linux x64: `sara wake` runs upstream's ALSA keyword spotter (PipeWire and PulseAudio serve
  // ALSA's "default" device) beside onnxruntime; both from the pinned no-TTS shared build.
  {
    platform: 'linux',
    arch: 'x64',
    files: [
      ...MODEL_FILES,
      { name: 'sherpa-onnx-keyword-spotter-alsa', size: 799_200, sha256: 'b546b1aab7ddb548e737beb9e84fb1edf26a0427cdf817431bbc5cda5f8230d3', inTar: `${LINUX_X64}/bin/sherpa-onnx-keyword-spotter-alsa`, tar: 'engine' },
      { name: 'libonnxruntime.so', size: 27_026_609, sha256: '4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e', inTar: `${LINUX_X64}/lib/libonnxruntime.so`, tar: 'engine' },
    ],
    tars: { model: MODEL_TAR, engine: { url: `${UP}/${SHERPA_VERSION}/${LINUX_X64}.tar.bz2`, size: 24_802_494, sha256: 'd0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc' } },
    download: 32_885_699 + 24_802_494,
  },
  // Mac and Android: the engine is inside the signed app (MAC_ENGINE / ANDROID_ENGINE below, checked
  // at build time); only the model is downloaded, from the pinned model tarball.
  { platform: 'mac', arch: 'any', files: [...MODEL_FILES], tars: { model: MODEL_TAR }, download: MODEL_TAR.size },
  { platform: 'android', arch: 'any', files: [...MODEL_FILES], tars: { model: MODEL_TAR }, download: MODEL_TAR.size },
];

/** C17: the Mac app bundles these (desktop/mac/build.sh, Contents/Frameworks, signed with the app). */
export const MAC_ENGINE = {
  tar: { url: `${UP}/${SHERPA_VERSION}/sherpa-onnx-v1.13.8-osx-universal2-shared-no-tts-lib.tar.bz2`, size: 17_827_519, sha256: 'bdcc7c266d355697584dd4efb9dc766e45e18e87cec1fc553002a32cfcfab9a7' },
  files: [
    { name: 'libsherpa-onnx-c-api.dylib', size: 6_276_720, sha256: '08d8c58693e00cb0f4f5b26eec87f5f124cbac946ddc651ed5c0a58d6e0ec721' },
    { name: 'libonnxruntime.dylib', size: 61_117_136, sha256: '0181c2458590a90540a64ec218a78c9a4879f55747349253e54fa97d0d8de7eb' },
  ],
};

/** C17: the Android app bundles these per ABI (android/fetch-wake-libs.sh → jniLibs, not committed). */
export const ANDROID_ENGINE = {
  tar: { url: `${UP}/${SHERPA_VERSION}/sherpa-onnx-v1.13.8-android.tar.bz2`, size: 46_093_321, sha256: '2ff63469a71cb6009aa2e3ed5f4a670f8abdcbe4bb9ffd23776afc792a6b4f44' },
  abis: {
    'arm64-v8a': [
      { name: 'libsherpa-onnx-c-api.so', size: 4_465_168, sha256: 'c85e2382e2ca12b0513826be926eaccfea896b4cbf568182e287671ba526f80d' },
      { name: 'libonnxruntime.so', size: 22_249_560, sha256: '33847ad43bffe204699fd4a27f7f3603452a8cdaf2f9a44983a0bc31ffcf2da1' },
    ],
    'armeabi-v7a': [
      { name: 'libsherpa-onnx-c-api.so', size: 3_202_700, sha256: '2294b9cc929ca0d22c5da52864ec8176f8fd119a739c9d594384763f6101d33f' },
      { name: 'libonnxruntime.so', size: 15_359_592, sha256: '7a8f17a707e52e0ac3a026be319272876d9eae61f4bb19585292772d785f7744' },
    ],
    x86_64: [
      { name: 'libsherpa-onnx-c-api.so', size: 4_927_096, sha256: '631ca2828e47b61d8afe4b3c75a157423cbafaba6f8c0db89c27d21f1b173d9a' },
      { name: 'libonnxruntime.so', size: 25_581_120, sha256: '087e84297cad64acb823c3d901d6e0cc934e91add7cdb20da802cd1c0bea5c3e' },
    ],
  } as Record<string, { name: string; size: number; sha256: string }[]>,
};

/** C17: sherpa-onnx's C header (c-api.h), the same in every v1.13.8 build; the apps compile against it. */
export const C_API_HEADER_SHA256 = '2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce';

/** The pack entry for a device (undefined: no pack for it in this release). */
export function packFor(platform: string, arch = 'x64'): PackEntry | undefined {
  return WAKE_PACKS.find((p) => p.platform === platform && (p.arch === arch || p.arch === 'any')) ?? (platform === 'windows' ? WAKE_PACKS[0] : undefined);
}

/** The files mirrored as `wake-pack-1/<name>` (release assets + backstagecoding.com/sara/wake/1/). */
export const MIRRORS = ['https://github.com/farena-ai/sara/releases/download/wake-pack-1/', 'https://backstagecoding.com/sara/wake/1/'];

export const PACK_LICENCE = 'sherpa-onnx (k2-fsa), Apache-2.0; keyword model sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, Apache-2.0 (ModelScope pkufool/icefall-kws-zipformer-zh-en-3M-2025-12-20, licence confirmed by the maintainers in k2-fsa/sherpa-onnx#3802).';
