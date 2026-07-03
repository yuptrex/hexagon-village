import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- Basic scene ----------
const wrap = document.getElementById('canvas-wrap');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd6ec);
scene.fog = new THREE.Fog(0x9fd6ec, 160, 340);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 650);

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

// ---------- Ground plane (fallback collider under tiles) ----------
const groundGeo = new THREE.PlaneGeometry(700, 700);
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
const colliders = []; // bounding circles for buildings/trees/rocks

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

const villageReady = fetch('village.json').then(r => r.json()).then(async (data) => {
  markOccupiedFromVillage(data);
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
    } catch (e) { console.warn('obj fail', o.file, e); }
  }
}).catch(err => {
  console.error('village.json load failed', err);
  const pctEl = document.getElementById('loadPct');
  if (pctEl) pctEl.textContent = 'Failed to load village.json';
});

// ================================================================
// ---------- Infinite terrain: auto-extend the hex grass field around the player ----------
// (Minecraft-style "chunk" streaming, but for one flat grass hex tile at a time, reusing
// the exact same hex_grass.gltf tile + spacing math already used in village.json, so new
// land tiles interlock perfectly with the hand-authored village and with each other.)
// ================================================================

const HEX_DX = 1.5;                 // column spacing (world units) — matches village.json hexSize.dx
const HEX_DZ = 3.4641016151377544;  // row spacing (world units) — matches village.json hexSize.dz (=sqrt(3))
const GRASS_TILE = 'tiles/base/hex_grass.gltf';

// axial "column" coordinate = round(x / HEX_DX); odd columns are offset by half a row in z,
// matching the layout already present in village.json (visible from its x,z pairs).
function hexColRow(x, z) {
  const col = Math.round(x / HEX_DX);
  const rowOffset = (Math.abs(col % 2) === 1) ? HEX_DZ / 2 : 0;
  const row = Math.round((z - rowOffset) / HEX_DZ);
  return { col, row };
}
function hexToWorld(col, row) {
  const rowOffset = (Math.abs(col % 2) === 1) ? HEX_DZ / 2 : 0;
  return { x: col * HEX_DX, z: row * HEX_DZ + rowOffset };
}

const occupiedHexes = new Set(); // "col,row" -> true, for every tile already placed (village + generated)
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

function markOccupiedFromVillage(data) {
  for (const t of data.tiles) {
    const { col, row } = hexColRow(t.x, t.z);
    occupiedHexes.add(col + ',' + row);
  }
}

let terrainTileTemplate = null; // cached loaded scene, cloned per-tile for speed

const GEN_RADIUS_HEXES = 9;    // how far out (in hex rings) tiles are kept generated around the player
const GEN_MARGIN_HEXES = 2;    // regenerate once player gets within this many hexes of the current edge
const UNLOAD_RADIUS_HEXES = GEN_RADIUS_HEXES + 4; // tiles beyond this are torn back down to keep memory bounded

let lastGenCol = null, lastGenRow = null;

// ---- Deterministic per-hex pseudo-random (same hex always yields the same result,
// so regenerating a tile the player returns to always looks identical — a real
// "infinite, consistent" world rather than randomly re-rolled scenery). ----
function hexRand(col, row, salt) {
  const v = Math.sin(col * 127.1 + row * 311.7 + salt * 74.7) * 43758.5453123;
  return v - Math.floor(v);
}

// ---- Procedural scatter pools: the village itself keeps expanding outward via
// blue/red building clusters, not just grass — "everything infinite", not only tiles.
const PROC_BUILDINGS = {
  blue: [
    'buildings/blue/building_home_A_blue.gltf', 'buildings/blue/building_home_B_blue.gltf',
    'buildings/blue/building_tavern_blue.gltf', 'buildings/blue/building_well_blue.gltf',
    'buildings/blue/building_market_blue.gltf', 'buildings/blue/building_blacksmith_blue.gltf',
    'buildings/blue/building_tower_A_blue.gltf', 'buildings/blue/building_windmill_blue.gltf',
    'buildings/blue/building_barracks_blue.gltf', 'buildings/blue/building_church_blue.gltf',
  ],
  red: [
    'buildings/red/building_home_A_red.gltf', 'buildings/red/building_home_B_red.gltf',
    'buildings/red/building_tavern_red.gltf', 'buildings/red/building_well_red.gltf',
    'buildings/red/building_market_red.gltf', 'buildings/red/building_blacksmith_red.gltf',
    'buildings/red/building_tower_A_red.gltf', 'buildings/red/building_windmill_red.gltf',
    'buildings/red/building_barracks_red.gltf', 'buildings/red/building_church_red.gltf',
  ],
};
const PROC_NATURE = [
  'decoration/nature/tree_single_A.gltf', 'decoration/nature/tree_single_B.gltf',
  'decoration/nature/trees_A_small.gltf', 'decoration/nature/trees_B_small.gltf',
  'decoration/nature/trees_A_medium.gltf', 'decoration/nature/rock_single_A.gltf',
  'decoration/nature/rock_single_B.gltf', 'decoration/nature/rock_single_C.gltf',
  'decoration/nature/rock_single_D.gltf', 'decoration/nature/hill_single_A.gltf',
];
const PROC_PROPS = [
  'decoration/props/barrel.gltf', 'decoration/props/crate_A_small.gltf',
  'decoration/props/crate_B_big.gltf', 'decoration/props/flag_blue.gltf',
  'decoration/props/flag_red.gltf', 'decoration/props/sack.gltf', 'decoration/props/tent.gltf',
];

const generatedHexes = new Map(); // key -> { group, colliderKeys:[key,...] shares same key }

