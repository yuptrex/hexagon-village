import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- Basic scene ----------
const wrap = document.getElementById('canvas-wrap');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd6ec);
scene.fog = new THREE.Fog(0x9fd6ec, 25, 70);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 200);

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

scene.add(new THREE.AmbientLight(0xffffff, 0.25));

// ---------- Ground plane ----------
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
const colliders = [];
const interactables = []; // { mesh, box, name }

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
  for (const t of data.tiles) {
    try {
      const model = await loadModel(t.file);
      model.position.set(t.x, t.y, t.z);
      model.rotation.y = THREE.MathUtils.degToRad(t.ry || 0);
      villageGroup.add(model);
    } catch (e) { console.warn('tile fail', t.file, e); }
  }
  for (const o of data.objects) {
    try {
      const model = await loadModel(o.file);
      model.position.set(o.x, o.y, o.z);
      model.rotation.y = THREE.MathUtils.degToRad(o.ry || 0);
      villageGroup.add(model);

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

      // Anything not a flat ground tile is interactable (press E near it)
      const box = new THREE.Box3().setFromObject(model);
      interactables.push({ mesh: model, box, name: o.file.split('/').pop().replace(/\.(gltf|glb)$/, '') });
    } catch (e) { console.warn('obj fail', o.file, e); }
  }
}).catch(err => {
  console.error('village.json load failed', err);
  const pctEl = document.getElementById('loadPct');
  if (pctEl) pctEl.textContent = 'Failed to load village.json';
});

// =====================================================================
// ---------- Character: load rig, build procedural animator ----------
// =====================================================================

const player = new THREE.Group();
scene.add(player);

let charRoot = null;      // the mesh/skeleton root added under player
let bones = {};           // name -> Bone
let charReady = false;

const CHAR_PATH = 'characters/LowPolychars3.glb';

new GLTFLoader(manager).load('assets/' + CHAR_PATH, (gltf) => {
  const scene3 = gltf.scene;

  // The pack contains a Male rig and a Female rig; use the Male rig, hide Female.
  let maleRig = scene3.getObjectByName('MaleRig');
  let femaleRig = scene3.getObjectByName('FemaleRig');
  if (femaleRig) femaleRig.visible = false;
  const rig = maleRig || scene3;

  rig.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
    if (o.isBone) bones[o.name] = o;
  });

  rig.scale.setScalar(1.0);
  rig.rotation.y = Math.PI; // face away from camera (back view) by default
  charRoot = rig;
  player.add(rig);
  charReady = true;
}, undefined, (err) => {
  console.error('character load failed', err);
});

// helper: safe bone rotation setter (only if bone exists)
function setRot(name, x, y, z) {
  const b = bones[name];
  if (!b) return;
  if (x !== undefined) b.rotation.x = x;
  if (y !== undefined) b.rotation.y = y;
  if (z !== undefined) b.rotation.z = z;
}

// store bind pose so we can lerp back to it smoothly when idle
let bindCaptured = false;
const bindPose = {};
function captureBind() {
  for (const k in bones) {
    bindPose[k] = bones[k].rotation.clone();
  }
  bindCaptured = true;
}

// =====================================================================
// ---------- Movement / action state ----------
// =====================================================================

const move = { forward: false, backward: false, left: false, right: false, run: false };
let action = 'idle'; // idle | walk | run | jump | crouch | prone | slide
let crouching = false;
let prone = false;
let sliding = false;
let slideTimer = 0;
const SLIDE_DURATION = 0.55;

const velocity = new THREE.Vector3();
let verticalVelocity = 0;
const GRAVITY = 18;
const JUMP_SPEED = 6.2;
const GROUND_Y = 0;
let onGround = true;
let jumping = false;

const keyMap = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    move.run = true;
    // shift while moving = slide, if not already crouched/prone
    if (!crouching && !prone && isMoving() && onGround) startSlide();
  }
  if (e.code === 'Space') { tryJump(); e.preventDefault(); }
  if (e.code === 'KeyC') toggleCrouch();
  if (e.code === 'KeyZ' || e.code === 'KeyX') toggleProne();
  if (e.code === 'KeyE') tryInteract();
});
window.addEventListener('keyup', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.run = false;
});

function isMoving() {
  return move.forward || move.backward || move.left || move.right || (isTouch && (Math.abs(joyVec.x) > 0.1 || Math.abs(joyVec.y) > 0.1));
}

