import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ---------- Basic scene ----------
const wrap = document.getElementById('canvas-wrap');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd6ec);
scene.fog = new THREE.Fog(0x9fd6ec, 25, 70);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.7, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
wrap.appendChild(renderer.domElement);

// ---------- Lighting ----------
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4b3a24, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
sun.position.set(20, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0015;
scene.add(sun);
scene.add(sun.target);

// simple ambient fill
scene.add(new THREE.AmbientLight(0xffffff, 0.25));

// ---------- Ground plane (invisible collider fallback below tiles) ----------
const groundGeo = new THREE.PlaneGeometry(500, 500);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x3f6b3f, roughness: 1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.55;
ground.receiveShadow = true;
scene.add(ground);

// ---------- Loading UI ----------
const manager = new THREE.LoadingManager();
manager.onProgress = (url, loaded, total) => {
  const pct = Math.round((loaded / total) * 100);
  const bar = document.getElementById('barInner');
  const pctEl = document.getElementById('loadPct');
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
};
manager.onLoad = () => {
  const el = document.getElementById('loading');
  if (el) {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 650);
  }
};

const loader = new GLTFLoader(manager);
const gltfCache = new Map();
const colliders = []; // simple bounding boxes for buildings/trees/rocks to block walking through

function loadModel(path) {
  if (gltfCache.has(path)) {
    return gltfCache.get(path).then(gltf => gltf.scene.clone(true));
  }
  const p = new Promise((resolve, reject) => {
    loader.load('assets/' + path, (gltf) => {
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          if (o.material) o.material.roughness = Math.min(o.material.roughness ?? 0.8, 0.85);
        }
      });
      resolve(gltf);
    }, undefined, reject);
  });
  gltfCache.set(path, p);
  return p.then(gltf => gltf.scene.clone(true));
}

// ---------- Load village layout ----------
const villageGroup = new THREE.Group();
scene.add(villageGroup);

fetch('village.json').then(r => r.json()).then(async (data) => {
  // Tiles first
  for (const t of data.tiles) {
    try {
      const model = await loadModel(t.file);
      model.position.set(t.x, t.y, t.z);
      model.rotation.y = THREE.MathUtils.degToRad(t.ry || 0);
      villageGroup.add(model);
    } catch (e) { console.warn('tile fail', t.file, e); }
  }
  // Objects (buildings, trees, props)
  for (const o of data.objects) {
    try {
      const model = await loadModel(o.file);
      model.position.set(o.x, o.y, o.z);
      model.rotation.y = THREE.MathUtils.degToRad(o.ry || 0);
      villageGroup.add(model);

      // register a rough collider for buildings & trees (skip flat props)
      const isBuilding = o.file.includes('buildings/');
      const isNature = o.file.includes('decoration/nature/tree') || o.file.includes('decoration/nature/hill') || o.file.includes('decoration/nature/mountain') || o.file.includes('decoration/nature/rock');
      if (isBuilding || isNature) {
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const radius = Math.max(size.x, size.z) * 0.42;
        if (radius > 0.15) {
          colliders.push({ x: o.x, z: o.z, r: radius });
        }
      }
    } catch (e) { console.warn('obj fail', o.file, e); }
  }
}).catch(err => {
  console.error('village.json load failed', err);
  const pctEl = document.getElementById('loadPct');
  if (pctEl) pctEl.textContent = 'Failed to load village.json';
});

// ---------- First person controller ----------
const controls = new PointerLockControls(camera, renderer.domElement);

const instructions = document.getElementById('instructions');
const startBtn = document.getElementById('startBtn');
const helpBtn = document.getElementById('helpBtn');
const isTouch = window.matchMedia('(pointer:coarse)').matches;

function beginExperience() {
  instructions.classList.add('hidden');
  if (!isTouch) {
    controls.lock();
  }
}
startBtn.addEventListener('click', beginExperience);
helpBtn.addEventListener('click', () => instructions.classList.remove('hidden'));

controls.addEventListener('lock', () => instructions.classList.add('hidden'));
controls.addEventListener('unlock', () => {
  if (!isTouch) instructions.classList.remove('hidden');
});

// re-open instructions with Esc handled automatically by browser (pointer unlock)

// ---------- Movement state ----------
const move = { forward: false, backward: false, left: false, right: false, run: false };
const velocity = new THREE.Vector3();
let canJump = true;
let verticalVelocity = 0;
const GRAVITY = 18;
const JUMP_SPEED = 6.2;
const EYE_HEIGHT = 1.7;
let onGround = true;

const keyMap = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.run = true;
  if (e.code === 'Space') { tryJump(); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.run = false;
});

function tryJump() {
  if (onGround) {
    verticalVelocity = JUMP_SPEED;
    onGround = false;
  }
}

// ---------- Mobile joystick ----------
const joyZone = document.getElementById('joyZone');
const joyBase = document.getElementById('joyBase');
const joyStick = document.getElementById('joyStick');
let joyActive = false;
let joyVec = { x: 0, y: 0 }; // -1..1
let joyTouchId = null;