async function ensureTerrainAround(worldX, worldZ) {
  const { col: pCol, row: pRow } = hexColRow(worldX, worldZ);
  if (lastGenCol !== null) {
    const d = Math.max(Math.abs(pCol - lastGenCol), Math.abs(pRow - lastGenRow));
    if (d < GEN_MARGIN_HEXES) return; // player hasn't moved far enough to need new tiles yet
  }
  lastGenCol = pCol; lastGenRow = pRow;

  if (!terrainTileTemplate) {
    terrainTileTemplate = await loadModel(GRASS_TILE); // primes gltfCache; loadModel already clones
  }

  for (let dc = -GEN_RADIUS_HEXES; dc <= GEN_RADIUS_HEXES; dc++) {
    for (let dr = -GEN_RADIUS_HEXES; dr <= GEN_RADIUS_HEXES; dr++) {
      const col = pCol + dc, row = pRow + dr;
      const key = col + ',' + row;
      if (occupiedHexes.has(key)) continue;
      // roughly circular fill instead of a square block
      if (Math.hypot(dc, dr) > GEN_RADIUS_HEXES) continue;
      occupiedHexes.add(key);
      generateHex(col, row, key);
    }
  }

  // ---- unload anything now far behind the player, but let it regenerate identically
  // later (deterministic hash) — keeps the "infinite" world bounded in memory. ----
  for (const [key, entry] of generatedHexes) {
    const [gc, gr] = key.split(',').map(Number);
    const d = Math.max(Math.abs(gc - pCol), Math.abs(gr - pRow));
    if (d > UNLOAD_RADIUS_HEXES) {
      terrainGroup.remove(entry.group);
      for (let i = colliders.length - 1; i >= 0; i--) {
        if (colliders[i].hexKey === key) colliders.splice(i, 1);
      }
      generatedHexes.delete(key);
      occupiedHexes.delete(key);
    }
  }
}

function generateHex(col, row, key) {
  const { x, z } = hexToWorld(col, row);
  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  terrainGroup.add(group);
  generatedHexes.set(key, { group });

  loadModel(GRASS_TILE).then(model => {
    model.position.set(x, 0, z);
    model.rotation.y = THREE.MathUtils.degToRad([0, 60, 120, 180, 240, 300][Math.floor(hexRand(col, row, 0) * 6)]);
    group.add(model);
  });

  // ---- scatter a building, some nature, a prop, or leave the tile clear ----
  const roll = hexRand(col, row, 1);
  let file = null, isBuilding = false, isNature = false;

  if (roll < 0.035) {
    const faction = hexRand(col, row, 2) < 0.5 ? 'blue' : 'red';
    const pool = PROC_BUILDINGS[faction];
    file = pool[Math.floor(hexRand(col, row, 3) * pool.length)];
    isBuilding = true;
  } else if (roll < 0.30) {
    file = PROC_NATURE[Math.floor(hexRand(col, row, 4) * PROC_NATURE.length)];
    isNature = true;
  } else if (roll < 0.34) {
    file = PROC_PROPS[Math.floor(hexRand(col, row, 5) * PROC_PROPS.length)];
  }

  if (file) {
    loadModel(file).then(model => {
      model.position.set(x, 0, z);
      model.rotation.y = THREE.MathUtils.degToRad(Math.floor(hexRand(col, row, 6) * 360));
      group.add(model);

      if (isBuilding || isNature) {
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const radius = Math.max(size.x, size.z) * 0.42;
        if (radius > 0.15) colliders.push({ x, z, r: radius, hexKey: key });
      }
    }).catch(() => {});
  }
}

// ================================================================
// ---------- Third-person character: KayKit Knight + retargeted animations ----------
// ================================================================

const CHAR_SCALE = 0.10; // tiny — a normal person scale next to these building-sized hex tiles

const player = new THREE.Group();
scene.add(player);

let characterModel = null;
let mixer = null;
const actions = {};   // name -> AnimationAction
let currentAction = null;

function fadeToAction(name, duration = 0.2) {
  const next = actions[name];
  if (!next || next === currentAction) return;
  const prev = currentAction;
  next.reset().fadeIn(duration).play();
  if (prev) prev.fadeOut(duration);
  currentAction = next;
}

const charReady = (async () => {
  // Load the character mesh + skeleton
  const charGltf = await new Promise((resolve, reject) => {
    loader.load('character/Knight.glb', resolve, undefined, reject);
  });
  characterModel = charGltf.scene;
  characterModel.scale.setScalar(CHAR_SCALE);
  characterModel.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  player.add(characterModel);

  // Load animation libraries (same skeleton/bone names as the character rig)
  const [moveGltf, generalGltf] = await Promise.all([
    new Promise((resolve, reject) => loader.load('character/Rig_Medium_MovementBasic.glb', resolve, undefined, reject)),
    new Promise((resolve, reject) => loader.load('character/Rig_Medium_General.glb', resolve, undefined, reject)),
  ]);

  mixer = new THREE.AnimationMixer(characterModel);

  const clipSources = [...moveGltf.animations, ...generalGltf.animations];
  for (const clip of clipSources) {
    const action = mixer.clipAction(clip);
    actions[clip.name] = action;
  }

  // Configure one-shot jump + attack clips
  ['Jump_Start', 'Jump_Land', 'Use_Item'].forEach(n => {
    if (actions[n]) {
      actions[n].setLoop(THREE.LoopOnce, 1);
      actions[n].clampWhenFinished = true;
    }
  });

  fadeToAction('Idle_A', 0);
})();

// ================================================================
// ---------- NPCs: KayKit Barbarian + Rogue (visually distinct from the player's Knight),
// each carrying their own sword, wandering near the village. ----------
// ================================================================

const NPC_DEFS = [
  { file: 'npc/Barbarian.glb', x: 6, z: 4 },
  { file: 'npc/Barbarian.glb', x: -8, z: 10 },
  { file: 'npc/Rogue_Hooded.glb', x: 10, z: -6 },
  { file: 'npc/Rogue_Hooded.glb', x: -5, z: -12 },
  { file: 'npc/Barbarian.glb', x: 14, z: 14 },
];

const npcs = [];