function tryJump() {
  if (onGround && !prone && !sliding) {
    verticalVelocity = JUMP_SPEED;
    onGround = false;
    jumping = true;
    crouching = false;
  }
}

function toggleCrouch() {
  if (prone || sliding) return;
  crouching = !crouching;
}

function toggleProne() {
  if (sliding) return;
  prone = !prone;
  if (prone) crouching = false;
}

function startSlide() {
  sliding = true;
  slideTimer = SLIDE_DURATION;
  crouching = false;
  prone = false;
}

// ---------- Interaction ----------
const interactPrompt = document.getElementById('interactPrompt');
let nearestInteractable = null;

function tryInteract() {
  if (nearestInteractable) {
    flashInteract(nearestInteractable.name);
  }
}
function flashInteract(name) {
  if (!interactPrompt) return;
  interactPrompt.textContent = 'Interacted: ' + name;
  interactPrompt.classList.add('flash');
  setTimeout(() => interactPrompt.classList.remove('flash'), 350);
}

// ---------- Mobile joystick ----------
const joyZone = document.getElementById('joyZone');
const joyBase = document.getElementById('joyBase');
const joyStick = document.getElementById('joyStick');
let joyTouchId = null;
let joyVec = { x: 0, y: 0 };

function setJoyBase(x, y) {
  joyBase.style.left = (x - 55) + 'px';
  joyBase.style.top = (y - 55) + 'px';
  joyBase.style.display = 'block';
}

joyZone.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  joyTouchId = t.identifier;
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
    joyTouchId = null;
    joyVec.x = 0; joyVec.y = 0;
    joyBase.style.display = 'none';
  }
}
joyZone.addEventListener('touchend', endJoy, { passive: false });
joyZone.addEventListener('touchcancel', endJoy, { passive: false });

// ---------- Mobile look (orbit camera around player) ----------
const lookZone = document.getElementById('lookZone');
let lookTouchId = null;
let lastLookX = 0, lastLookY = 0;

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
    camYaw -= dx * 0.006;
    camPitch = Math.max(0.15, Math.min(1.15, camPitch - dy * 0.004));
  }
  e.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouchId) lookTouchId = null;
  }
}, { passive: false });

// ---------- Desktop mouse look (drag to orbit, no pointer lock needed) ----------
const isTouch = window.matchMedia('(pointer:coarse)').matches;
let dragging = false;
let lastMX = 0, lastMY = 0;

renderer.domElement.addEventListener('mousedown', (e) => {
  dragging = true;
  lastMX = e.clientX;
  lastMY = e.clientY;
});
window.addEventListener('mouseup', () => dragging = false);
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastMX;
  const dy = e.clientY - lastMY;
  lastMX = e.clientX;
  lastMY = e.clientY;
  camYaw -= dx * 0.006;
  camPitch = Math.max(0.15, Math.min(1.15, camPitch - dy * 0.004));
});

// ---------- Jump button (mobile) ----------
document.getElementById('jumpBtn').addEventListener('touchstart', (e) => {
  tryJump();
  e.preventDefault();
}, { passive: false });

// ---------- Crouch/Prone buttons (mobile) ----------
const crouchBtn = document.getElementById('crouchBtn');
const proneBtn = document.getElementById('proneBtn');
if (crouchBtn) crouchBtn.addEventListener('touchstart', (e) => { toggleCrouch(); e.preventDefault(); }, { passive: false });
if (proneBtn) proneBtn.addEventListener('touchstart', (e) => { toggleProne(); e.preventDefault(); }, { passive: false });
const interactBtn = document.getElementById('interactBtn');
if (interactBtn) interactBtn.addEventListener('touchstart', (e) => { tryInteract(); e.preventDefault(); }, { passive: false });

// ---------- Instructions overlay ----------
const instructions = document.getElementById('instructions');
const startBtn = document.getElementById('startBtn');
const helpBtn = document.getElementById('helpBtn');

startBtn.addEventListener('click', () => instructions.classList.add('hidden'));
helpBtn.addEventListener('click', () => instructions.classList.remove('hidden'));

// ---------- Collision helper ----------
function resolveCollisions(pos) {
  for (const c of colliders) {
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const dist = Math.hypot(dx, dz);
    const minDist = c.r + 0.4;
    if (dist < minDist && dist > 0.0001) {
      const push = (minDist - dist);
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    }
  }
}