function setJoyBase(x, y) {
  joyBase.style.left = (x - 55) + 'px';
  joyBase.style.top = (y - 55) + 'px';
  joyBase.style.display = 'block';
}

joyZone.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  joyTouchId = t.identifier;
  joyActive = true;
  setJoyBase(t.clientX, t.clientY);
  joyStick.style.left = '30px';
  joyStick.style.top = '30px';
  e.preventDefault();
}, { passive: false });

joyZone.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier !== joyTouchId) continue;
    const baseRect = joyBase.getBoundingClientRect();
    const cx = baseRect.left + 55;
    const cy = baseRect.top + 55;
    let dx = t.clientX - cx;
    let dy = t.clientY - cy;
    const maxR = 45;
    const dist = Math.min(Math.hypot(dx, dy), maxR);
    const angle = Math.atan2(dy, dx);
    const sx = Math.cos(angle) * dist;
    const sy = Math.sin(angle) * dist;
    joyStick.style.left = (30 + sx) + 'px';
    joyStick.style.top = (30 + sy) + 'px';
    joyVec.x = sx / maxR;
    joyVec.y = sy / maxR;
  }
  e.preventDefault();
}, { passive: false });

function endJoy(e) {
  for (const t of e.changedTouches) {
    if (t.identifier !== joyTouchId) continue;
    joyActive = false;
    joyTouchId = null;
    joyVec.x = 0; joyVec.y = 0;
    joyBase.style.display = 'none';
  }
}
joyZone.addEventListener('touchend', endJoy, { passive: false });
joyZone.addEventListener('touchcancel', endJoy, { passive: false });

// ---------- Mobile look (drag on right side = 360 view) ----------
const lookZone = document.getElementById('lookZone');
let lookTouchId = null;
let lastLookX = 0, lastLookY = 0;
let yaw = 0, pitch = 0;

lookZone.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  lookTouchId = t.identifier;
  lastLookX = t.clientX;
  lastLookY = t.clientY;
  e.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier !== lookTouchId) continue;
    const dx = t.clientX - lastLookX;
    const dy = t.clientY - lastLookY;
    lastLookX = t.clientX;
    lastLookY = t.clientY;
    yaw -= dx * 0.0035;
    pitch -= dy * 0.0035;
    pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }
  e.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouchId) lookTouchId = null;
  }
}, { passive: false });

// init yaw/pitch from camera for touch mode
function syncYawPitchFromCamera() {
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  yaw = e.y;
  pitch = e.x;
}
syncYawPitchFromCamera();

// ---------- Jump button (mobile) ----------
document.getElementById('jumpBtn').addEventListener('touchstart', (e) => {
  tryJump();
  e.preventDefault();
}, { passive: false });

// ---------- Collision helper ----------
function resolveCollisions(pos) {
  for (const c of colliders) {
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const dist = Math.hypot(dx, dz);
    const minDist = c.r + 0.35; // player radius buffer
    if (dist < minDist && dist > 0.0001) {
      const push = (minDist - dist);
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    }
  }
}

// ---------- Animation loop ----------
const clock = new THREE.Clock();
const forwardVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  const speed = (move.run ? 6.5 : 3.4);

  // Determine movement input: keyboard for desktop, joystick for mobile
  let inputX = 0, inputZ = 0;
  if (isTouch) {
    inputX = joyVec.x;
    inputZ = joyVec.y; // forward is -y on stick
  } else {
    inputZ = (move.forward ? 1 : 0) - (move.backward ? 1 : 0);
    inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
  }

  camera.getWorldDirection(forwardVec);
  forwardVec.y = 0;
  forwardVec.normalize();
  rightVec.crossVectors(forwardVec, camera.up).normalize();

  const moveDir = new THREE.Vector3();
  moveDir.addScaledVector(forwardVec, -inputZ); // stick y: up(-1) = forward
  moveDir.addScaledVector(rightVec, inputX);
  if (moveDir.lengthSq() > 0.0001) moveDir.normalize();

  const nextPos = camera.position.clone();
  nextPos.addScaledVector(moveDir, speed * dt);

  // gravity / jump
  verticalVelocity -= GRAVITY * dt;
  nextPos.y += verticalVelocity * dt;
  if (nextPos.y <= EYE_HEIGHT) {
    nextPos.y = EYE_HEIGHT;
    verticalVelocity = 0;
    onGround = true;
  }

  resolveCollisions(nextPos);

  // keep within rough village bounds
  const maxR = 30;
  const distFromCenter = Math.hypot(nextPos.x, nextPos.z);
  if (distFromCenter > maxR) {
    const scale = maxR / distFromCenter;
    nextPos.x *= scale;
    nextPos.z *= scale;
  }

  camera.position.copy(nextPos);

  // sun follows player loosely for consistent shadows without huge shadow frustum
  sun.position.set(camera.position.x + 20, camera.position.y + 30, camera.position.z + 10);
  sun.target.position.copy(camera.position);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}
animate();

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