async function spawnNPC(def) {
  const [charGltf, moveGltf, generalGltf, swordScene] = await Promise.all([
    new Promise((resolve, reject) => loader.load('character/' + def.file, resolve, undefined, reject)),
    new Promise((resolve, reject) => loader.load('character/Rig_Medium_MovementBasic.glb', resolve, undefined, reject)),
    new Promise((resolve, reject) => loader.load('character/Rig_Medium_General.glb', resolve, undefined, reject)),
    loadWeaponModel('gear/sword_1handed.gltf'),
  ]);

  const model = charGltf.scene;
  model.scale.setScalar(CHAR_SCALE);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const group = new THREE.Group();
  group.position.set(def.x, GROUND_Y, def.z);
  const facing = Math.random() * Math.PI * 2;
  group.rotation.y = facing;
  group.add(model);
  scene.add(group);

  const npcMixer = new THREE.AnimationMixer(model);
  const npcActions = {};
  for (const clip of [...moveGltf.animations, ...generalGltf.animations]) {
    npcActions[clip.name] = npcMixer.clipAction(clip);
  }
  npcActions['Idle_A']?.play();

  ['Hit_A', 'Death_A'].forEach(n => {
    if (npcActions[n]) { npcActions[n].setLoop(THREE.LoopOnce, 1); npcActions[n].clampWhenFinished = true; }
  });

  // attach sword to right hand slot, sized the same as the player's
  swordScene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  let handslotR = null;
  model.traverse(o => { if (o.isBone && o.name === 'handslot.r') handslotR = o; });
  if (handslotR) {
    const sword = swordScene;
    sword.scale.setScalar(TARGET_SWORD_WORLD_LEN / SWORD_RAW_LENGTH / CHAR_SCALE);
    sword.rotation.set(0, 0, 0);
    handslotR.add(sword);
  }

  npcs.push({
    group, model, mixer: npcMixer, actions: npcActions, currentAction: npcActions['Idle_A'],
    home: { x: def.x, z: def.z }, facing,
    state: 'idle', stateTimer: 1 + Math.random() * 3,
    wanderTarget: new THREE.Vector3(def.x, 0, def.z),
    hp: 3, maxHp: 3, hitTimer: 0, deathTimer: 0, invuln: 0,
  });
}

// ---------- NPC damage / stagger / death / respawn ----------
function flashNPC(npc) {
  const mats = [];
  npc.model.traverse(o => {
    if (o.isMesh && o.material) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(m => {
        if (!m.emissive) return;
        mats.push({ m, orig: m.emissive.clone() });
        m.emissive.setHex(0xff2222);
      });
    }
  });
  setTimeout(() => mats.forEach(({ m, orig }) => m.emissive.copy(orig)), 150);
}

function damageNPC(npc, dmg) {
  if (npc.state === 'dead' || npc.invuln > 0) return;
  npc.hp -= dmg;
  npc.invuln = 0.4;
  flashNPC(npc);
  if (npc.hp <= 0) {
    npc.state = 'dead';
    npc.deathTimer = 4.5; // time lying "dead" before respawning back home
    npcFadeTo(npc, 'Death_A', 0.15);
  } else {
    npc.state = 'hit';
    npc.hitTimer = 0.45;
    npcFadeTo(npc, 'Hit_A', 0.1);
  }
}

function npcFadeTo(npc, name, duration = 0.25) {
  const next = npc.actions[name];
  if (!next || next === npc.currentAction) return;
  const prev = npc.currentAction;
  next.reset().fadeIn(duration).play();
  if (prev) prev.fadeOut(duration);
  npc.currentAction = next;
}

const NPC_WANDER_RADIUS = 5;
const NPC_SPEED = 0.7;

function updateNPCs(dt) {
  for (const npc of npcs) {
    if (npc.invuln > 0) npc.invuln -= dt;

    if (npc.state === 'dead') {
      npc.deathTimer -= dt;
      npc.mixer.update(dt);
      if (npc.deathTimer <= 0) {
        // respawn back at home, fully healed
        npc.group.position.set(npc.home.x, GROUND_Y, npc.home.z);
        npc.hp = npc.maxHp;
        npc.state = 'idle';
        npc.stateTimer = 1 + Math.random() * 3;
        npcFadeTo(npc, 'Idle_A', 0.2);
      }
      continue;
    }

    if (npc.state === 'hit') {
      npc.hitTimer -= dt;
      npc.mixer.update(dt);
      if (npc.hitTimer <= 0) {
        npc.state = 'idle';
        npc.stateTimer = 1 + Math.random() * 2;
      }
      continue;
    }

    npc.stateTimer -= dt;
    if (npc.stateTimer <= 0) {
      if (npc.state === 'idle') {
        npc.state = 'walk';
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * NPC_WANDER_RADIUS;
        npc.wanderTarget.set(
          npc.home.x + Math.cos(angle) * dist,
          0,
          npc.home.z + Math.sin(angle) * dist
        );
        npc.stateTimer = 3 + Math.random() * 4;
      } else {
        npc.state = 'idle';
        npc.stateTimer = 2 + Math.random() * 3;
      }
    }

    if (npc.state === 'walk') {
      const dx = npc.wanderTarget.x - npc.group.position.x;
      const dz = npc.wanderTarget.z - npc.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.15) {
        const nx = dx / dist, nz = dz / dist;
        npc.group.position.x += nx * NPC_SPEED * dt;
        npc.group.position.z += nz * NPC_SPEED * dt;
        const targetFacing = Math.atan2(nx, nz);
        let diff = targetFacing - npc.facing;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        npc.facing += diff * Math.min(1, dt * 6);
        npc.group.rotation.y = npc.facing;
        npcFadeTo(npc, 'Walking_A', 0.2);
      } else {
        npc.state = 'idle';
        npc.stateTimer = 2 + Math.random() * 3;
      }
    } else {
      npcFadeTo(npc, 'Idle_A', 0.25);
    }

    npc.mixer.update(dt);
  }
}

// NPC_DEFS.forEach(spawnNPC) is kicked off further down, after the sword sizing constants
// (TARGET_SWORD_WORLD_LEN, SWORD_RAW_LENGTH) and loadWeaponModel() are declared.

// ---------- Input state ----------
const move = { forward: false, backward: false, left: false, right: false, run: false, crouch: false, prone: false };

const keyMap = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.run = true;
  if (e.code === 'Space') {
    if (flying) { flyUp = true; } else { tryJump(); }
    e.preventDefault();
  }
  if (e.code === 'KeyC' || e.code === 'ControlLeft') {
    if (flying) { flyDown = true; } else { toggleCrouch(); }
    e.preventDefault();
  }
  if (e.code === 'KeyZ') { toggleProne(); e.preventDefault(); }
  if (e.code === 'KeyX') { trySlide(); e.preventDefault(); }
  if (e.code === 'KeyV') { toggleFly(); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (keyMap[e.code]) move[keyMap[e.code]] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.run = false;
  if (e.code === 'Space') flyUp = false;
  if (e.code === 'KeyC' || e.code === 'ControlLeft') flyDown = false;
});