// =====================================================================
// ---------- Third-person camera (back view) ----------
// =====================================================================
let camYaw = 0;         // radians around player, 0 = behind player facing same way
let camPitch = 0.55;    // radians up from horizontal
let camDist = 6.5;
const camTarget = new THREE.Vector3();
let facingAngle = 0; // player's current facing (world yaw)

function updateCamera() {
  const height = player.position.y + 1.5;
  camTarget.set(player.position.x, height, player.position.z);

  const offsetX = Math.sin(camYaw) * Math.cos(camPitch) * camDist;
  const offsetZ = Math.cos(camYaw) * Math.cos(camPitch) * camDist;
  const offsetY = Math.sin(camPitch) * camDist;

  const desired = new THREE.Vector3(
    player.position.x + offsetX,
    height + offsetY,
    player.position.z + offsetZ
  );

  camera.position.lerp(desired, 1); // instant follow (avoid lag feel); change to smaller factor for smoothing
  camera.lookAt(camTarget);
}

// =====================================================================
// ---------- Procedural animation ----------
// =====================================================================
let animTime = 0;
let currentSpeed = 0; // smoothed for animation blending

function animateCharacter(dt, speed01, grounded, jumpingNow, crouchNow, proneNow, slidingNow) {
  if (!charReady) return;
  if (!bindCaptured) captureBind();

  currentSpeed += (speed01 - currentSpeed) * Math.min(1, dt * 8);
  animTime += dt * (0.6 + currentSpeed * 1.6);

  const walkCycle = Math.sin(animTime * 6.0);
  const walkCycle2 = Math.sin(animTime * 6.0 + Math.PI);

  // reset toward bind pose each frame, then layer procedural motion
  for (const k in bones) {
    const b = bones[k];
    const bp = bindPose[k];
    if (bp) b.rotation.set(bp.x, bp.y, bp.z);
  }

  if (slidingNow) {
    // sliding: body low & leaned back, legs forward, arms out for balance
    setRot('spine1', -0.5);
    setRot('spine2', 0.15);
    setRot('pelvis', undefined, undefined, 0);
    setRot('thigh.L', -0.9);
    setRot('thigh.R', -0.5);
    setRot('shin.L', 0.3);
    setRot('shin.R', 0.9);
    setRot('shoulder.L', undefined, undefined, 0.9);
    setRot('shoulder.R', undefined, undefined, -0.9);
    charRoot.position.y = -0.55;
  } else if (proneNow) {
    // prone: lying flat, facing down, slight crawl wiggle if moving
    const crawl = currentSpeed > 0.05 ? Math.sin(animTime * 5) * 0.15 : 0;
    charRoot.rotation.x = -Math.PI / 2 + 0.05;
    charRoot.position.y = -0.62;
    setRot('spine1', 0);
    setRot('shoulder.L', crawl, undefined, 0.3);
    setRot('shoulder.R', -crawl, undefined, -0.3);
    setRot('thigh.L', 0.1 + crawl * 0.3);
    setRot('thigh.R', 0.1 - crawl * 0.3);
  } else {
    charRoot.rotation.x = 0;
    if (crouchNow) {
      charRoot.position.y = -0.28;
      setRot('spine1', -0.25);
      setRot('thigh.L', -0.55);
      setRot('thigh.R', -0.55);
      setRot('shin.L', 0.9);
      setRot('shin.R', 0.9);
    } else {
      charRoot.position.y = 0;
    }

    if (jumpingNow) {
      setRot('thigh.L', -0.5);
      setRot('thigh.R', 0.3);
      setRot('shin.L', 0.9);
      setRot('shin.R', 0.2);
      setRot('shoulder.L', -0.6);
      setRot('shoulder.R', 0.6);
    } else if (currentSpeed > 0.02) {
      // walk/run cycle — swings scale with speed, crouch halves amplitude
      const amp = (crouchNow ? 0.5 : 1) * (0.35 + currentSpeed * 0.55);
      setRot('thigh.L', walkCycle * amp);
      setRot('thigh.R', walkCycle2 * amp);
      setRot('shin.L', Math.max(0, -walkCycle2) * amp * 1.3);
      setRot('shin.R', Math.max(0, -walkCycle) * amp * 1.3);
      setRot('shoulder.L', walkCycle2 * amp * 0.8);
      setRot('shoulder.R', walkCycle * amp * 0.8);
      setRot('spine1', undefined, Math.sin(animTime * 6.0) * 0.05 * amp);
    } else {
      // idle breathing
      const breathe = Math.sin(animTime * 1.2) * 0.03;
      setRot('spine2', breathe);
    }
  }
}

