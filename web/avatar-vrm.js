// A1 (docs/ops/A1_AVATAR_DESIGN.md → VRM route): a 3D model the owner brings (.vrm, VRM 0.x or 1.0),
// kept in this browser (IndexedDB, never uploaded) and drawn with three.js + @pixiv/three-vrm (MIT,
// vendored in web/vendor/three-vrm/, loaded only here, only when the model is chosen). The file is
// checked first (web/avatar-rig.js validateVrm: size, header, no outside links); glTF is data only.
// The rig drives it: blinks, mood and visemes through VRM expressions, gaze through look-at, breath on
// the chest, sway and tilt on the neck, arms lowered from the T-pose.
import { validateVrm, vrmMood, vrmVisemes, VRM_MAX_BYTES } from './avatar-rig.js';

const DB = 'sara-avatar';
const STORE = 'vrm';
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

/** Checks and keeps a chosen file. Returns the check result ({ ok, meta } or { ok:false, code, error }). */
export async function storeVrm(file) {
  if (file.size > VRM_MAX_BYTES) return validateVrm(new Uint8Array(0), { max: -1 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = validateVrm(bytes);
  if (!check.ok) return check;
  await tx('readwrite', (s) => s.put({ bytes, meta: check.meta, version: check.version, name: file.name, size: bytes.length, at: Date.now() }, 'model'));
  return check;
}
export const loadStoredVrm = () => tx('readonly', (s) => s.get('model')).catch(() => null);
export const removeStoredVrm = () => tx('readwrite', (s) => s.delete('model')).catch(() => undefined);

const loadThree = () => import('/vendor/three-vrm/sara-vrm.js');

export class VrmView {
  static async create(bytes) {
    const check = validateVrm(bytes);
    if (!check.ok) throw new Error(check.error);
    const T = await loadThree();
    const v = new VrmView();
    await v.#init(T, bytes);
    return v;
  }

  async #init(T, bytes) {
    this.T = T;
    const loader = new T.GLTFLoader();
    loader.register((parser) => new T.VRMLoaderPlugin(parser));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('This is not a VRM model (.vrm).');
    T.VRMUtils.removeUnnecessaryVertices?.(gltf.scene);
    T.VRMUtils.combineSkeletons?.(gltf.scene);
    T.VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    this.vrm = vrm;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'living-canvas living-vrm';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.scene = new T.Scene();
    this.scene.add(vrm.scene);
    const sun = new T.DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.6, 1.4, 1.2);
    this.scene.add(sun, new T.HemisphereLight(0xffffff, 0x445566, 0.75));
    this.camera = new T.PerspectiveCamera(22, 1, 0.05, 30);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const p = new T.Vector3();
    (head ?? vrm.scene).getWorldPosition(p);
    this.headPos = p.clone();
    this.target = new T.Object3D();
    this.scene.add(this.target);
    if (vrm.lookAt) vrm.lookAt.target = this.target;
    // Arms down from the T-pose (normalized bones: the same for VRM 0.x and 1.0).
    const bone = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    bone('leftUpperArm')?.rotation.set(0, 0, -1.2);
    bone('rightUpperArm')?.rotation.set(0, 0, 1.2);
    bone('leftLowerArm')?.rotation.set(0, -0.15, -0.1);
    bone('rightLowerArm')?.rotation.set(0, 0.15, 0.1);
    this.bones = { neck: bone('neck'), head: bone('head'), chest: bone('upperChest') ?? bone('chest'), spine: bone('spine') };
    this.size = { w: 0, h: 0 };
    this.frame({ w: 512, h: 512 });
    this.update(null, { dt: 0.016, mood: 'default', state: 'idle', still: true });
  }

  /** Head-and-shoulders framing for the mount's shape. */
  frame({ w, h }) {
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const p = this.headPos;
    const dist = w / h >= 1.2 ? 1.3 : 1.1;
    this.camera.position.set(p.x, p.y + 0.03, p.z + dist);
    this.camera.lookAt(p.x, p.y - 0.04, p.z);
    this.camera.updateProjectionMatrix();
  }

  mount(host, over) {
    this.host = host;
    this.over = over;
    host.append(this.canvas);
  }

  unmount() {
    this.canvas.remove();
    this.host = null;
  }

  /** One frame from the rig's output (web/avatar.js think()). */
  update(p, { dt, mood, still }) {
    const v = this.vrm;
    if (this.host) {
      const el = this.over ?? this.host;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w && h) {
        Object.assign(this.canvas.style, { left: `${this.over ? this.over.offsetLeft : 0}px`, top: `${this.over ? this.over.offsetTop : 0}px`, width: `${w}px`, height: `${h}px` });
        this.frame({ w: Math.round(w), h: Math.round(h) });
      }
    }
    const em = v.expressionManager;
    const q = p ?? { blink: 0, mix: null, tilt: 0, breath: 0, gazeX: 0, gazeY: 0, headX: 0, headY: 0 };
    if (em) {
      for (const [k, val] of Object.entries(vrmMood(mood))) em.setValue(k, val);
      em.setValue('blink', q.blink ?? 0);
      if (q.mix) for (const [k, val] of Object.entries(vrmVisemes(q.mix))) em.setValue(k, val);
      else for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) em.setValue(k, 0);
    }
    const b = this.bones;
    const deg = Math.PI / 180;
    if (b.neck) b.neck.rotation.set((q.headY ?? 0) * 4, (q.headX ?? 0) * 6, (q.tilt ?? 0) * deg);
    if (b.chest) b.chest.rotation.x = -(q.breath ?? 0) * 0.012;
    if (b.spine) b.spine.rotation.x = (q.breath ?? 0) * 0.006;
    // Gaze: a point in front of her face, moved by the rig's gaze.
    const h = this.headPos;
    this.target.position.set(h.x + (q.gazeX ?? 0) * 0.12, h.y - (q.gazeY ?? 0) * 0.08, h.z + 1);
    v.update(still ? 0 : dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** A still head shot (data URL) for the tiny mounts. */
  snapshot() {
    const keep = { ...this.size };
    this.frame({ w: 256, h: 256 });
    this.renderer.setClearColor(0x30333a, 1);
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/jpeg', 0.9);
    this.renderer.setClearColor(0x000000, 0);
    this.frame(keep.w ? keep : { w: 512, h: 512 });
    return url;
  }

  destroy() {
    this.unmount();
    this.T?.VRMUtils.deepDispose?.(this.vrm.scene);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
  }
}