// ---------- Movement / posture parameters ----------
const GRAVITY = 6;
const JUMP_SPEED = 2.0;
const GROUND_Y = 0.0; // player group sits at hex-tile ground level

const SPEED_WALK = 1.5;
const SPEED_RUN = 5.2;
const SPEED_CROUCH = 0.7;
const SPEED_PRONE = 0.35;
const SLIDE_SPEED = 3.6;
const SLIDE_DURATION = 0.55;

const SPEED_FLY = 6.0;
const SPEED_FLY_FAST = 16.0;
const FLY_VERTICAL_SPEED = 6.0;

let flying = false;
let flyUp = false;
let flyDown = false;

let verticalVelocity = 0;
let onGround = true;
let isJumping = false;
let jumpPhase = 'none'; // none | start | air | land

let posture = 'stand'; // stand | crouch | prone
let sliding = false;
let slideTimer = 0;
const slideDir = new THREE.Vector3();

function toggleCrouch() {
  if (sliding || isJumping) return;
  if (posture === 'crouch') posture = 'stand';
  else posture = 'crouch';
}
function toggleProne() {
  if (sliding || isJumping) return;
  if (posture === 'prone') posture = 'stand';
  else posture = 'prone';
}
function trySlide() {
  if (sliding || isJumping || !onGround) return;
  // Slide only makes sense while moving
  const hasInput = move.forward || move.backward || move.left || move.right || (joyVec.x !== 0 || joyVec.y !== 0);
  if (!hasInput) return;
  if (slideDir.lengthSq() < 0.0001) {
    // fall back to current facing direction if we don't have a recent movement vector
    slideDir.set(Math.sin(playerFacing), 0, Math.cos(playerFacing));
  }
  sliding = true;
  slideTimer = SLIDE_DURATION;
  posture = 'crouch';
}

function tryJump() {
  if (flying) return;
  if (onGround && !sliding && posture !== 'prone') {
    verticalVelocity = JUMP_SPEED;
    onGround = false;
    isJumping = true;
    jumpPhase = 'start';
  }
}

function toggleFly() {
  flying = !flying;
  if (flying) {
    // cancel any grounded state so we don't snap back down
    sliding = false;
    isJumping = false;
    jumpPhase = 'none';
    posture = 'stand';
    verticalVelocity = 0;
  } else {
    // dropped out of fly mode: let gravity take over from wherever we are
    onGround = false;
    verticalVelocity = 0;
  }
  const btn = document.getElementById('flyBtn');
  if (btn) btn.classList.toggle('active', flying);
}

// ---------- Procedural posture rig (crouch / prone bend, since the free pack has no such clips) ----------
// We apply an extra offset to the whole character group's Y position and a torso lean,
// layered on top of whatever locomotion animation is currently playing.
const postureNode = new THREE.Group();
let postureBlend = 0; // 0 = standing, 1 = fully crouched/prone target
let postureTargetHeight = 0; // extra Y offset (negative = lower)
let postureTargetLean = 0;   // extra X-rotation lean (radians)

function updatePostureTargets() {
  if (posture === 'crouch') {
    postureTargetHeight = -0.16 * CHAR_SCALE / 0.62;
    postureTargetLean = 0.12;
  } else if (posture === 'prone') {
    postureTargetHeight = -0.34 * CHAR_SCALE / 0.62;
    postureTargetLean = 1.25;
  } else {
    postureTargetHeight = 0;
    postureTargetLean = 0;
  }
}

// ---------- Joystick (bottom-left, swipe/click to move) ----------
const joyZone = document.getElementById('joyZone');
const joyBase = document.getElementById('joyBase');
const joyStick = document.getElementById('joyStick');
let joyVec = { x: 0, y: 0 };
let joyPointerId = null;
const JOY_MAX_R = 34;

function placeJoyBaseFixed() {
  const pad = 20;
  joyBase.style.left = pad + 'px';
  joyBase.style.bottom = pad + 'px';
  joyBase.style.top = '';
  joyBase.style.display = 'block';
}
placeJoyBaseFixed();

function joyCenter() {
  const r = joyBase.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

function updateJoyStick(clientX, clientY) {
  const { cx, cy } = joyCenter();
  let dx = clientX - cx;
  let dy = clientY - cy;
  const dist = Math.min(Math.hypot(dx, dy), JOY_MAX_R);
  const angle = Math.atan2(dy, dx);
  const sx = Math.cos(angle) * dist;
  const sy = Math.sin(angle) * dist;
  joyStick.style.left = (55 + sx - 25) + 'px';
  joyStick.style.top = (55 + sy - 25) + 'px';
  joyVec.x = sx / JOY_MAX_R;
  joyVec.y = sy / JOY_MAX_R;
}

function resetJoyStick() {
  joyStick.style.left = '30px';
  joyStick.style.top = '30px';
  joyVec.x = 0; joyVec.y = 0;
}
resetJoyStick();

joyZone.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  joyPointerId = t.identifier;
  updateJoyStick(t.clientX, t.clientY);
  e.preventDefault();
}, { passive: false });

joyZone.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier !== joyPointerId) continue;
    updateJoyStick(t.clientX, t.clientY);
  }
  e.preventDefault();
}, { passive: false });

function endJoyTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier !== joyPointerId) continue;
    joyPointerId = null;
    resetJoyStick();
  }
}
joyZone.addEventListener('touchend', endJoyTouch, { passive: false });
joyZone.addEventListener('touchcancel', endJoyTouch, { passive: false });

joyZone.addEventListener('mousedown', (e) => {
  joyPointerId = 'mouse';
  updateJoyStick(e.clientX, e.clientY);
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (joyPointerId !== 'mouse') return;
  updateJoyStick(e.clientX, e.clientY);
});
window.addEventListener('mouseup', () => {
  if (joyPointerId !== 'mouse') return;
  joyPointerId = null;
  resetJoyStick();
});

// ---------- Camera orbit (drag anywhere on right side / mouse-drag on desktop) ----------
const lookZone = document.getElementById('lookZone');
let lookTouchId = null;
let lastLookX = 0, lastLookY = 0;
let camYaw = 0;        // orbit around player, 0 = behind player facing same dir
let camPitch = 0.35;   // tilt down toward player

function applyLookDelta(dx, dy) {
  camYaw -= dx * 0.008;
  camPitch += dy * 0.006;
  camPitch = Math.max(0.05, Math.min(1.15, camPitch));
}

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
    applyLookDelta(dx, dy);
  }
  e.preventDefault();
}, { passive: false });