// =====================================================================
// ---------- Main loop ----------
// =====================================================================
const clock = new THREE.Clock();
const forwardVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const moveDir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // slide timer countdown
  if (sliding) {
    slideTimer -= dt;
    if (slideTimer <= 0) sliding = false;
  }

  const baseSpeed = prone ? 1.1 : crouching ? 1.8 : (move.run && !sliding ? 6.5 : 3.4);
  const speed = sliding ? 8.5 : baseSpeed;

  let inputX = 0, inputZ = 0;
  if (isTouch) {
    inputX = joyVec.x;
    inputZ = joyVec.y;
  } else {
    inputZ = (move.forward ? 1 : 0) - (move.backward ? 1 : 0);
    inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
  }

  // movement is relative to camera yaw (so W always = "away from camera")
  forwardVec.set(Math.sin(camYaw), 0, Math.cos(camYaw));
  rightVec.set(Math.cos(camYaw), 0, -Math.sin(camYaw));

  moveDir.set(0, 0, 0);
  if (sliding) {
    // continue in current facing direction regardless of input
    moveDir.set(Math.sin(facingAngle), 0, Math.cos(facingAngle));
  } else {
    moveDir.addScaledVector(forwardVec, -inputZ);
    moveDir.addScaledVector(rightVec, inputX);
    if (moveDir.lengthSq() > 0.0001) {
      moveDir.normalize();
      facingAngle = Math.atan2(moveDir.x, moveDir.z);
    }
  }

  const moving = moveDir.lengthSq() > 0.0001;
  const nextPos = player.position.clone();
  if (moving || sliding) {
    nextPos.addScaledVector(moveDir, speed * dt);
  }

  // gravity / jump
  verticalVelocity -= GRAVITY * dt;
  nextPos.y += verticalVelocity * dt;
  if (nextPos.y <= GROUND_Y) {
    nextPos.y = GROUND_Y;
    verticalVelocity = 0;
    if (!onGround) jumping = false;
    onGround = true;
  } else {
    onGround = false;
  }

  resolveCollisions(nextPos);

  const maxR = 30;
  const distFromCenter = Math.hypot(nextPos.x, nextPos.z);
  if (distFromCenter > maxR) {
    const scale = maxR / distFromCenter;
    nextPos.x *= scale;
    nextPos.z *= scale;
  }

  player.position.copy(nextPos);

  // orient character to face movement direction (rig faces +Z by default in its bind pose reasoning,
  // but we rotated 180 at load so back is toward camera by default; blend toward facingAngle)
  if (charRoot) {
    const targetY = facingAngle + Math.PI; // + PI keeps back-view feel: model built to look at us, so flip
    let cur = charRoot.rotation.y;
    let diff = ((targetY - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
    charRoot.rotation.y = cur + diff * Math.min(1, dt * 10);
  }

  // speed01 for animation blend (0..1, run pushes past 1 slightly clamped)
  const speed01 = moving || sliding ? Math.min(1.4, speed / 3.4) : 0;
  animateCharacter(dt, speed01, onGround, jumping && !onGround, crouching, prone, sliding);

  updateCamera();

  // nearest interactable check
  let nearest = null, nearestD = 3.2;
  for (const it of interactables) {
    const d = Math.hypot(it.mesh.position.x - player.position.x, it.mesh.position.z - player.position.z);
    if (d < nearestD) { nearestD = d; nearest = it; }
  }
  nearestInteractable = nearest;
  if (interactPrompt) {
    if (nearest) {
      interactPrompt.style.display = 'block';
      if (!interactPrompt.classList.contains('flash')) interactPrompt.textContent = 'Press E to interact: ' + nearest.name;
    } else {
      interactPrompt.style.display = 'none';
    }
  }

  // sun follows player loosely
  sun.position.set(player.position.x + 20, player.position.y + 30, player.position.z + 10);
  sun.target.position.copy(player.position);
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