lookZone.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouchId) lookTouchId = null;
  }
}, { passive: false });

// Desktop: drag with left mouse on the main canvas to orbit camera (also works over lookZone)
let mouseDragging = false;
renderer.domElement.addEventListener('mousedown', (e) => {
  mouseDragging = true;
  lastLookX = e.clientX;
  lastLookY = e.clientY;
});
window.addEventListener('mousemove', (e) => {
  if (!mouseDragging) return;
  const dx = e.clientX - lastLookX;
  const dy = e.clientY - lastLookY;
  lastLookX = e.clientX;
  lastLookY = e.clientY;
  applyLookDelta(dx, dy);
});
window.addEventListener('mouseup', () => { mouseDragging = false; });

// ---------- Jump / Crouch / Slide / Fly buttons (mobile) ----------
document.getElementById('jumpBtn').addEventListener('touchstart', (e) => {
  if (flying) { flyUp = true; } else { tryJump(); }
  e.preventDefault();
}, { passive: false });
document.getElementById('jumpBtn').addEventListener('touchend', (e) => {
  if (flying) { flyUp = false; }
  e.preventDefault();
}, { passive: false });

const flyDownBtn = document.getElementById('flyDownBtn');
if (flyDownBtn) {
  flyDownBtn.addEventListener('touchstart', (e) => { flyDown = true; e.preventDefault(); }, { passive: false });
  flyDownBtn.addEventListener('touchend', (e) => { flyDown = false; e.preventDefault(); }, { passive: false });
  flyDownBtn.addEventListener('mousedown', () => { flyDown = true; });
  window.addEventListener('mouseup', () => { flyDown = false; });
}

const flyBtn = document.getElementById('flyBtn');
if (flyBtn) {
  flyBtn.addEventListener('touchstart', (e) => { toggleFly(); e.preventDefault(); }, { passive: false });
  flyBtn.addEventListener('click', () => { toggleFly(); });
}

const crouchBtn = document.getElementById('crouchBtn');
if (crouchBtn) {
  crouchBtn.addEventListener('touchstart', (e) => { toggleCrouch(); e.preventDefault(); }, { passive: false });
  crouchBtn.addEventListener('click', (e) => { toggleCrouch(); });
}
const proneBtn = document.getElementById('proneBtn');
if (proneBtn) {
  proneBtn.addEventListener('touchstart', (e) => { toggleProne(); e.preventDefault(); }, { passive: false });
  proneBtn.addEventListener('click', (e) => { toggleProne(); });
}
const slideBtn = document.getElementById('slideBtn');
if (slideBtn) {
  slideBtn.addEventListener('touchstart', (e) => { trySlide(); e.preventDefault(); }, { passive: false });
  slideBtn.addEventListener('click', (e) => { trySlide(); });
}
const runBtn = document.getElementById('runBtn');
if (runBtn) {
  const setRun = (v) => { move.run = v; runBtn.classList.toggle('active', v); };
  runBtn.addEventListener('touchstart', (e) => { setRun(true); e.preventDefault(); }, { passive: false });
  runBtn.addEventListener('touchend', (e) => { setRun(false); e.preventDefault(); }, { passive: false });
  runBtn.addEventListener('mousedown', () => setRun(true));
  window.addEventListener('mouseup', () => setRun(false));
}

// ---------- "MORE" drawer: collapses secondary movement buttons out of the way ----------
const moreToggle = document.getElementById('moreToggle');
const moreDrawer = document.getElementById('moreDrawer');
if (moreToggle && moreDrawer) {
  const toggleDrawer = (e) => {
    const open = moreDrawer.classList.toggle('open');
    moreToggle.textContent = open ? 'LESS ▼' : 'MORE ▲';
    if (e) e.preventDefault();
  };
  moreToggle.addEventListener('touchstart', toggleDrawer, { passive: false });
  moreToggle.addEventListener('click', toggleDrawer);
}

// ---------- Start / instructions ----------
const instructions = document.getElementById('instructions');
const startBtn = document.getElementById('startBtn');
const helpBtn = document.getElementById('helpBtn');

function beginExperience() {
  instructions.classList.add('hidden');
}
startBtn.addEventListener('click', beginExperience);
helpBtn.addEventListener('click', () => instructions.classList.remove('hidden'));
instructions.addEventListener('click', (e) => {
  if (e.target === instructions) beginExperience();
});

// ---------- Collision helper ----------
function resolveCollisions(pos) {
  for (const c of colliders) {
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const dist = Math.hypot(dx, dz);
    const minDist = c.r + 0.05;
    if (dist < minDist && dist > 0.0001) {
      const push = (minDist - dist);
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    }
  }
}

// ---------- Main animation loop ----------
const clock = new THREE.Clock();
const forwardVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const camOffset = new THREE.Vector3();
const desiredCamPos = new THREE.Vector3();
const camLookTarget = new THREE.Vector3();

let playerFacing = 0; // yaw the character model faces
const CAM_DISTANCE = 1.15;

// initial camera placement
player.position.set(0, GROUND_Y, 6);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updatePostureTargets();
  // smooth posture blend
  const targetBlend = posture === 'stand' ? 0 : 1;
  postureBlend += (targetBlend - postureBlend) * Math.min(1, dt * 8);

  // ---- gather input ----
  let inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
  let inputZ = (move.forward ? 1 : 0) - (move.backward ? 1 : 0);
  if (joyVec.x !== 0 || joyVec.y !== 0) {
    inputX = joyVec.x;
    inputZ = joyVec.y;
  }
  const hasInput = Math.abs(inputX) > 0.001 || Math.abs(inputZ) > 0.001;

  // camera-relative movement basis (yaw only)
  forwardVec.set(Math.sin(camYaw), 0, Math.cos(camYaw));
  rightVec.set(-Math.cos(camYaw), 0, Math.sin(camYaw));

  const moveDir = new THREE.Vector3();
  moveDir.addScaledVector(forwardVec, -inputZ);
  moveDir.addScaledVector(rightVec, inputX);
  if (moveDir.lengthSq() > 0.0001) moveDir.normalize();

  // ---- determine speed / state ----
  let speed;
  if (flying) {
    speed = move.run ? SPEED_FLY_FAST : SPEED_FLY;
  } else if (sliding) {
    speed = SLIDE_SPEED;
  } else if (posture === 'prone') {
    speed = SPEED_PRONE;
  } else if (posture === 'crouch') {
    speed = SPEED_CROUCH;
  } else {
    speed = move.run ? SPEED_RUN : SPEED_WALK;
  }

  const nextPos = player.position.clone();

  if (flying) {
    // full 3D camera-relative flight (Minecraft creative-style): pitch tilts your
    // forward vector up/down, Space ascends, C descends, Shift boosts speed.
    const flyForward = new THREE.Vector3(
      Math.sin(camYaw) * Math.cos(camPitch),
      -Math.sin(camPitch),
      Math.cos(camYaw) * Math.cos(camPitch)
    );
    const flyRight = rightVec;
    const flyDir = new THREE.Vector3();
    flyDir.addScaledVector(flyForward, -inputZ);
    flyDir.addScaledVector(flyRight, inputX);
    let vertical = (flyUp ? 1 : 0) - (flyDown ? 1 : 0);
    if (flyDir.lengthSq() > 0.0001 || vertical !== 0) {
      if (flyDir.lengthSq() > 0.0001) flyDir.normalize();
      nextPos.addScaledVector(flyDir, speed * dt);
      nextPos.y += vertical * FLY_VERTICAL_SPEED * dt;
      if (flyDir.lengthSq() > 0.0001) {
        const targetFacing = Math.atan2(flyDir.x, flyDir.z);
        let diff = targetFacing - playerFacing;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        playerFacing += diff * Math.min(1, dt * 10);
      }
    }
    nextPos.y = Math.max(nextPos.y, GROUND_Y); // don't fly below ground level
  } else if (sliding) {
    slideTimer -= dt;
    nextPos.addScaledVector(slideDir, speed * dt);
    if (slideTimer <= 0) {
      sliding = false;
      posture = 'stand';
    }
  } else {
    if (hasInput) {
      nextPos.addScaledVector(moveDir, speed * dt);
      // face movement direction
      const targetFacing = Math.atan2(moveDir.x, moveDir.z);
      let diff = targetFacing - playerFacing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      playerFacing += diff * Math.min(1, dt * 10);
      slideDir.copy(moveDir); // remember last movement direction in case a slide starts next
    }
  }

  if (flying) {
    verticalVelocity = 0;
    onGround = false;
  } else {
    // gravity / jump
    verticalVelocity -= GRAVITY * dt;
    nextPos.y += verticalVelocity * dt;
    if (nextPos.y <= GROUND_Y) {
      nextPos.y = GROUND_Y;
      if (!onGround && isJumping) {
        jumpPhase = 'land';
        fadeToAction('Jump_Land', 0.08);
        setTimeout(() => { if (jumpPhase === 'land') { isJumping = false; jumpPhase = 'none'; } }, 280);
      }
      verticalVelocity = 0;
      onGround = true;
    } else {
      onGround = false;
    }
  }

  if (!flying) resolveCollisions(nextPos);

  player.position.copy(nextPos);
  ensureTerrainAround(nextPos.x, nextPos.z);

  // apply posture height + lean to the character model
  if (characterModel) {
    characterModel.position.y = postureTargetHeight * postureBlend;
    characterModel.rotation.x = postureTargetLean * postureBlend;
    characterModel.rotation.y = playerFacing;
  }

  // ---- animation state machine ----
  if (mixer) {
    if (swinging) {
      // Use_Item plays once via fadeToAction in trySwingSword(); don't override it here.
    } else if (flying) {
      // Use the airborne idle pose as a "gliding" look while flying free.
      fadeToAction('Jump_Idle', 0.2);
    } else if (isJumping) {
      if (jumpPhase === 'start') {
        fadeToAction('Jump_Start', 0.05);
        if (!onGround) jumpPhase = 'air';
      } else if (jumpPhase === 'air') {
        fadeToAction('Jump_Idle', 0.15);
      }
      // 'land' phase handled above via fadeToAction('Jump_Land', ...)
    } else if (sliding) {
      fadeToAction('Jump_Full_Long', 0.1); // closest available low, stretched-out pose for a slide look
    } else if (hasInput) {
      if (posture === 'prone') {
        fadeToAction('Idle_B', 0.2); // crawling look approximated via lean + slow idle blend
      } else if (posture === 'crouch') {
        fadeToAction('Walking_C', 0.2);
      } else if (move.run) {
        fadeToAction('Running_A', 0.15);
      } else {
        fadeToAction('Walking_A', 0.2);
      }
    } else {
      if (posture === 'crouch') {
        fadeToAction('Idle_B', 0.2);
      } else if (posture === 'prone') {
        fadeToAction('Idle_B', 0.2);
      } else {
        fadeToAction('Idle_A', 0.25);
      }
    }
    // speed up/slow down the locomotion clip playback rate a little with actual speed for realism
    if (currentAction) {
      const isLocomotion = ['Walking_A', 'Walking_C', 'Running_A'].includes(currentAction.getClip().name);
      currentAction.timeScale = isLocomotion ? (hasInput ? 1 : 1) : 1;
    }
    mixer.update(dt);
  }

  // ---- third-person orbit camera follow ----
  camOffset.set(
    Math.sin(camYaw) * -CAM_DISTANCE * Math.cos(camPitch),
    CAM_DISTANCE * Math.sin(camPitch) + 0.28,
    Math.cos(camYaw) * -CAM_DISTANCE * Math.cos(camPitch)
  );
  desiredCamPos.copy(player.position).add(camOffset);
  camera.position.lerp(desiredCamPos, Math.min(1, dt * 9));

  camLookTarget.copy(player.position);
  camLookTarget.y += 0.23;
  camera.lookAt(camLookTarget);

  // sun follows player loosely
  sun.position.set(player.position.x + 20, player.position.y + 30, player.position.z + 10);
  sun.target.position.copy(player.position);
  sun.target.updateMatrixWorld();

  // ---- gear: melee swing / bow draw, projectiles, NPCs ----
  updateWeaponTransform();
  updateSwordSwing(dt);
  updateArrows(dt);
  updateNPCs(dt);

  renderer.render(scene, camera);
}

// ================================================================
// ---------- Gear: sword + shield (KayKit Adventurers), hand-tracked ----------
// ================================================================

const weaponRig = new THREE.Group(); // holds the sword (right hand)
const shieldRig = new THREE.Group(); // holds the shield (left hand)
let handBone = null;

function loadWeaponModel(path) {
  return new Promise((resolve, reject) => {
    loader.load('assets/' + path, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

let swordModel = null;
let shieldModel = null;
let axeModel = null;
let bowModel = null;
let arrowTemplate = null;

// ---- Weapon loadout: cycle between Sword&Shield / Bow / Axe&Shield ----
const WEAPONS = ['sword', 'bow', 'axe'];
const WEAPON_LABELS = { sword: 'SWORD & SHIELD', bow: 'BOW', axe: 'AXE & SHIELD' };
let weaponIndex = 0;
let currentWeapon = WEAPONS[0];

function setWeaponVisibility() {
  if (swordModel) swordModel.visible = currentWeapon === 'sword';
  if (axeModel) axeModel.visible = currentWeapon === 'axe';
  if (bowModel) bowModel.visible = currentWeapon === 'bow';
  if (shieldModel) shieldModel.visible = (currentWeapon === 'sword' || currentWeapon === 'axe');
  const label = document.getElementById('weaponLabel');
  if (label) label.textContent = WEAPON_LABELS[currentWeapon];
}

function cycleWeapon() {
  weaponIndex = (weaponIndex + 1) % WEAPONS.length;
  currentWeapon = WEAPONS[weaponIndex];
  setWeaponVisibility();
}

async function setupWeapons() {
  const [swordScene, shieldScene, axeScene, bowScene, arrowScene] = await Promise.all([
    loadWeaponModel('gear/sword_1handed.gltf'),
    loadWeaponModel('gear/shield_round.gltf'),
    loadWeaponModel('gear/axe_1handed.gltf'),
    loadWeaponModel('gear/bow_withString.gltf'),
    loadWeaponModel('gear/arrow_bow.gltf'),
  ]);

  [swordScene, shieldScene, axeScene, bowScene, arrowScene].forEach(s => {
    s.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  });

  swordModel = swordScene;
  shieldModel = shieldScene;
  axeModel = axeScene;
  bowModel = bowScene;
  arrowTemplate = arrowScene;

  // bow's long axis is local Z; rotate so it stands upright like the sword/axe (local Y = length)
  bowModel.rotation.x = -Math.PI / 2;

  weaponRig.add(swordScene, axeScene);
  shieldRig.add(shieldScene, bowScene);

  setWeaponVisibility();
}
const weaponsReady = setupWeapons();

function findHandBones() {
  if (!characterModel) return null;
  let rightSlot = null, leftSlot = null, rightHand = null, leftHand = null;
  characterModel.traverse(o => {
    if (!o.isBone) return;
    if (o.name === 'handslot.r') rightSlot = o;
    if (o.name === 'handslot.l') leftSlot = o;
    if (o.name === 'hand.r') rightHand = o;
    if (o.name === 'hand.l') leftHand = o;
  });
  if (rightSlot && leftSlot) return { right: rightSlot, left: leftSlot, usingSlot: true };
  if (rightHand && leftHand) return { right: rightHand, left: leftHand, usingSlot: false };
  return null;
}

let leftHandBone = null;
let attachedViaSlot = true;

// ---- Sizing: sword/shield must read as human-scale gear, not oversized props ----
const HAND_BONE_WORLD_LEN = 0.007382583618164063; // wrist.r -> hand.r, world units at CHAR_SCALE 0.10
const TARGET_SWORD_WORLD_LEN = HAND_BONE_WORLD_LEN * 12; // blade+hilt total length
const TARGET_SHIELD_WORLD_LEN = HAND_BONE_WORLD_LEN * 9; // shield diameter
const SWORD_RAW_LENGTH = 1.4095 + 0.3658; // gltf bbox span along local Y (grip to tip)
const SHIELD_RAW_LENGTH = 0.4413 * 2; // gltf bbox span along local X (diameter)

// ---- Bow, Axe & Arrow: same hand-bone-relative sizing convention as sword/shield ----
const TARGET_BOW_WORLD_LEN = HAND_BONE_WORLD_LEN * 17;   // bow stave height
const TARGET_AXE_WORLD_LEN = HAND_BONE_WORLD_LEN * 11;   // 1-handed axe, head+haft
const TARGET_ARROW_WORLD_LEN = HAND_BONE_WORLD_LEN * 11; // loose arrow projectile
const BOW_RAW_LENGTH = 1.9837043285369873;   // bow_withString.gltf bbox span along local Z
const AXE_RAW_LENGTH = 1.2444227039813995;   // axe_1handed.gltf bbox span along local Y
const ARROW_RAW_LENGTH = 1.2614648342132568; // arrow_bow.gltf bbox span along local Z

function attachWeaponsToHand() {
  const bones = findHandBones();
  if (!bones) return false;
  handBone = bones.right;
  leftHandBone = bones.left;
  attachedViaSlot = bones.usingSlot;
  // Parent both rigs to the scene root (not to the hand bones) — we track each hand's
  // world position every frame instead, and lock rotation to playerFacing so the sword
  // and shield don't swing wildly with the walk/idle animation's hand bone rotation.
  scene.add(weaponRig);
  scene.add(shieldRig);

  const swordScale = TARGET_SWORD_WORLD_LEN / SWORD_RAW_LENGTH;
  const shieldScale = TARGET_SHIELD_WORLD_LEN / SHIELD_RAW_LENGTH;
  const axeScale = TARGET_AXE_WORLD_LEN / AXE_RAW_LENGTH;
  const bowScale = TARGET_BOW_WORLD_LEN / BOW_RAW_LENGTH;
  if (swordModel) swordModel.scale.setScalar(swordScale);
  if (shieldModel) shieldModel.scale.setScalar(shieldScale);
  if (axeModel) axeModel.scale.setScalar(axeScale);
  if (bowModel) bowModel.scale.setScalar(bowScale);

  return true;
}

// Every frame: position sword at the right hand, shield at the left hand, both oriented
// to the character's current facing (playerFacing) so they stay upright and forward-facing
// regardless of the underlying walk-cycle hand-bone rotation.
const rightHandWorldPos = new THREE.Vector3();
const leftHandWorldPos = new THREE.Vector3();
const facingQuat = new THREE.Quaternion();
const worldUpAxis = new THREE.Vector3(0, 1, 0);

function updateWeaponTransform() {
  const forward = new THREE.Vector3(Math.sin(playerFacing), 0, Math.cos(playerFacing));
  const right = new THREE.Vector3().crossVectors(worldUpAxis, forward).normalize();

  if (handBone) {
    handBone.getWorldPosition(rightHandWorldPos);
    weaponRig.position.copy(rightHandWorldPos);
    // sword_1handed.gltf's blade runs along local +Y with the grip near the origin, so we
    // want local +Y -> world up, local +X -> forward (blade held pointing up/forward).
    const m = new THREE.Matrix4().makeBasis(right, worldUpAxis, forward);
    facingQuat.setFromRotationMatrix(m);
    weaponRig.quaternion.copy(facingQuat);
    weaponRig.rotateZ(swordSwingAngle);
  }

  if (leftHandBone) {
    leftHandBone.getWorldPosition(leftHandWorldPos);
    shieldRig.position.copy(leftHandWorldPos);
    // shield faces outward (forward), flat face toward the camera/enemies
    const m2 = new THREE.Matrix4().makeBasis(right, worldUpAxis, forward);
    shieldRig.quaternion.setFromRotationMatrix(m2);
  }
}

// ---------- Weapon-aware attack (tap to swing melee weapon or fire an arrow) ----------
let swordSwingAngle = 0;
let swinging = false;
let swingTimer = 0;
const SWING_DURATION = 0.35;
let meleeHitApplied = false; // one hit-test per swing, reset when a new swing starts

const MELEE_RANGE = 1.15;               // world units in front of the player
const MELEE_ARC = THREE.MathUtils.degToRad(65); // half-angle of the hit cone

function tryAttack() {
  if (swinging) return;
  swinging = true;
  swingTimer = 0;
  meleeHitApplied = false;
  if (currentWeapon === 'bow') {
    fadeToAction('Throw', 0.05);
    // release the arrow partway through the draw animation
    setTimeout(() => { if (currentWeapon === 'bow') shootArrow(); }, 160);
  } else {
    fadeToAction('Use_Item', 0.05);
  }
}

function updateSwordSwing(dt) {
  if (!swinging) { swordSwingAngle = 0; return; }
  swingTimer += dt;
  const duration = currentWeapon === 'bow' ? 0.5 : SWING_DURATION;
  const t = Math.min(1, swingTimer / duration);
  if (currentWeapon !== 'bow') {
    // quick arc: 0 -> -2.2 rad -> settle back to 0 (wide forehand slash)
    swordSwingAngle = Math.sin(t * Math.PI) * -1.9;
    if (t >= 0.5 && !meleeHitApplied) {
      meleeHitApplied = true;
      meleeHitCheck();
    }
  } else {
    swordSwingAngle = 0;
  }
  if (t >= 1) {
    swinging = false;
    swordSwingAngle = 0;
  }
}

function meleeHitCheck() {
  for (const npc of npcs) {
    if (npc.state === 'dead') continue;
    const dx = npc.group.position.x - player.position.x;
    const dz = npc.group.position.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > MELEE_RANGE) continue;
    const angleToNpc = Math.atan2(dx, dz);
    let diff = angleToNpc - playerFacing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (Math.abs(diff) <= MELEE_ARC) damageNPC(npc, 1);
  }
}

// ---------- Arrow projectiles (bow) ----------
const arrows = [];
const ARROW_SPEED = 13;
const ARROW_LIFETIME = 2.2;
const ARROW_HIT_RADIUS = 0.55;

function shootArrow() {
  if (!arrowTemplate) return;
  const arrow = arrowTemplate.clone(true);
  const scale = TARGET_ARROW_WORLD_LEN / ARROW_RAW_LENGTH;
  arrow.scale.setScalar(scale);

  const forward = new THREE.Vector3(Math.sin(playerFacing), 0, Math.cos(playerFacing));
  const right = new THREE.Vector3().crossVectors(worldUpAxis, forward).normalize();
  const m = new THREE.Matrix4().makeBasis(right, worldUpAxis, forward);
  arrow.quaternion.setFromRotationMatrix(m);

  const startPos = player.position.clone();
  startPos.y += 0.22;
  startPos.addScaledVector(forward, 0.12);
  arrow.position.copy(startPos);
  scene.add(arrow);

  arrows.push({ mesh: arrow, dir: forward.clone(), life: ARROW_LIFETIME });
}

function updateArrows(dt) {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.life -= dt;
    a.mesh.position.addScaledVector(a.dir, ARROW_SPEED * dt);

    let hit = false;
    if (a.life > ARROW_LIFETIME - 0.05) hit = false; // don't hit-test the instant it spawns
    else {
      for (const npc of npcs) {
        if (npc.state === 'dead') continue;
        const dist = a.mesh.position.distanceTo(npc.group.position);
        if (dist <= ARROW_HIT_RADIUS) { damageNPC(npc, 1); hit = true; break; }
      }
    }

    if (hit || a.life <= 0) {
      scene.remove(a.mesh);
      arrows.splice(i, 1);
    }
  }
}

const attackBtn = document.getElementById('attackBtn');
if (attackBtn) {
  const doAttack = (e) => { tryAttack(); if (e) e.preventDefault(); };
  attackBtn.addEventListener('touchstart', doAttack, { passive: false });
  attackBtn.addEventListener('click', doAttack);
}
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 0) tryAttack();
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' || e.code === 'KeyF') tryAttack();
  if (e.code === 'KeyQ') cycleWeapon();
});

const weaponBtn = document.getElementById('weaponBtn');
if (weaponBtn) {
  const doSwitch = (e) => { cycleWeapon(); if (e) e.preventDefault(); };
  weaponBtn.addEventListener('touchstart', doSwitch, { passive: false });
  weaponBtn.addEventListener('click', doSwitch);
}

Promise.all([charReady, weaponsReady]).then(() => {
  const tryAttach = () => {
    if (!attachWeaponsToHand()) {
      requestAnimationFrame(tryAttach);
    }
  };
  tryAttach();
});

NPC_DEFS.forEach(def => { spawnNPC(def).catch(e => console.warn('NPC load fail', def.file, e)); });

Promise.all([villageReady, charReady, weaponsReady]).finally(() => {
  animate();
});

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});