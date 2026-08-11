import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { SimulationUI } from './simulationUI.js';
import { parseNctFile, parseEfdFile, parseEpoFile, parseEpdFile, parseAngleHeadIni, parseNcmClampGeo } from './databaseParser.js';
import { createToolMesh, createFixtureMesh, createProfileMesh, guessKind } from './toolVisualizer.js';

// ============================================================================
// elumatec SBZ 151 — Full 3D Machine Model
// All dimensions from SBZ151.ncm, Stops.dbn (C_151_Mes_U), Collision_Box151.ncs
//
// MACHINE COORDINATE SYSTEM (elumatec):
//   X = along bar (length), Y = depth (neg=front), Z = height (pos=up)
//
// KINEMATIC CHAIN (from preview.ncs analysis):
//   headX (X translation along portal beam)
//     └─ headYZ (Y+Z translation — origin = tool tip when A=0, C=0)
//          └─ cPivot at (75, 0, 201.1) from headYZ — C rotation around Z
//               ├─ gearboxOffset at (-150, 0, 0) — gearbox/C-box (rotates ONLY with C, NOT A)
//               │    └─ gearboxGroup (7 BoxGear entries, Z=0 = A-pivot height)
//               └─ aPivot at (0, 0, 0) — A tilt around X (PAngleX)
//                    └─ spindleOffset at (-75, 0, -201.1) — spindle nose
//                         ├─ spindleGroup (5 BoxSpindle, Z=0=nose, body up in +Z)
//                         └─ toolGroup (below nose in -Z)
//
// NCM: SpindleDisplacementA=201.1, SpindleDisplacementC=75
//      XMachineOffsetC=75, ZMachineOffsetC=-201.1
// ============================================================================

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 80000);
camera.position.set(4000, -3500, 2500);
camera.up.set(0, 0, 1);
camera.layers.enable(1);           // render layer 1 (sky dome) — raycaster ignores it

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(2500, -200, -50);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 50;
controls.maxDistance = 30000;
controls.enableZoom = false;              // We handle zoom ourselves (towards mouse)
controls.update();

// --- CAD-style orbit pivot + zoom ------------------------------------------
// Orbit: When left-dragging on a surface, we rotate the camera around the
//   surface point under the cursor (pivot). OrbitControls' own rotation is
//   disabled during this custom orbit; we handle it manually so there is zero
//   visual jump when the drag starts.
// Zoom: dolly camera + target together along forward axis.
//   Step size proportional to surface distance (close = small, far = large).
// If mouse is over empty space (sky), OrbitControls' default behaviour is used.
const _navRaycaster = new THREE.Raycaster();
_navRaycaster.layers.set(0);       // only intersect layer 0 (skip sky dome on layer 1)
const _navMouse = new THREE.Vector2();

/** Raycast from a mouse event into scene. Returns hit or null. */
function _navHitTest(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  _navMouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _navMouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  _navRaycaster.setFromCamera(_navMouse, camera);
  const hits = _navRaycaster.intersectObjects(scene.children, true);
  return hits.length > 0 ? hits[0] : null;
}

// -- Custom orbit around surface pivot --
let _orbitActive = false;          // true while custom-orbit dragging
let _orbitPivot = null;            // THREE.Vector3 — world-space pivot point
let _orbitPrevX = 0;               // previous mouse screenX
let _orbitPrevY = 0;               // previous mouse screenY

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;     // only left button = orbit
  const hit = _navHitTest(ev);
  if (!hit) return;                // nothing hit → let OrbitControls handle it

  // Activate custom orbit, disable OrbitControls rotation
  _orbitActive = true;
  _orbitPivot = hit.point.clone();
  _orbitPrevX = ev.clientX;
  _orbitPrevY = ev.clientY;
  controls.enableRotate = false;   // prevent OrbitControls from also rotating
});

window.addEventListener('pointermove', (ev) => {
  if (!_orbitActive) return;

  const dx = ev.clientX - _orbitPrevX;
  const dy = ev.clientY - _orbitPrevY;
  _orbitPrevX = ev.clientX;
  _orbitPrevY = ev.clientY;
  if (dx === 0 && dy === 0) return;

  // Rotation speeds (radians per pixel)
  const rotSpeed = 0.005;
  const angleH = -dx * rotSpeed;   // horizontal → rotate around world Z (up)
  const angleV = -dy * rotSpeed;   // vertical   → rotate around camera right

  const pivot = _orbitPivot;

  // --- Rotate camera position around pivot ---
  const offset = camera.position.clone().sub(pivot);

  // Horizontal rotation: around world-up axis (Z)
  const qH = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), angleH
  );
  offset.applyQuaternion(qH);

  // Vertical rotation: around camera's local right axis
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const qV = new THREE.Quaternion().setFromAxisAngle(right, angleV);
  offset.applyQuaternion(qV);

  // Apply new camera position
  camera.position.copy(pivot).add(offset);

  // --- Also rotate controls.target around pivot by the same rotation ---
  const tOffset = controls.target.clone().sub(pivot);
  tOffset.applyQuaternion(qH);
  tOffset.applyQuaternion(qV);
  controls.target.copy(pivot).add(tOffset);

  controls.update();
});

window.addEventListener('pointerup', (ev) => {
  if (!_orbitActive) return;
  _orbitActive = false;
  _orbitPivot = null;
  controls.enableRotate = true;    // re-enable OrbitControls rotation
});

// -- Zoom: dolly towards/away from point under mouse cursor --
// Always zooms toward a surface hit (floor, machine, profile, etc.).
// If nothing is hit (pointing at sky), use forward direction toward controls.target.
let _zoomDelta = 0;
let _zoomDir = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();

renderer.domElement.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const hit = _navHitTest(ev);

  if (hit) {
    // Zoom towards the hit point under the cursor
    _zoomDir.subVectors(hit.point, camera.position).normalize();
    const step = hit.distance * 0.12;
    _zoomDelta += ev.deltaY < 0 ? step : -step;
  } else {
    // Nothing hit (sky) → zoom along camera forward (toward controls.target)
    // Keep _zoomDir unchanged (last known good direction), use target distance for step
    _zoomDir.subVectors(controls.target, camera.position).normalize();
    const dist = camera.position.distanceTo(controls.target);
    const step = dist * 0.12;
    _zoomDelta += ev.deltaY < 0 ? step : -step;
  }
}, { passive: false });

// ---------------------------------------------------------------------------

// --- Procedural environment map for reflections ---
const pmremGen = new THREE.PMREMGenerator(renderer);
pmremGen.compileEquirectangularShader();
{
  const envScene = new THREE.Scene();
  // Gradient sky dome
  const skyGeo = new THREE.SphereGeometry(500, 32, 32);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x88aadd) },
      midColor: { value: new THREE.Color(0xccddee) },
      bottomColor: { value: new THREE.Color(0x666666) },
    },
    vertexShader: `varying vec3 vWP; void main(){vWP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `
      uniform vec3 topColor, midColor, bottomColor;
      varying vec3 vWP;
      void main(){
        float h = normalize(vWP).y;
        vec3 col = h > 0.0 ? mix(midColor, topColor, h) : mix(midColor, bottomColor, -h);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));
  // Bright area lights for reflections
  const panelGeo = new THREE.PlaneGeometry(300, 300);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const p1 = new THREE.Mesh(panelGeo, panelMat);
  p1.position.set(0, 200, 100); p1.lookAt(0, 0, 0);
  envScene.add(p1);
  const p2 = new THREE.Mesh(panelGeo, panelMat);
  p2.position.set(-200, 100, 50); p2.lookAt(0, 0, 0);
  envScene.add(p2);

  const envMap = pmremGen.fromScene(envScene, 0.04).texture;
  scene.environment = envMap;
  envScene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  pmremGen.dispose();
}

// --- Sky background ---
scene.background = new THREE.Color(0x87CEEB);
{
  const g = new THREE.SphereGeometry(30000, 32, 32);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x4477bb) },
      horizonColor: { value: new THREE.Color(0xc8ddf0) },
      bottomColor: { value: new THREE.Color(0x888888) },
    },
    vertexShader: `varying vec3 vWP; void main(){vWP=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `
      uniform vec3 topColor, horizonColor, bottomColor;
      varying vec3 vWP;
      void main(){
        float h = normalize(vWP).z;
        vec3 col = h > 0.0
          ? mix(horizonColor, topColor, pow(h, 0.5))
          : mix(horizonColor, bottomColor, pow(-h, 0.3));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide
  });
  const skyDome = new THREE.Mesh(g, m);
  skyDome.layers.set(1);           // layer 1 = non-pickable (camera only renders layer 0+1, raycaster only checks layer 0)
  scene.add(skyDome);
}

// --- Lighting ---
const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x556644, 1.2);
hemiLight.layers.enableAll();  // visible on all layers (including spindle cam)
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff8ee, 3.0);
sunLight.position.set(4000, -5000, 8000);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
sunLight.shadow.camera.left = -8000; sunLight.shadow.camera.right = 12000;
sunLight.shadow.camera.top = 5000; sunLight.shadow.camera.bottom = -5000;
sunLight.shadow.camera.near = 1000; sunLight.shadow.camera.far = 25000;
sunLight.shadow.bias = -0.0002;
sunLight.shadow.normalBias = 0.5;
scene.add(sunLight);
const fill = new THREE.DirectionalLight(0x99aabb, 1.0); fill.position.set(-4000, -3000, 3000); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffddaa, 0.7); rim.position.set(2000, 5000, 1000); scene.add(rim);
const bounce = new THREE.DirectionalLight(0x667788, 0.5); bounce.position.set(0, 0, -3000); scene.add(bounce);
// Enable lights on layer 2 (spindle cam)
[sunLight, fill, rim, bounce].forEach(l => { l.layers.enable(2); });
// HemisphereLight is anonymous, enable on all scene children that are lights later

// --- Materials (realistic industrial PBR) ---

// Procedural subtle noise for bump
function makeNoiseTex(size, intensity) {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = 128 + (Math.random() - 0.5) * intensity * 255;
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.needsUpdate = true;
  return tex;
}
const bumpFine = makeNoiseTex(128, 0.06);
const bumpMed = makeNoiseTex(64, 0.12);
const bumpCoarse = makeNoiseTex(64, 0.2);

const mat = {
  // Machine bed — medium grey cast iron
  bed: new THREE.MeshStandardMaterial({
    color: 0x606060, roughness: 0.6, metalness: 0.65,
    bumpMap: bumpCoarse, bumpScale: 0.2,
  }),
  // Precision ground rails — bright polished steel
  rail: new THREE.MeshStandardMaterial({
    color: 0xbbbbbb, roughness: 0.06, metalness: 0.98,
    envMapIntensity: 1.8,
  }),
  // Spindle motor housing — light grey aluminium
  spindle: new THREE.MeshStandardMaterial({
    color: 0xd0d0d0, roughness: 0.25, metalness: 0.9,
    bumpMap: bumpFine, bumpScale: 0.06,
    envMapIntensity: 1.3,
  }),
  // Gearbox / C-box — grey aluminium, slightly warmer
  gearbox: new THREE.MeshStandardMaterial({
    color: 0xaaa8a4, roughness: 0.3, metalness: 0.88,
    bumpMap: bumpFine, bumpScale: 0.05,
    envMapIntensity: 1.1,
  }),
  // Portal beam casting — grey steel like clamps
  casting: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpCoarse, bumpScale: 0.2,
  }),
  // Clamp back plate (Spannerrücken, S2) — grey steel
  clampBack: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Clamp inner body (S4) — grey steel
  clampInner: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Clamp bracket behind (S5) — grey steel
  clampBracket: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Clamp base beam (Querträger) — dark grey with reflection
  clampBase: new THREE.MeshStandardMaterial({
    color: 0x606060, roughness: 0.3, metalness: 0.85,
    bumpMap: bumpMed, bumpScale: 0.08,
    envMapIntensity: 1.2,
  }),
  // Clamp jaw top (Packenrücken) — grey steel
  clampJawTop: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Clamp jaw body (Auflager+Grundkörper) — grey steel
  clampJawBody: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Green plastic pads on clamps (Kunststoffplatten)
  clampFix: new THREE.MeshStandardMaterial({
    color: 0x44cc66, roughness: 0.45, metalness: 0.02,
    envMapIntensity: 0.3,
  }),
  // elumatec orange accent panels / guards
  orange: new THREE.MeshStandardMaterial({
    color: 0xff7040, roughness: 0.45, metalness: 0.12,
    envMapIntensity: 0.5,
  }),
  // Stop / Anslag — bright steel plate
  stop: new THREE.MeshStandardMaterial({
    color: 0x9a9a9a, roughness: 0.25, metalness: 0.88,
    bumpMap: bumpFine, bumpScale: 0.06,
    envMapIntensity: 1.0,
  }),
  // Stop base — orange accent
  stopBase: new THREE.MeshStandardMaterial({
    color: 0xff7040, roughness: 0.4, metalness: 0.15,
  }),
  // Aluminium profile workpiece — bright reflective
  profile: new THREE.MeshStandardMaterial({
    color: 0xeeeeee, roughness: 0.18, metalness: 0.88,
    envMapIntensity: 1.2,
  }),
  // Tool — HSS/carbide blue-steel
  tool: new THREE.MeshStandardMaterial({
    color: 0x4488dd, roughness: 0.1, metalness: 0.95,
    envMapIntensity: 1.5,
  }),
  // Sheet metal covers
  sheetMetal: new THREE.MeshStandardMaterial({
    color: 0x686868, roughness: 0.45, metalness: 0.55,
    bumpMap: bumpFine, bumpScale: 0.04,
  }),
  // Concrete factory floor
  concrete: new THREE.MeshStandardMaterial({
    color: 0x999999, roughness: 0.9, metalness: 0.0,
    bumpMap: bumpCoarse, bumpScale: 0.5,
  }),
  // Collision boxes — same grey as clamps
  collWire: new THREE.MeshStandardMaterial({
    color: 0x808080, roughness: 0.4, metalness: 0.7,
    bumpMap: bumpMed, bumpScale: 0.1,
  }),
  // Fixture — yellow for visibility
  fixture: new THREE.MeshStandardMaterial({
    color: 0xcccc00, roughness: 0.4, metalness: 0.5,
    bumpMap: bumpMed, bumpScale: 0.08,
    envMapIntensity: 1.0,
  }),
  // Tool holder/mount — slightly darker
  mount: new THREE.MeshStandardMaterial({
    color: 0x888888, roughness: 0.25, metalness: 0.85,
    bumpMap: bumpFine, bumpScale: 0.04,
    envMapIntensity: 1.2,
  }),
  // Angle head body — dark grey steel
  angleHead: new THREE.MeshStandardMaterial({
    color: 0x707070, roughness: 0.35, metalness: 0.8,
    bumpMap: bumpMed, bumpScale: 0.08,
    envMapIntensity: 1.0,
  }),
  // Angle head mount interface — slightly lighter
  angleHeadMount: new THREE.MeshStandardMaterial({
    color: 0x909090, roughness: 0.2, metalness: 0.9,
    bumpMap: bumpFine, bumpScale: 0.04,
    envMapIntensity: 1.3,
  }),
};

function ncmBox(expX, expY, expZ, offX, offY, offZ, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(expX, expY, expZ), material);
  mesh.position.set(offX + expX / 2, offY + expY / 2, offZ + expZ / 2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// --- Factory floor — large concrete slab below the machine ---
// Ensures raycast always hits something (no zooming into void).
// Machine bed bottom at Z ≈ -500. Floor sits flush at Z = -502.
// PlaneGeometry default: XY plane, normal = +Z. Since our up-axis is Z, this is a
// horizontal floor — no rotation needed, just position at Z = -502.
{
  const floorGeo = new THREE.PlaneGeometry(30000, 20000);
  const floor = new THREE.Mesh(floorGeo, mat.concrete);
  floor.position.set(4000, -200, -502);
  floor.receiveShadow = true;
  scene.add(floor);
}

// ============================================================================
// MACHINE BED (static)
// ============================================================================
const bedGroup = new THREE.Group(); bedGroup.name = 'bed';
bedGroup.add(ncmBox(11000, 30, 30, -1200, -475, -225, mat.bed));
bedGroup.add(ncmBox(11000, 18, 17, -1200, -400, -212, mat.rail));
bedGroup.add(ncmBox(11000, 18, 17, -1200, -24, -212, mat.rail));
bedGroup.add(ncmBox(11000, 30, 135, -1200, -30, -347, mat.bed));
bedGroup.add(ncmBox(11000, 30, 135, -1200, -405, -347, mat.bed));
bedGroup.add(ncmBox(11000, 345, 1, -1200, -375, -245, mat.sheetMetal));
bedGroup.add(ncmBox(11000, 34, 80, -1200, 0, -292, mat.bed));
bedGroup.add(ncmBox(11000, 5, 270, -1200, -485, -500, mat.orange));
bedGroup.add(ncmBox(11000, 5, 270, -1200, 45, -500, mat.orange));
bedGroup.add(ncmBox(11000, 12, 5, -1200, -480, -230, mat.orange));
bedGroup.add(ncmBox(11000, 12, 5, -1200, 34, -230, mat.orange));
for (let x = -500; x <= 9000; x += 1500) bedGroup.add(ncmBox(200, 520, 18, x - 100, -470, -500, mat.bed));
scene.add(bedGroup);

// ============================================================================
// SPINDLE HEAD — correct kinematic chain per preview.ncs
// ============================================================================
const headX = new THREE.Group(); headX.name = 'headX';

const portalBeam = new THREE.Group(); portalBeam.name = 'portalBeam';
portalBeam.add(ncmBox(1170, 80, 1295, -585, 720, -270, mat.casting));
portalBeam.add(ncmBox(1200, 100, 30, -600, 700, 1025, mat.bed));
headX.add(portalBeam);

const headYZ = new THREE.Group(); headYZ.name = 'headYZ';
headX.add(headYZ);

// Collision boxes — default hidden
const collisionGroup = new THREE.Group(); collisionGroup.name = 'collision';
collisionGroup.add(ncmBox(25, 160, 581, -400, 560, -231, mat.collWire));
collisionGroup.add(ncmBox(25, 310, 430, -400, 410, -80, mat.collWire));
collisionGroup.add(ncmBox(25, 460, 280, -400, 260, 70, mat.collWire));
collisionGroup.add(ncmBox(25, 610, 130, -400, 110, 220, mat.collWire));
collisionGroup.add(ncmBox(25, 160, 581, 375, 560, -231, mat.collWire));
collisionGroup.add(ncmBox(25, 310, 430, 375, 410, -80, mat.collWire));
collisionGroup.add(ncmBox(25, 460, 280, 375, 260, 70, mat.collWire));
collisionGroup.add(ncmBox(25, 610, 130, 375, 110, 220, mat.collWire));
collisionGroup.add(ncmBox(78, 480, 220, -375, 240, 130, mat.collWire));
collisionGroup.add(ncmBox(78, 480, 220, 297, 240, 130, mat.collWire));
collisionGroup.add(ncmBox(25, 700, 450, 375, 20, -100, mat.collWire));
collisionGroup.add(ncmBox(1170, 80, 1295, -585, 720, -270, mat.collWire));
headYZ.add(collisionGroup);

// C-AXIS PIVOT
const cPivot = new THREE.Group(); cPivot.name = 'cPivot';
cPivot.position.set(75, 0, 201.1);
headYZ.add(cPivot);

// GEARBOX (C-box) — sits on cPivot, rotates ONLY with C (not A!)
const gearboxOffset = new THREE.Group(); gearboxOffset.name = 'gearboxOffset';
gearboxOffset.position.set(-150, 0, 0);
cPivot.add(gearboxOffset);

const gearboxGroup = new THREE.Group(); gearboxGroup.name = 'gearbox';
gearboxGroup.add(ncmBox(363, 290, 180, -233, -145, 140, mat.gearbox));
gearboxGroup.add(ncmBox(194, 280, 56, -233, -140, 85, mat.gearbox));
gearboxGroup.add(ncmBox(194, 262, 85, -233, -131, 0, mat.gearbox));
gearboxGroup.add(ncmBox(194, 228, 85, -233, -114, -85, mat.gearbox));
gearboxGroup.add(ncmBox(194, 146, 27, -233, -73, -112, mat.gearbox));
gearboxGroup.add(ncmBox(11.1, 214, 182, -39, -107, -75, mat.gearbox));
gearboxGroup.add(ncmBox(11.1, 146, 32, -39, -73, -107, mat.gearbox));
gearboxOffset.add(gearboxGroup);

// A-AXIS PIVOT
const aPivot = new THREE.Group(); aPivot.name = 'aPivot';
cPivot.add(aPivot);

// SPINDLE — sits on aPivot, rotates with both A and C
const spindleOffset = new THREE.Group(); spindleOffset.name = 'spindleOffset';
spindleOffset.position.set(-75, 0, -201.1);
aPivot.add(spindleOffset);

// Spindle body (BoxSpindle: Z=0=nose, body extends UP in +Z)
const spindleGroup = new THREE.Group(); spindleGroup.name = 'spindle';
spindleGroup.add(ncmBox(73, 73, 9, -36.5, -36.5, 0, mat.spindle));
spindleGroup.add(ncmBox(115, 115, 49, -57.5, -57.5, 9, mat.spindle));
spindleGroup.add(ncmBox(152, 152, 26, -76, -76, 58, mat.spindle));
spindleGroup.add(ncmBox(154, 154, 305, -77, -77, 84, mat.spindle));
spindleGroup.add(ncmBox(26, 150, 300, -103, -75, 40, mat.spindle));
spindleOffset.add(spindleGroup);

// Tool (below spindle nose, extending down in -Z) — populated by setTool()
const toolGroup = new THREE.Group(); toolGroup.name = 'tool';
spindleOffset.add(toolGroup);

// Layer constants (declared early so buildAngleHead etc. can use them)
const SPINDLE_CAM_LAYER = 2; // objects visible in spindle cam viewport
const SIDE_VIEW_LAYER = 3;   // objects visible in side/end view viewport

// ANGLE HEAD (Winkelhaupt / WFK) — optional adapter for bottom machining
// Geometry loaded dynamically from AngleHead.ini via buildAngleHead()
// INI offsets are CENTER-based (not corner-based like NCM BoxStatic/BoxSpindle)
const angleHeadGroup = new THREE.Group(); angleHeadGroup.name = 'angleHead';
angleHeadGroup.visible = false; // hidden by default, toggled via UI
const angleHeadOutput = new THREE.Group(); angleHeadOutput.name = 'angleHeadOutput';
angleHeadGroup.add(angleHeadOutput);
spindleOffset.add(angleHeadGroup);

// Angle head output offset — used by IK compensation (updated by buildAngleHead)
let _ahOutputY = -58;   // default WFK2e Position0Y
let _ahOutputZ = -167;  // default WFK2e Position0Z

// Helper: create collision box from INI angle head convention.
// INI offset = center of TOP face, body extends DOWN in -Z.
function ahBox(lx, ly, lz, cx, cy, cz, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(lx, ly, lz), material);
  mesh.position.set(cx, cy, cz - lz / 2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/**
 * Build angle head 3D geometry from parsed AngleHead.ini data.
 * @param {Object} headDef — parsed AngleHeadDef from parseAngleHeadIni()
 */
function buildAngleHead(headDef) {
  // Clear existing geometry (keep angleHeadOutput group)
  while (angleHeadGroup.children.length > 0) {
    const child = angleHeadGroup.children[0];
    if (child === angleHeadOutput) { angleHeadGroup.remove(child); continue; }
    angleHeadGroup.remove(child);
    child.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  while (angleHeadOutput.children.length > 0) {
    const child = angleHeadOutput.children[0];
    angleHeadOutput.remove(child);
    child.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }

  if (!headDef) return;

  // Set output position from Position0
  const pos0 = headDef.positions[0] || { a: -90, c: 0, x: 0, y: -58, z: -167 };
  _ahOutputY = pos0.y;
  _ahOutputZ = pos0.z;
  angleHeadOutput.position.set(pos0.x, pos0.y, pos0.z);
  angleHeadOutput.rotation.set(pos0.a * Math.PI / 180, 0, pos0.c * Math.PI / 180);

  // Build collision boxes
  for (const col of headDef.collisionObjects) {
    const isMount = col.mount === 1;
    const material = isMount ? mat.angleHeadMount : mat.angleHead;
    const box = ahBox(col.lengthX, col.lengthY, col.lengthZ,
                      col.offsetX, col.offsetY, col.offsetZ, material);

    if (isMount) {
      // Mount=1 boxes belong to the output group (follow output rotation)
      // Offset is already in output-local coords, but we need to subtract
      // the output position since the box offset in INI is from spindle nose
      box.position.set(
        col.offsetX - pos0.x,
        col.offsetY - pos0.y,
        (col.offsetZ - pos0.z) - col.lengthZ / 2
      );
      angleHeadOutput.add(box);
    } else {
      angleHeadGroup.add(box);
    }
  }

  // Re-add angleHeadOutput to group
  angleHeadGroup.add(angleHeadOutput);

  // Enable side view layer on new geometry
  angleHeadGroup.traverse(o => { o.layers.enable(SIDE_VIEW_LAYER); });

  console.log(`AngleHead built: "${headDef.name}" (${headDef.description}) — ${headDef.collisionObjects.length} collision boxes, output at Y=${pos0.y} Z=${pos0.z}`);
}

// Build default angle head (WFK2e hardcoded fallback)
function buildDefaultAngleHead() {
  buildAngleHead({
    name: '150 20 86 04', description: 'WFK2e von unten (default)',
    positions: [{ id: 1, a: -90, c: 0, x: 0, y: -58, z: -167, flex: 0 }],
    collisionObjects: [
      { type: 2, angleA: 0, angleC: 0, offsetX: 0, offsetY: 0, offsetZ: 0, lengthX: 63, lengthY: 63, lengthZ: 28, mount: 0 },
      { type: 1, angleA: 0, angleC: 0, offsetX: 0, offsetY: -35, offsetZ: -28, lengthX: 88, lengthY: 158, lengthZ: 57, mount: 0 },
      { type: 1, angleA: 0, angleC: 0, offsetX: 0, offsetY: -86, offsetZ: -85, lengthX: 88, lengthY: 56, lengthZ: 107, mount: 0 },
      { type: 2, angleA: -90, angleC: 0, offsetX: 0, offsetY: -58, offsetZ: -167, lengthX: 48, lengthY: 48, lengthZ: 9, mount: 1 },
      { type: 2, angleA: -90, angleC: 0, offsetX: 0, offsetY: -49, offsetZ: -167, lengthX: 26, lengthY: 26, lengthZ: 22, mount: 1 },
      { type: 1, angleA: 0, angleC: 0, offsetX: -53, offsetY: -50, offsetZ: 0, lengthX: 18, lengthY: 50, lengthZ: 42, mount: 0 },
      { type: 1, angleA: 0, angleC: 0, offsetX: -53, offsetY: -42, offsetZ: -42, lengthX: 14, lengthY: 14, lengthZ: 22, mount: 0 },
    ]
  });
}
buildDefaultAngleHead();

// --- Spindle-mounted camera for machining closeup viewport ---
const spindleCam = new THREE.PerspectiveCamera(50, 1, 1, 5000);
// Initial position set by _updateSpindleCamPosition() (spherical orbit)
spindleCam.up.set(0, 0, 1);         // Z-up to match machine convention
spindleCam.layers.set(SPINDLE_CAM_LAYER);  // ONLY render layer 2
spindleOffset.add(spindleCam);       // moves with spindle head + A/C rotations

/** Enable layer 2 on all meshes in a subtree (for spindle cam visibility) */
function enableSpindleCamLayer(obj) {
  obj.traverse(o => { o.layers.enable(SPINDLE_CAM_LAYER); });
}

// Tool meshes need layer 2 — also re-applied in setTool() when tool changes
enableSpindleCamLayer(toolGroup);

// --- 2D End-view camera (orthographic, looking from +X along -X toward profile end) ---
// Shows profile cross-section (Y × Z) at the tool's X position.
const sideViewCam = new THREE.OrthographicCamera(-200, 200, 200, -200, 1, 20000);
sideViewCam.up.set(0, 0, 1);                   // Z-up
sideViewCam.layers.set(SIDE_VIEW_LAYER);        // ONLY render layer 3
// Position: far out along +X, looking back toward profile (along -X)
sideViewCam.position.set(10000, -200, 100);
sideViewCam.lookAt(0, -200, 100);

// End-view fixture opacity (overridden by localStorage / UI slider)
let _evFixtureOpacity = 0.25;  // 0–1: lower = more transparent

// Transparent fixture material for end view
const matFixtureSideView = new THREE.MeshStandardMaterial({
  color: 0xcccc00, roughness: 0.4, metalness: 0.5,
  envMapIntensity: 1.0,
  transparent: true, opacity: 0.25,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Update end-view fixture material from current opacity value */
function _updateEvMaterials() {
  if (_evFixtureOpacity >= 1.0) {
    matFixtureSideView.transparent = false;
    matFixtureSideView.opacity = 1.0;
    matFixtureSideView.depthWrite = true;
  } else {
    matFixtureSideView.transparent = true;
    matFixtureSideView.opacity = _evFixtureOpacity;
    matFixtureSideView.depthWrite = false;
  }
  matFixtureSideView.needsUpdate = true;
}

function enableSideViewLayer(obj) {
  obj.traverse(o => { o.layers.enable(SIDE_VIEW_LAYER); });
}

// Enable layer 3 on lights so side view is illuminated
hemiLight.layers.enable(SIDE_VIEW_LAYER);
[sunLight, fill, rim, bounce].forEach(l => { l.layers.enable(SIDE_VIEW_LAYER); });

// Enable side view on tool, spindle, gearbox, angle head (they keep their normal material)
enableSideViewLayer(toolGroup);
enableSideViewLayer(spindleGroup);
enableSideViewLayer(gearboxGroup);
enableSideViewLayer(angleHeadGroup);

scene.add(headX);

// ============================================================================
// CLAMPS (8 pcs) — geometry from NCM, switchable between U (Oben) and D (Unten)
// ============================================================================
const clampsGroup = new THREE.Group(); clampsGroup.name = 'clamps';
const clampMeshes = [];
const allFixStatic = [];
const allStatic = [];
const allFixMovable = [];
const allMovable = [];
const allBase = [];
const allS2 = [];
const allS4 = [];
const allS5 = [];

// NCM clamp geometry definitions — from SBZ151.ncm :CLAMPGEO sections
const CLAMP_GEOS = {
  'C_151_Mes_U': {
    ident: 'C_151_Mes_U',
    comment: 'Standardspanner OBEN mit Messeinrichtung',
    boxFixStatic:  [[70, 11.165, 80, -35, 0, -1]],
    boxStatic:     [[70, 30, 136, -35, -30, 0],          // (S2) Spannerrücken — 136 height
                    [165, 785, 55, -82.5, -750, -195],    // (base) Querträger
                    [165, 205, 140, -82.5, -185, -140],   // (S4) Inner body
                    [120, 60, 130, -60, 35, -280]],       // (S5) Bracket
    boxFixMovable: [[26, 150, 4.5, -68, -43, -4.5],
                    [26, 150, 4.5, 43, -43, -4.5]],
    boxMovable:    [[70, 25, 85, -35, -25, 0],
                    [145, 200, 82, -72.5, -25, -82],
                    [140, 235, 58, -70, -60, -140]]
  },
  'C_151_Mes_D': {
    ident: 'C_151_Mes_D',
    comment: 'Standardspanner UNTEN mit Messeinrichtung',
    boxFixStatic:  [[70, 11.165, 80, -35, 0, -1]],
    boxStatic:     [[70, 30, 85, -35, -30, 0],           // (S2) Spannerrücken — 85 height
                    [165, 785, 55, -82.5, -750, -195],    // (base) Querträger
                    [165, 205, 140, -82.5, -185, -140],   // (S4) Inner body
                    [120, 60, 130, -60, 35, -280]],       // (S5) Bracket
    boxFixMovable: [[26, 150, 4.5, -68, -43, -4.5],
                    [26, 150, 4.5, 43, -43, -4.5]],
    boxMovable:    [[70, 25, 85, -35, -25, 0],
                    [145, 200, 82, -72.5, -25, -82],
                    [140, 235, 58, -70, -60, -140]]
  }
};
let activeClampGeo = 'C_151_Mes_U';

function createClamp(geo) {
  const g = geo || CLAMP_GEOS[activeClampGeo];
  const clamp = new THREE.Group();

  // Full real geometry parsed from the active machine's .ncm :CLAMPGEO —
  // every BoxStatic (fixed frame) + BoxMovable (jaw). This is what makes the
  // 7m and Axium clamps genuinely different (taller support/jaw on the 7m).
  if (g.full) {
    const fixStaticGrp = new THREE.Group(); fixStaticGrp.name = 'fixStatic';
    clamp.add(fixStaticGrp);

    const staticGrp = new THREE.Group(); staticGrp.name = 'static';
    // First BoxStatic is the big cross-beam (base); render it in the base
    // material, the rest as the clamp body.
    const baseGrp = new THREE.Group(); baseGrp.name = 'base';
    g.boxStatic.forEach((b, idx) => {
      const m = idx === 0 ? mat.clampBase : mat.clampBack;
      (idx === 0 ? baseGrp : staticGrp).add(ncmBox(b[0], b[1], b[2], b[3], b[4], b[5], m));
    });
    clamp.add(staticGrp);
    clamp.add(baseGrp);

    const jaw = new THREE.Group(); jaw.name = 'jaw';
    const fixMovableGrp = new THREE.Group(); fixMovableGrp.name = 'fixMovable';
    jaw.add(fixMovableGrp);
    const movableGrp = new THREE.Group(); movableGrp.name = 'movable';
    for (const b of g.boxMovable) movableGrp.add(ncmBox(b[0], b[1], b[2], b[3], b[4], b[5], mat.clampJawBody));
    jaw.add(movableGrp);
    clamp.add(jaw);

    const fixtureGrp = new THREE.Group(); fixtureGrp.name = 'fixture';
    clamp.add(fixtureGrp);

    // s2/s4/s5 kept as empty groups so the visibility-toggle + tracking code
    // (allS2/allS4/allS5) stays valid for the full-geometry path.
    const s2 = new THREE.Group(), s4 = new THREE.Group(), s5 = new THREE.Group();
    return { clamp, jaw, fixtureGrp, fixStaticGrp, staticGrp, fixMovableGrp, movableGrp, baseGrp, s2, s4, s5 };
  }

  // (1) BoxFixStatic — green plastic pad
  const fixStaticGrp = new THREE.Group(); fixStaticGrp.name = 'fixStatic';
  for (const b of g.boxFixStatic) fixStaticGrp.add(ncmBox(b[0], b[1], b[2], b[3], b[4], b[5], mat.clampFix));
  clamp.add(fixStaticGrp);

  // BoxStatic entries — [0]=S2 Rücken, [1]=base Querträger, [2]=S4 Inner, [3]=S5 Bracket
  const staticGrp = new THREE.Group(); staticGrp.name = 'static';
  const bs = g.boxStatic;

  const s2 = new THREE.Group(); s2.name = 'S2_Rücken';
  s2.add(ncmBox(bs[0][0], bs[0][1], bs[0][2], bs[0][3], bs[0][4], bs[0][5], mat.clampBack));
  staticGrp.add(s2);

  const s4 = new THREE.Group(); s4.name = 'S4_Inner';
  s4.add(ncmBox(bs[2][0], bs[2][1], bs[2][2], bs[2][3], bs[2][4], bs[2][5], mat.clampInner));
  staticGrp.add(s4);

  const s5 = new THREE.Group(); s5.name = 'S5_Bracket';
  s5.add(ncmBox(bs[3][0], bs[3][1], bs[3][2], bs[3][3], bs[3][4], bs[3][5], mat.clampBracket));
  staticGrp.add(s5);

  clamp.add(staticGrp);

  // Base — Querträger (boxStatic[1])
  const baseGrp = new THREE.Group(); baseGrp.name = 'base';
  baseGrp.add(ncmBox(bs[1][0], bs[1][1], bs[1][2], bs[1][3], bs[1][4], bs[1][5], mat.clampBase));
  clamp.add(baseGrp);

  // Movable jaw assembly
  const jaw = new THREE.Group(); jaw.name = 'jaw';

  const fixMovableGrp = new THREE.Group(); fixMovableGrp.name = 'fixMovable';
  for (const b of g.boxFixMovable) fixMovableGrp.add(ncmBox(b[0], b[1], b[2], b[3], b[4], b[5], mat.clampFix));
  jaw.add(fixMovableGrp);

  const movableGrp = new THREE.Group(); movableGrp.name = 'movable';
  const matMap = [mat.clampJawTop, mat.clampJawBody, mat.clampJawBody];
  g.boxMovable.forEach((b, i) => movableGrp.add(ncmBox(b[0], b[1], b[2], b[3], b[4], b[5], matMap[i] || mat.clampJawBody)));
  jaw.add(movableGrp);

  clamp.add(jaw);

  // Fixture group — sits on top of the clamp's static pad
  const fixtureGrp = new THREE.Group();
  fixtureGrp.name = 'fixture';
  clamp.add(fixtureGrp);

  return { clamp, jaw, fixtureGrp, fixStaticGrp, staticGrp, fixMovableGrp, movableGrp, baseGrp, s2, s4, s5 };
}

// 8 clamps evenly spaced
const NUM_CLAMPS = 8;
const clampJaws = [];
const clampFixtureGroups = [];  // fixture geometry groups for each clamp
for (let i = 0; i < NUM_CLAMPS; i++) {
  const c = createClamp();
  const defaultX = 400 + i * 900;
  c.clamp.position.x = defaultX;
  clampsGroup.add(c.clamp);
  clampMeshes.push(c.clamp);
  clampJaws.push(c.jaw);
  clampFixtureGroups.push(c.fixtureGrp);
  allFixStatic.push(c.fixStaticGrp);
  allStatic.push(c.staticGrp);
  allFixMovable.push(c.fixMovableGrp);
  allMovable.push(c.movableGrp);
  allBase.push(c.baseGrp);
  allS2.push(c.s2);
  allS4.push(c.s4);
  allS5.push(c.s5);
}
scene.add(clampsGroup);

// Rebuild all 8 clamps with a different geometry type
function setClampType(geoIdent) {
  const geo = CLAMP_GEOS[geoIdent];
  if (!geo) return;
  activeClampGeo = geoIdent;
  for (let i = 0; i < NUM_CLAMPS; i++) {
    const oldClamp = clampMeshes[i];
    const savedX = oldClamp.position.x;
    const savedJawY = clampJaws[i].position.y;

    // Remove old clamp from group
    clampsGroup.remove(oldClamp);

    // Create new clamp with new geometry
    const c = createClamp(geo);
    c.clamp.position.x = savedX;
    c.jaw.position.y = savedJawY;
    clampsGroup.add(c.clamp);

    // Update all tracking arrays
    clampMeshes[i] = c.clamp;
    clampJaws[i] = c.jaw;
    clampFixtureGroups[i] = c.fixtureGrp;
    allFixStatic[i] = c.fixStaticGrp;
    allStatic[i] = c.staticGrp;
    allFixMovable[i] = c.fixMovableGrp;
    allMovable[i] = c.movableGrp;
    allBase[i] = c.baseGrp;
    allS2[i] = c.s2;
    allS4[i] = c.s4;
    allS5[i] = c.s5;
  }
  console.log(`[CLAMP] Switched to ${geoIdent}: ${geo.comment}`);
}

// ============================================================================
// STOP
// ============================================================================
const stopGroup = new THREE.Group(); stopGroup.name = 'stopGroup';
const stopUp = ncmBox(20, 280, 420, -20, -340, -212, mat.stop);
const stopDown = ncmBox(20, 280, 420, -20, -340, -632, mat.stop);
stopDown.visible = false;
stopGroup.add(stopUp); stopGroup.add(stopDown);
stopGroup.add(ncmBox(360, 345, 200, -382, -375, -412, mat.stopBase));
scene.add(stopGroup);

// ============================================================================
// PROFILE
// ============================================================================
const profileGroup = new THREE.Group(); profileGroup.name = 'profile';
let profileMesh, profileEdges;

function updateProfile(length, width, height) {
  // Remove old profile (may be a Mesh from BoxGeometry or a Group from createProfileMesh)
  if (profileMesh) {
    profileGroup.remove(profileMesh);
    profileMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  if (profileEdges) {
    profileGroup.remove(profileEdges);
    if (profileEdges.geometry) profileEdges.geometry.dispose();
  }
  const g = new THREE.BoxGeometry(length, width, height);
  profileMesh = new THREE.Mesh(g, mat.profile);
  profileMesh.position.set(length / 2, -width / 2, height / 2);
  profileMesh.castShadow = true; profileMesh.receiveShadow = true;
  profileGroup.add(profileMesh);
  const eg = new THREE.EdgesGeometry(g);
  profileEdges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4 }));
  profileEdges.position.copy(profileMesh.position);
  profileGroup.add(profileEdges);
  enableSpindleCamLayer(profileGroup);  // make visible in spindle cam
  enableSideViewLayer(profileGroup);    // make visible in side view
}
profileGroup.visible = false;
scene.add(profileGroup);

// --- STEP profile transform state ---
let _stepTransformGroup = null;  // THREE.Group wrapping alignWrapper (user transform)
// Rotation stored as a cumulative quaternion — each 90° click applies a new rotation
// on top of the previous one, rotating around the fixed machine axes (X/Y/Z).
// This avoids Euler gimbal issues and gives true "spin the object on any axis" behaviour.
const _stepRotationQ = new THREE.Quaternion();  // cumulative user rotation
let _stepMirror = { x: false, y: false, z: false };
let _stepOffset = { x: 0, y: 0, z: 0 };    // mm

// Scratch quaternion for incremental rotations
const _stepRotTmp = new THREE.Quaternion();

/** Apply current rotation/mirror/offset to _stepTransformGroup */
function _applyStepTransform() {
  if (!_stepTransformGroup) return;

  // Rotation: apply cumulative quaternion
  _stepTransformGroup.quaternion.copy(_stepRotationQ);

  // Mirror via scale (negative = mirror)
  _stepTransformGroup.scale.set(
    _stepMirror.x ? -1 : 1,
    _stepMirror.y ? -1 : 1,
    _stepMirror.z ? -1 : 1
  );

  // Position offset
  _stepTransformGroup.position.set(
    _stepOffset.x,
    _stepOffset.y,
    _stepOffset.z
  );
}

/** Update the STEP transform UI controls to reflect current state */
function _updateStepTransformUI() {
  // Derive Euler angles from quaternion for display only
  const _dispEuler = new THREE.Euler().setFromQuaternion(_stepRotationQ, 'XYZ');
  const toDeg = r => Math.round(r * 180 / Math.PI);
  const rotXEl = document.getElementById('stepRotX_val');
  const rotYEl = document.getElementById('stepRotY_val');
  const rotZEl = document.getElementById('stepRotZ_val');
  if (rotXEl) rotXEl.textContent = `${toDeg(_dispEuler.x)}°`;
  if (rotYEl) rotYEl.textContent = `${toDeg(_dispEuler.y)}°`;
  if (rotZEl) rotZEl.textContent = `${toDeg(_dispEuler.z)}°`;

  const mirXEl = document.getElementById('stepMirX');
  const mirYEl = document.getElementById('stepMirY');
  const mirZEl = document.getElementById('stepMirZ');
  if (mirXEl) mirXEl.checked = _stepMirror.x;
  if (mirYEl) mirYEl.checked = _stepMirror.y;
  if (mirZEl) mirZEl.checked = _stepMirror.z;

  const offXEl = document.getElementById('stepOffX');
  const offYEl = document.getElementById('stepOffY');
  const offZEl = document.getElementById('stepOffZ');
  if (offXEl) { offXEl.value = _stepOffset.x; }
  if (offYEl) { offYEl.value = _stepOffset.y; }
  if (offZEl) { offZEl.value = _stepOffset.z; }
  const offXVal = document.getElementById('stepOffX_val');
  const offYVal = document.getElementById('stepOffY_val');
  const offZVal = document.getElementById('stepOffZ_val');
  if (offXVal) offXVal.textContent = `${_stepOffset.x} mm`;
  if (offYVal) offYVal.textContent = `${_stepOffset.y} mm`;
  if (offZVal) offZVal.textContent = `${_stepOffset.z} mm`;
}

// ============================================================================
// EXTERNAL MESHES (received from parent iframe via postMessage)
// ============================================================================
const _externalMeshGroup = new THREE.Group();
_externalMeshGroup.name = 'externalMeshes';
scene.add(_externalMeshGroup);

// ============================================================================
// AXES + GRID
// ============================================================================
const axesGroup = new THREE.Group();
axesGroup.add(new THREE.AxesHelper(500));
function mkLabel(t, p, c) {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 32;
  const ctx = cv.getContext('2d'); ctx.fillStyle = c; ctx.font = 'bold 24px Arial'; ctx.fillText(t, 4, 24);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) }));
  s.position.copy(p); s.scale.set(100, 50, 1); return s;
}
axesGroup.add(mkLabel('X', new THREE.Vector3(550, 0, 0), '#ff4444'));
axesGroup.add(mkLabel('Y', new THREE.Vector3(0, 550, 0), '#44ff44'));
axesGroup.add(mkLabel('Z', new THREE.Vector3(0, 0, 550), '#4444ff'));
scene.add(axesGroup);

// Grid removed per user request

// ============================================================================
// PERSISTENT VIEW SETTINGS (localStorage)
// ============================================================================
const _STORAGE_KEY = 'sbz151_viewSettings';

function _saveViewSettings() {
  try {
    const settings = {
      spindleCam: _spindleCamEnabled,
      sideView: _sideViewEnabled,
      evZoom: _evZoom,
      evPanY: _evPanY,
      evPanZ: _evPanZ,
      evUserW: _evUserW,
      evUserH: _evUserH,
      evFixtureOpacity: _evFixtureOpacity,
      scPos: { x: spindleCam.position.x, y: spindleCam.position.y, z: spindleCam.position.z },
      scTarget: { x: _scTarget.x, y: _scTarget.y, z: _scTarget.z },
    };
    localStorage.setItem(_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) { /* TDZ during init or quota — ignore */ }
}

function _loadViewSettings() {
  try {
    const json = localStorage.getItem(_STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) { return null; }
}

// ============================================================================
// UI BINDINGS
// ============================================================================
let _spindleCamEnabled = true;  // declared here so bindToggle can reference it
let _sideViewEnabled = true;    // declared here so _saveViewSettings works during init
function bindSlider(id, cb) {
  const el = document.getElementById(id); if (!el) return;
  const v = document.getElementById(id + '_val');
  const h = () => { const n = parseFloat(el.value); cb(n);
    if (v) v.textContent = (id === 'axisA' || id === 'axisC') ? n.toFixed(1) + '\u00B0' : n + ' mm';
  };
  el.addEventListener('input', h); h();
}
function bindToggle(id, cb) {
  const el = document.getElementById(id); if (!el) return;
  el.addEventListener('change', () => cb(el.checked)); cb(el.checked);
}

// A-axis tilts spindle around X (PAngleX in elumatec = rotation around machine X-axis)
bindSlider('axisA', v => { aPivot.rotation.x = v * Math.PI / 180; });
// C-axis rotates entire assembly around Z
bindSlider('axisC', v => { cPivot.rotation.z = v * Math.PI / 180; });

// Head position
bindSlider('posX', v => { headX.position.x = v; });
bindSlider('posY', v => { headYZ.position.y = v; });
bindSlider('posZ', v => { headYZ.position.z = v; });

// Clamp type selector — both left-panel (#clampType) and sim-panel (#simClampType)
const clampTypeSelect = document.getElementById('clampType');
if (clampTypeSelect) {
  clampTypeSelect.addEventListener('change', e => {
    setClampType(e.target.value);
    const sim = document.getElementById('simClampType');
    if (sim) sim.value = e.target.value;
  });
}
const simClampTypeSelect = document.getElementById('simClampType');
if (simClampTypeSelect) {
  simClampTypeSelect.addEventListener('change', e => {
    setClampType(e.target.value);
    if (clampTypeSelect) clampTypeSelect.value = e.target.value;
  });
}

// Clamp X-positions (8 clamps)
for (let i = 0; i < NUM_CLAMPS; i++) {
  bindSlider('clamp' + (i + 1), v => { clampMeshes[i].position.x = v; });
}

// Jaw opening
bindSlider('jawOpen', v => { clampJaws.forEach(j => { j.position.y = -v; }); });

// Stop
bindToggle('stopUp', v => { stopUp.visible = v; stopDown.visible = !v; });

const pc = { l: 3000, w: 65, h: 67 };

// --- Visibility: Machine ---
bindToggle('showBed', v => { bedGroup.visible = v; });
bindToggle('showPortal', v => { portalBeam.visible = v; });
bindToggle('showSpindle', v => { spindleGroup.visible = v; });
bindToggle('showGearbox', v => { gearboxGroup.visible = v; });
bindToggle('showTool', v => { toolGroup.visible = v; });
bindToggle('showAngleHead', v => { angleHeadGroup.visible = v; });
bindToggle('showCollision', v => { collisionGroup.visible = v; });

// --- Visibility: Clamps ---
bindToggle('showClamps', v => { clampsGroup.visible = v; });
bindToggle('showClampStatic', v => { allStatic.forEach(g => g.visible = v); });
bindToggle('showClampMovable', v => { allMovable.forEach(g => g.visible = v); });
bindToggle('showClampFixStatic', v => { allFixStatic.forEach(g => g.visible = v); });
bindToggle('showClampFixMovable', v => { allFixMovable.forEach(g => g.visible = v); });
bindToggle('showClampBase', v => { allBase.forEach(g => g.visible = v); });

// --- Visibility: Clamp individual static boxes (for debugging) ---
bindToggle('showS2', v => { allS2.forEach(g => g.visible = v); });
bindToggle('showS4', v => { allS4.forEach(g => g.visible = v); });
bindToggle('showS5', v => { allS5.forEach(g => g.visible = v); });

// --- Visibility: Other ---
bindToggle('showFixtures', v => { clampFixtureGroups.forEach(g => g.visible = v); });
bindToggle('showStop', v => { stopGroup.visible = v; });
bindToggle('showAxes', v => { axesGroup.visible = v; });
bindToggle('showWireframe', wf => {
  Object.entries(mat).forEach(([k, m]) => { if (k !== 'collWire') m.wireframe = wf; });
});
bindToggle('showSpindleCam', v => {
  _spindleCamEnabled = v;
  const simCB = document.getElementById('simShowSpindleCam');
  if (simCB && simCB.checked !== v) simCB.checked = v;
  _saveViewSettings();
});

// Sim panel toggles → sync with left-panel checkbox
bindToggle('simShowSpindleCam', v => {
  _spindleCamEnabled = v;
  const leftCB = document.getElementById('showSpindleCam');
  if (leftCB && leftCB.checked !== v) leftCB.checked = v;
  _saveViewSettings();
});

bindToggle('simShowSideView', v => { _sideViewEnabled = v; _saveViewSettings(); });

// --- End-view fixture opacity slider ---
{
  const fixSlider = document.getElementById('evFixtureOpacity');
  const fixVal    = document.getElementById('evFixtureOpacity_val');
  if (fixSlider) {
    fixSlider.addEventListener('input', () => {
      _evFixtureOpacity = parseInt(fixSlider.value, 10) / 100;
      if (fixVal) fixVal.textContent = fixSlider.value + '%';
    });
    fixSlider.addEventListener('change', () => { _saveViewSettings(); });
  }
}

// --- End-view interaction state (zoom + pan + resize) ---
let _evZoom = 1.0;           // zoom factor (1 = auto-framed, <1 = zoomed in, >1 = zoomed out)
let _evPanY = 0;             // manual pan offset in Y (depth) — world units
let _evPanZ = 0;             // manual pan offset in Z (height) — world units
let _evDragging = false;
let _evPrevX = 0;
let _evPrevY = 0;
let _evBounds = { x: 0, y: 0, w: 0, h: 0 };  // screen coords (CSS, Y-down)
let _evHalfW = 200;          // current half-frustum width (for pan scaling)
let _evHalfH = 200;          // current half-frustum height

// Resizable viewport: user can drag edges/corners to resize
let _evUserW = 0;            // 0 = use default size
let _evUserH = 0;
let _evResizing = null;      // null | 'right' | 'bottom' | 'corner'
let _evResizePrevX = 0;
let _evResizePrevY = 0;
const EV_RESIZE_MARGIN = 10; // pixels from edge to trigger resize cursor

function _isInsideEndView(clientX, clientY) {
  return _sideViewEnabled &&
    clientX >= _evBounds.x && clientX <= _evBounds.x + _evBounds.w &&
    clientY >= _evBounds.y && clientY <= _evBounds.y + _evBounds.h;
}

/** Check if near the resizable edges (right edge, top edge, top-right corner).
 *  Returns 'right', 'top', 'corner', or null.
 *  Top edge in screen coords = _evBounds.y (since viewport is bottom-aligned in GL). */
function _evResizeHitTest(clientX, clientY) {
  if (!_sideViewEnabled) return null;
  const b = _evBounds;
  const nearRight = Math.abs(clientX - (b.x + b.w)) < EV_RESIZE_MARGIN && clientY >= b.y && clientY <= b.y + b.h;
  const nearTop   = Math.abs(clientY - b.y) < EV_RESIZE_MARGIN && clientX >= b.x && clientX <= b.x + b.w;
  if (nearRight && nearTop) return 'corner';
  if (nearRight) return 'right';
  if (nearTop) return 'top';
  return null;
}

// Right-drag in end view = pan
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (!_isInsideEndView(ev.clientX, ev.clientY) && !_evResizeHitTest(ev.clientX, ev.clientY)) return;

  // Check resize first (works with any button)
  const resizeEdge = _evResizeHitTest(ev.clientX, ev.clientY);
  if (resizeEdge && ev.button === 0) {
    _evResizing = resizeEdge;
    _evResizePrevX = ev.clientX;
    _evResizePrevY = ev.clientY;
    ev.stopPropagation();
    ev.preventDefault();
    return;
  }

  // Right-click (button 2) inside end view = pan
  if (ev.button === 2 && _isInsideEndView(ev.clientX, ev.clientY)) {
    _evDragging = true;
    _evPrevX = ev.clientX;
    _evPrevY = ev.clientY;
    ev.stopPropagation();
    ev.preventDefault();
    return;
  }

  // Left-click inside end view = block main viewport orbit
  if (ev.button === 0 && _isInsideEndView(ev.clientX, ev.clientY)) {
    ev.stopPropagation();
  }
}, true);  // capture phase

// Block context menu inside end view
renderer.domElement.addEventListener('contextmenu', (ev) => {
  if (_isInsideEndView(ev.clientX, ev.clientY)) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}, true);

window.addEventListener('pointermove', (ev) => {
  // Resize handling
  if (_evResizing) {
    const dx = ev.clientX - _evResizePrevX;
    const dy = ev.clientY - _evResizePrevY;
    _evResizePrevX = ev.clientX;
    _evResizePrevY = ev.clientY;

    if (_evResizing === 'right' || _evResizing === 'corner') {
      _evUserW = Math.max(150, (_evUserW || _evBounds.w) + dx);
    }
    if (_evResizing === 'top' || _evResizing === 'corner') {
      _evUserH = Math.max(150, (_evUserH || _evBounds.h) - dy);  // drag up = bigger
    }
    return;
  }

  // Pan handling
  if (!_evDragging) return;
  const dx = ev.clientX - _evPrevX;
  const dy = ev.clientY - _evPrevY;
  _evPrevX = ev.clientX;
  _evPrevY = ev.clientY;
  if (dx === 0 && dy === 0) return;

  // Convert pixel drag to world units using current frustum size / viewport size
  const pixToWorldY = (_evHalfW * 2) / (_evBounds.w || 1);
  const pixToWorldZ = (_evHalfH * 2) / (_evBounds.h || 1);
  _evPanY -= dx * pixToWorldY;   // drag right → view moves right (grab & drag)
  _evPanZ -= dy * pixToWorldZ;   // drag down → view moves down
});

window.addEventListener('pointerup', () => {
  if (_evDragging || _evResizing) {
    _evDragging = false;
    _evResizing = null;
    _saveViewSettings();
  }
});

// Update cursor when near resize edges
renderer.domElement.addEventListener('mousemove', (ev) => {
  if (_evResizing || _evDragging) return;
  const edge = _evResizeHitTest(ev.clientX, ev.clientY);
  if (edge === 'corner') renderer.domElement.style.cursor = 'nwse-resize';
  else if (edge === 'right') renderer.domElement.style.cursor = 'ew-resize';
  else if (edge === 'top') renderer.domElement.style.cursor = 'ns-resize';
  else if (_isInsideEndView(ev.clientX, ev.clientY)) renderer.domElement.style.cursor = 'default';
  // Don't reset cursor here — let other handlers manage it
});

// Scroll in end view = zoom
let _evSaveTimer = 0;
renderer.domElement.addEventListener('wheel', (ev) => {
  if (!_isInsideEndView(ev.clientX, ev.clientY)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const factor = ev.deltaY > 0 ? 1.12 : 0.89;
  _evZoom = Math.max(0.05, Math.min(10, _evZoom * factor));
  clearTimeout(_evSaveTimer);
  _evSaveTimer = setTimeout(_saveViewSettings, 300);
}, { passive: false, capture: true });

// Double-click = reset zoom/pan to auto
renderer.domElement.addEventListener('dblclick', (ev) => {
  if (!_isInsideEndView(ev.clientX, ev.clientY)) return;
  _evZoom = 1.0;
  _evPanY = 0;
  _evPanZ = 0;
  ev.stopPropagation();
  _saveViewSettings();
}, true);

// ============================================================================
// SPINDLE CAM INTERACTION (CAD-style orbit + zoom, same as main viewport)
// ============================================================================
// Orbit: left-drag on a surface in the PIP → rotate spindleCam around the
//   surface hit point (pivot). Uses quaternion rotation around world-Z (horizontal)
//   and camera-right (vertical), identical to the main viewport behaviour.
// Zoom: scroll in PIP → dolly toward the surface point under the cursor.
//   Step size proportional to distance. If no hit, zoom toward lookAt target.
// All positions are in spindleOffset-local space (spindleCam is a child of spindleOffset).

// spindleCam target (lookAt point, in spindleOffset-local coords)
const _scTarget = new THREE.Vector3(0, 0, -80);

// Initial camera position (side view, looking at tool tip area)
spindleCam.position.set(80, -150, 60);
spindleCam.up.set(0, 0, 1);

/**
 * Update spindleCam orientation to look at _scTarget in LOCAL space.
 * Since spindleCam is a child of spindleOffset, we must NOT use lookAt()
 * with world coords every frame — that fights with the parent transform.
 * Instead we compute the local rotation matrix directly.
 */
function _updateScCamOrientation() {
  const _m = new THREE.Matrix4();
  const _pos = spindleCam.position;
  const _up = new THREE.Vector3(0, 0, 1);  // local Z-up
  // lookAt matrix in local space: eye=_pos, target=_scTarget, up=localZ
  _m.lookAt(_pos, _scTarget, _up);
  spindleCam.quaternion.setFromRotationMatrix(_m);
}
_updateScCamOrientation();  // set initial orientation

// --- Restore saved view settings from localStorage ---
{
  const saved = _loadViewSettings();
  if (saved) {
    // Toggle states
    if (saved.spindleCam !== undefined) {
      _spindleCamEnabled = saved.spindleCam;
      const cb1 = document.getElementById('showSpindleCam');
      const cb2 = document.getElementById('simShowSpindleCam');
      if (cb1) cb1.checked = _spindleCamEnabled;
      if (cb2) cb2.checked = _spindleCamEnabled;
    }
    if (saved.sideView !== undefined) {
      _sideViewEnabled = saved.sideView;
      const cb = document.getElementById('simShowSideView');
      if (cb) cb.checked = _sideViewEnabled;
    }
    // End-view zoom/pan/size
    if (saved.evZoom !== undefined) _evZoom = saved.evZoom;
    if (saved.evPanY !== undefined) _evPanY = saved.evPanY;
    if (saved.evPanZ !== undefined) _evPanZ = saved.evPanZ;
    if (saved.evUserW !== undefined) _evUserW = saved.evUserW;
    if (saved.evUserH !== undefined) _evUserH = saved.evUserH;
    // End-view fixture opacity
    if (saved.evFixtureOpacity !== undefined) {
      _evFixtureOpacity = saved.evFixtureOpacity;
      const fs = document.getElementById('evFixtureOpacity');
      const fv = document.getElementById('evFixtureOpacity_val');
      if (fs) fs.value = Math.round(_evFixtureOpacity * 100);
      if (fv) fv.textContent = Math.round(_evFixtureOpacity * 100) + '%';
    }
    // Spindle cam position + target
    if (saved.scPos) {
      spindleCam.position.set(saved.scPos.x, saved.scPos.y, saved.scPos.z);
    }
    if (saved.scTarget) {
      _scTarget.set(saved.scTarget.x, saved.scTarget.y, saved.scTarget.z);
    }
    _updateScCamOrientation();
    // Re-save to clean out any stale keys (e.g. old evProfileOpacity)
    _saveViewSettings();
    console.log('View settings restored from localStorage');
  }
}

// Raycaster for PIP — uses layer 2 (tool, profile, fixtures)
const _scRaycaster = new THREE.Raycaster();
_scRaycaster.layers.set(SPINDLE_CAM_LAYER);

// Current inset bounds (in CSS/screen coords, updated each frame)
let _scBounds = { x: 0, y: 0, w: 0, h: 0 };

function _isInsideInset(clientX, clientY) {
  return _spindleCamEnabled &&
    clientX >= _scBounds.x && clientX <= _scBounds.x + _scBounds.w &&
    clientY >= _scBounds.y && clientY <= _scBounds.y + _scBounds.h;
}

/** Convert screen coords to NDC for the PIP viewport (-1..+1) */
function _scScreenToNDC(clientX, clientY) {
  // _scBounds is in CSS screen coords (Y-down from top-left)
  const localX = clientX - _scBounds.x;
  const localY = clientY - _scBounds.y;
  return new THREE.Vector2(
    (localX / _scBounds.w) * 2 - 1,
    -(localY / _scBounds.h) * 2 + 1
  );
}

/** Raycast from a screen position into the PIP scene. Returns hit or null.
 *  Hit point is in WORLD space (scene root). */
function _scHitTest(clientX, clientY) {
  const ndc = _scScreenToNDC(clientX, clientY);
  _scRaycaster.setFromCamera(ndc, spindleCam);
  const hits = _scRaycaster.intersectObjects(scene.children, true);
  return hits.length > 0 ? hits[0] : null;
}

// -- CAD-style orbit around surface pivot --
let _scOrbitActive = false;
let _scOrbitPivot = null;       // THREE.Vector3 — local-space pivot point
let _scOrbitPrevX = 0;
let _scOrbitPrevY = 0;

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (!_isInsideInset(ev.clientX, ev.clientY)) return;

  const hit = _scHitTest(ev.clientX, ev.clientY);
  if (hit) {
    // Convert hit point from world space to spindleOffset-local space
    _scOrbitPivot = spindleOffset.worldToLocal(hit.point.clone());
  } else {
    // No surface hit — orbit around current target
    _scOrbitPivot = _scTarget.clone();
  }

  _scOrbitActive = true;
  _scOrbitPrevX = ev.clientX;
  _scOrbitPrevY = ev.clientY;
  ev.stopPropagation();  // prevent main orbit from activating
}, true);  // capture phase

window.addEventListener('pointermove', (ev) => {
  if (!_scOrbitActive) return;

  const dx = ev.clientX - _scOrbitPrevX;
  const dy = ev.clientY - _scOrbitPrevY;
  _scOrbitPrevX = ev.clientX;
  _scOrbitPrevY = ev.clientY;
  if (dx === 0 && dy === 0) return;

  // Rotation speeds (radians per pixel) — same as main viewport
  const rotSpeed = 0.005;
  const angleH = -dx * rotSpeed;   // horizontal → rotate around local Z (up)
  const angleV = -dy * rotSpeed;   // vertical → rotate around camera right

  const pivot = _scOrbitPivot;

  // --- Rotate camera position around pivot ---
  const offset = spindleCam.position.clone().sub(pivot);

  // Horizontal rotation: around local Z axis (up in machine coords)
  const qH = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleH);
  offset.applyQuaternion(qH);

  // Vertical rotation: around camera's right axis in local space
  // Camera's local-frame right vector: transform (1,0,0) by camera's local quaternion
  const camDir = _scTarget.clone().sub(spindleCam.position).normalize();
  const localUp = new THREE.Vector3(0, 0, 1);
  const rightLocal = new THREE.Vector3().crossVectors(camDir, localUp).normalize();

  const qV = new THREE.Quaternion().setFromAxisAngle(rightLocal, angleV);
  offset.applyQuaternion(qV);

  // Apply new camera position
  spindleCam.position.copy(pivot).add(offset);

  // --- Also rotate the lookAt target around pivot by the same rotation ---
  const tOffset = _scTarget.clone().sub(pivot);
  tOffset.applyQuaternion(qH);
  tOffset.applyQuaternion(qV);
  _scTarget.copy(pivot).add(tOffset);

  // Update camera orientation (local space — no lookAt with world coords)
  _updateScCamOrientation();
});

window.addEventListener('pointerup', () => {
  if (_scOrbitActive) {
    _scOrbitActive = false;
    _scOrbitPivot = null;
    _saveViewSettings();
  }
});

// -- Zoom: dolly toward point under cursor (same as main viewport) --
let _scZoomDelta = 0;
let _scZoomDir = new THREE.Vector3();

renderer.domElement.addEventListener('wheel', (ev) => {
  if (!_isInsideInset(ev.clientX, ev.clientY)) return;
  ev.preventDefault();
  ev.stopPropagation();

  const hit = _scHitTest(ev.clientX, ev.clientY);

  if (hit) {
    // Zoom toward the hit point under the cursor (in local space)
    const localHit = spindleOffset.worldToLocal(hit.point.clone());
    _scZoomDir.subVectors(localHit, spindleCam.position).normalize();
    const dist = spindleCam.position.distanceTo(localHit);
    const step = dist * 0.12;
    _scZoomDelta += ev.deltaY < 0 ? step : -step;
  } else {
    // No surface hit — zoom toward current target
    _scZoomDir.subVectors(_scTarget, spindleCam.position).normalize();
    const dist = spindleCam.position.distanceTo(_scTarget);
    const step = dist * 0.12;
    _scZoomDelta += ev.deltaY < 0 ? step : -step;
  }
  clearTimeout(_evSaveTimer);
  _evSaveTimer = setTimeout(_saveViewSettings, 300);
}, { passive: false, capture: true });

// ============================================================================
// RENDER LOOP
// ============================================================================

// --- Spindle cam overlay (must be declared before animate) ---
const _overlayCanvas = document.createElement('canvas');
_overlayCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2;';
document.body.appendChild(_overlayCanvas);
const _overlayCtx = _overlayCanvas.getContext('2d');

function _resizeOverlay() {
  _overlayCanvas.width = window.innerWidth;
  _overlayCanvas.height = window.innerHeight;
}
_resizeOverlay();

function _drawInsetBorder(glX, glY, w, h, label) {
  // Convert from WebGL coords (Y-up from bottom) to canvas coords (Y-down from top)
  const cx = glX;
  const cy = window.innerHeight - glY - h;

  _overlayCtx.strokeStyle = '#ff6b35';
  _overlayCtx.lineWidth = 2;
  _overlayCtx.strokeRect(cx, cy, w, h);

  // Label
  _overlayCtx.font = '10px Segoe UI, sans-serif';
  const labelW = _overlayCtx.measureText(label).width + 14;
  _overlayCtx.fillStyle = 'rgba(10,10,30,0.8)';
  _overlayCtx.fillRect(cx, cy, labelW, 18);
  _overlayCtx.fillStyle = '#ff6b35';
  _overlayCtx.fillText(label, cx + 6, cy + 13);
}

let _simUI = null; // set after SimulationUI is created
let jogAnimation = null; // hoisted here so tickJog() works from first frame
let _currentGaugeLength = 0; // hoisted: used in animate() end-view before machineInterface section
let _currentHasAngleHead = false; // true when active tool uses angle head (WFK)
function animate(timestamp) {
  requestAnimationFrame(animate);
  const ts = timestamp || performance.now();
  if (_simUI) _simUI.tick(ts);
  tickJog(ts);

  // Smooth zoom — dolly camera + target towards point under mouse cursor
  if (Math.abs(_zoomDelta) > 0.1) {
    const move = _zoomDelta * 0.3;   // consume a portion per frame
    _zoomDelta -= move;

    // Don't zoom in closer than 30mm between camera and target
    const camTargetDist = camera.position.distanceTo(controls.target);
    if (move > 0 && camTargetDist < 30) {
      _zoomDelta = 0;
    } else {
      // Move both camera and target by the same amount along zoom direction
      // This keeps the camera-to-target relationship stable (orbit still works)
      // while moving towards/away from the point under the cursor
      camera.position.addScaledVector(_zoomDir, move);
      controls.target.addScaledVector(_zoomDir, move);
    }
  } else {
    _zoomDelta = 0;
  }

  controls.update();

  // --- Main viewport (full screen) ---
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissorTest(true);
  renderer.render(scene, camera);

  // Clear overlay before drawing PIP borders
  _overlayCtx.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);

  // --- Spindle cam smooth zoom (same approach as main viewport) ---
  if (Math.abs(_scZoomDelta) > 0.1) {
    const move = _scZoomDelta * 0.3;
    _scZoomDelta -= move;

    const camTargetDist = spindleCam.position.distanceTo(_scTarget);
    if (move > 0 && camTargetDist < 10) {
      _scZoomDelta = 0;
    } else {
      spindleCam.position.addScaledVector(_scZoomDir, move);
      _scTarget.addScaledVector(_scZoomDir, move);
      _updateScCamOrientation();  // local-space lookAt
    }
  } else {
    _scZoomDelta = 0;
  }

  const margin = 10;
  const tlBarHeight = document.getElementById('timelineBar')?.classList.contains('visible') ? 70 : 0;
  let _nextInsetY = margin + tlBarHeight + 30;  // stacking Y for PIP viewports

  // --- Spindle camera inset viewport (bottom-left, above info bar) ---
  if (_spindleCamEnabled) {
    const insetW = Math.round(Math.min(640, window.innerWidth * 0.44));
    const insetH = Math.round(insetW * 0.75);  // 4:3 aspect
    const insetX = 340;  // right of the left UI panel (320px + 20px gap)
    const insetY = _nextInsetY;

    spindleCam.aspect = insetW / insetH;
    spindleCam.updateProjectionMatrix();

    // No lookAt() here — camera orientation is set in local space by
    // _updateScCamOrientation() during orbit/zoom. The parent transform
    // (spindleOffset → aPivot → cPivot → headYZ → headX) automatically
    // makes the camera follow the spindle head in world space.

    renderer.setViewport(insetX, insetY, insetW, insetH);
    renderer.setScissor(insetX, insetY, insetW, insetH);
    renderer.render(scene, spindleCam);

    _drawInsetBorder(insetX, insetY, insetW, insetH, 'SPINDLE CAM');

    // Update inset bounds (CSS/screen coords) for mouse interaction
    _scBounds.x = insetX;
    _scBounds.y = window.innerHeight - insetY - insetH;  // GL→screen Y
    _scBounds.w = insetW;
    _scBounds.h = insetH;

    _nextInsetY += insetH + 8;  // stack next viewport above
  }

  // --- 2D End-view viewport (profile cross-section from the end) ---
  if (_sideViewEnabled) {
    const svDefaultW = Math.round(Math.min(400, window.innerWidth * 0.28));
    const svDefaultH = svDefaultW;
    const svW = _evUserW > 0 ? Math.round(_evUserW) : svDefaultW;
    const svH = _evUserH > 0 ? Math.round(_evUserH) : svDefaultH;
    const svX = 340;
    const svY = _nextInsetY;

    // Auto-frame: centred on tool tip world position
    const profW   = pc.w || 65;
    const profHt  = pc.h || 67;
    const profPosY = profileGroup.position.y;
    const profPosZ = profileGroup.position.z;
    const padFactor = 1.3;

    // Get tool tip world position from scene graph
    // Normal: tool tip at (0, 0, -gaugeLength) in spindleOffset local space
    // Angle head: tool tip at (0, ahY+G, ahZ) — output at Y=ahY, tool extends in +Y
    const _tipLocal = _currentHasAngleHead
      ? new THREE.Vector3(0, _ahOutputY + _currentGaugeLength, _ahOutputZ)
      : new THREE.Vector3(0, 0, -_currentGaugeLength);
    const _tipWorld = spindleOffset.localToWorld(_tipLocal);
    const toolTipX = _tipWorld.x;
    const toolTipY = _tipWorld.y;
    const toolTipZ = _tipWorld.z;

    // View extent: enough to show profile + tool tip with padding
    const viewMinY = Math.min(profPosY - profW - 20, toolTipY - 80);
    const viewMaxY = Math.max(profPosY + 20, toolTipY + 80);
    const viewMinZ = Math.min(profPosZ - 50, toolTipZ - 80);
    const viewMaxZ = Math.max(profPosZ + profHt + 50, toolTipZ + 300);

    const viewW = (viewMaxY - viewMinY) * padFactor;
    const viewH = (viewMaxZ - viewMinZ) * padFactor;

    // Centre on the tool tip
    const cy = toolTipY;
    const cz = toolTipZ;

    // Fit view to viewport aspect ratio
    const viewAspect = svW / svH;
    let halfW, halfH;
    if (viewW / viewH > viewAspect) {
      halfW = viewW / 2;
      halfH = halfW / viewAspect;
    } else {
      halfH = viewH / 2;
      halfW = halfH * viewAspect;
    }

    // Apply manual zoom + pan offsets
    const zHalfW = halfW * _evZoom;
    const zHalfH = halfH * _evZoom;
    const panCy = cy + _evPanY;
    const panCz = cz - _evPanZ;

    // Store for pan scaling in event handler
    _evHalfW = zHalfW;
    _evHalfH = zHalfH;

    // Camera looks from +X back along -X, at the tool tip's X position
    const toolX = toolTipX;
    sideViewCam.left   = -zHalfW;
    sideViewCam.right  =  zHalfW;
    sideViewCam.top    =  zHalfH;
    sideViewCam.bottom = -zHalfH;
    sideViewCam.position.set(toolX + 5000, panCy, panCz);
    sideViewCam.lookAt(toolX, panCy, panCz);
    // Wide near/far — profile extrusion spans full length, must not be clipped
    sideViewCam.near = 1;
    sideViewCam.far = 20000;
    sideViewCam.updateProjectionMatrix();

    // Find the closest clamp to the tool tip X — only show that fixture
    let _closestClampIdx = 0;
    let _closestDist = Infinity;
    for (let ci = 0; ci < clampMeshes.length; ci++) {
      const d = Math.abs(clampMeshes[ci].position.x - toolTipX);
      if (d < _closestDist) { _closestDist = d; _closestClampIdx = ci; }
    }

    // Prepare end view rendering
    _updateEvMaterials();
    const _savedFixMats = [];
    const _hiddenFixtures = [];
    const _hiddenEdgeLines = [];

    // Hide profile edge lines in end view (solid look)
    profileGroup.traverse(o => {
      if (o.isLineSegments || o.isLine) {
        _hiddenEdgeLines.push({ obj: o, visible: o.visible });
        o.visible = false;
      }
    });

    // Fixtures: only show the closest clamp's fixture, hide the rest
    clampFixtureGroups.forEach((fg, fi) => {
      if (fi !== _closestClampIdx) {
        _hiddenFixtures.push({ grp: fg, visible: fg.visible });
        fg.visible = false;
      } else {
        fg.traverse(o => {
          if (o.isMesh) {
            _savedFixMats.push({ mesh: o, material: o.material });
            o.material = matFixtureSideView;
          }
        });
      }
    });

    renderer.setViewport(svX, svY, svW, svH);
    renderer.setScissor(svX, svY, svW, svH);
    renderer.render(scene, sideViewCam);

    // Restore edge lines, fixture materials, hidden fixtures
    _hiddenEdgeLines.forEach(s => { s.obj.visible = s.visible; });
    _savedFixMats.forEach(s => { s.mesh.material = s.material; });
    _hiddenFixtures.forEach(s => { s.grp.visible = s.visible; });

    _drawInsetBorder(svX, svY, svW, svH, '\u00C4NDVY PROFIL');

    // Update end-view bounds for mouse interaction
    _evBounds.x = svX;
    _evBounds.y = window.innerHeight - svY - svH;  // GL→screen Y
    _evBounds.w = svW;
    _evBounds.h = svH;
  }

  renderer.setScissorTest(false);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  _resizeOverlay();
});

// ============================================================================
// SIMULATION INTEGRATION
// ============================================================================
/**
 * Programmatically update a slider's value and display label.
 */
function updateSliderDisplay(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  const v = document.getElementById(id + '_val');
  if (v) {
    v.textContent = (id === 'axisA' || id === 'axisC')
      ? parseFloat(value).toFixed(1) + '\u00B0'
      : Math.round(value) + ' mm';
  }
}

/**
 * Enable or disable all manual control sliders.
 */
function setManualControlsEnabled(enabled) {
  const ids = [
    'axisA', 'axisC', 'posX', 'posY', 'posZ',
    'clamp1', 'clamp2', 'clamp3', 'clamp4', 'clamp5', 'clamp6', 'clamp7', 'clamp8',
    'jawOpen'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

/**
 * Machine interface object — bridges simulation engine to 3D scene.
 */
let _currentToolId = null; // Track active tool to avoid redundant rebuilds
let _lastToolInfo = null;  // Last toolInfo passed to setTool(), for live reload
// _currentGaugeLength declared before animate() (hoisted)
let _nctDatabase = null;   // Loaded NCT tool database
let _efdDatabase = null;   // Loaded EFD fixture database
let _epoDatabase = null;   // Loaded EPO profile offset database
let _epdDatabase = null;   // Loaded EPD profile cross-section database
let _angleHeadDatabase = null; // Map<string, AngleHeadDef> — from NCT :ANGLEHEAD or AngleHead.ini

// Profile offsets from EPO (position of profile cross-section relative to clamp zero)
// PY = offset in -Y (into machine) from clamp zero to profile EPD origin X=0
// PZ = offset in +Z (upward) from clamp zero to profile EPD origin Y=0
let _profileOffsetY = -51.6; // EPO Offsets.y (PY) — profile depth offset from clamp zero. Default -51.6mm (standard elumatec)
let _profileOffsetZ = 0;     // EPO Offsets.z (PZ) — profile height offset from clamp zero
let _hasEpoProfileOffsets = true; // Start as true so default offset is applied immediately

// Apply the default offset to both groups immediately.
// profileGroup: Y-position = -PY (PY is stored as positive distance, applied as -Y in scene)
// _externalMeshGroup: same — external meshes from parent should match the profile position
profileGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
_externalMeshGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);

const machineInterface = {
  /**
   * Position the head so the tool tip (TCP) is at (x, y, z) with rotary at (a, c).
   *
   * INVERSE KINEMATICS — from TCP to machine axis positions:
   * The simulation engine computes TCP (tool tip) positions. The 3D model
   * needs headX/headYZ positions that place the tool tip there, accounting
   * for the pivot geometry AND tool length.
   *
   * Forward kinematic chain (headYZ → tool tip):
   *   headYZ → cPivot(+Dc, 0, +Da) → Rz(-C) → aPivot → Rx(A)
   *          → spindleOffset(-Dc, 0, -Da) → tool tip at (Tx, Ty, Tz)
   *
   * Tool offset in spindle-local coords:
   *   Normal:     (Tx, Ty, Tz) = (-Dc, 0, -(Da+G))
   *   Angle head: (Tx, Ty, Tz) = (-Dc, ahY+G, ahZ-Da)
   *     where ahY/ahZ = angle head output position from AngleHead.ini
   *
   * Inverse: headPos = TCP - (Dc, 0, Da) - Rc(-c) · Ra(a) · (Tx, Ty, Tz)
   *
   * where Da=SpindleDisplacementA=201.1, Dc=SpindleDisplacementC=75, G=gaugeLength
   */
  setHeadPosition(x, y, z, aDeg, cDeg) {
    const G = _currentGaugeLength;
    const Da = 201.1; // SpindleDisplacementA
    const Dc = 75;    // SpindleDisplacementC

    // Tool offset in spindle-local coords depends on angle head
    // Angle head output at (0, ahY, ahZ) from spindle nose.
    // With scale.z=-1 mirror + Rx(-90°), tool tip at (0, ahY+G, ahZ) in spindleOffset.
    // Combined with pivot-to-spindle (-Dc, 0, -Da), full offset from pivot:
    const Ty = _currentHasAngleHead ? (_ahOutputY + G)          : 0;
    const Tz = _currentHasAngleHead ? -(Da + Math.abs(_ahOutputZ)) : -(Da + G);

    if (aDeg !== undefined) {
      // Full inverse kinematics: TCP → machine axis positions
      const a = aDeg * Math.PI / 180;
      const c = cDeg * Math.PI / 180;
      const sinA = Math.sin(a), cosA = Math.cos(a);
      const sinC = Math.sin(c), cosC = Math.cos(c);

      // Ra(a) applied to (-Dc, Ty, Tz): ry = Ty·cosA - Tz·sinA, rz = Ty·sinA + Tz·cosA
      const ry = Ty * cosA - Tz * sinA;
      const rz = Ty * sinA + Tz * cosA;

      // Rc(-c) then subtract from TCP - pivotOffset
      headX.position.x  = x - Dc + Dc * cosC + ry * sinC;
      headYZ.position.y  = y + Dc * sinC - ry * cosC;
      headYZ.position.z  = z - Da - rz;
      console.log(`[IK] TCP=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) A=${aDeg} C=${cDeg} AH=${_currentHasAngleHead} → head=(${headX.position.x.toFixed(1)},${headYZ.position.y.toFixed(1)},${headYZ.position.z.toFixed(1)})`);
    } else {
      // Manual mode — no rotation info, simple compensation (A=0, C=0)
      headX.position.x = x;
      if (_currentHasAngleHead) {
        headYZ.position.y = y - _ahOutputY - G;
        headYZ.position.z = z + Math.abs(_ahOutputZ);
      } else {
        headYZ.position.y = y;
        headYZ.position.z = z + G;
      }
    }

    // Set rotary axes (Three.js scene graph handles the visual rotation)
    if (aDeg !== undefined) {
      aPivot.rotation.x = aDeg * Math.PI / 180;
      cPivot.rotation.z = cDeg * Math.PI / 180;
      updateSliderDisplay('axisA', aDeg);
      updateSliderDisplay('axisC', cDeg);
    }

    updateSliderDisplay('posX', x);
    updateSliderDisplay('posY', y);
    updateSliderDisplay('posZ', z);
  },
  setRotary(aDeg, cDeg) {
    // Note: When called from simulation, setHeadPosition handles rotation.
    // This is still used by manual slider controls.
    aPivot.rotation.x = aDeg * Math.PI / 180;
    cPivot.rotation.z = cDeg * Math.PI / 180;
    updateSliderDisplay('axisA', aDeg);
    updateSliderDisplay('axisC', cDeg);
  },
  setClampPosition(index, xMm) {
    if (index >= 0 && index < NUM_CLAMPS) {
      clampMeshes[index].position.x = xMm;
      updateSliderDisplay('clamp' + (index + 1), xMm);
    }
  },
  setClampType(geoIdent) {
    setClampType(geoIdent);
    if (clampTypeSelect) clampTypeSelect.value = geoIdent;
    if (simClampTypeSelect) simClampTypeSelect.value = geoIdent;
  },
  /** Returns list of available clamp geometry identifiers. */
  getClampTypes() {
    return Object.keys(CLAMP_GEOS);
  },
  /** Returns active clamp geometry identifier. */
  getActiveClampType() {
    return activeClampGeo;
  },
  /**
   * Returns the current profile offset relative to clamp zero.
   * { y: mm (depth into machine), z: mm (height above clamp zero) }
   * These are the EPO-derived PY/PZ values used to position the workpiece.
   */
  getProfileOffset() {
    return { y: _profileOffsetY, z: _profileOffsetZ };
  },
  /**
   * Manually set the profile/workpiece offset from clamp zero.
   * Useful when no EPO data is available but the parent app knows the offset.
   * Default PY = -51.6 mm (standard elumatec clamp offset for most profiles).
   *
   * @param {Object} offset
   * @param {number} [offset.y] — PY: depth into machine from clamp zero (mm). Default -51.6
   * @param {number} [offset.z] — PZ: height above clamp zero (mm). Default 0
   */
  setProfileOffset({ y = -51.6, z = 0 } = {}) {
    _profileOffsetY = y;
    _profileOffsetZ = z;
    _hasEpoProfileOffsets = true;
    profileGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
    // External meshes live in a separate group but must follow the same offset
    // so that ADD_MESH geometry lands at the correct position in the clamp
    _externalMeshGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
    console.log(`[ProfileOffset] PY=${_profileOffsetY} PZ=${_profileOffsetZ} → scene Y=${-_profileOffsetY} Z=${_profileOffsetZ}`);
  },
  setAngleHeadVisible(visible) {
    angleHeadGroup.visible = visible;
    const cb = document.getElementById('showAngleHead');
    if (cb) cb.checked = visible;
  },
  setJawOpen(mm) {
    clampJaws.forEach(j => { j.position.y = -mm; });
    updateSliderDisplay('jawOpen', mm);
  },
  setProfileLength(length) {
    pc.l = length;
    updateProfile(length, pc.w, pc.h);
    updateSliderDisplay('profLength', length);
    // NOTE: Do NOT set profileGroup.visible = true here.
    // setProfileLength is a BoxGeometry fallback — the profile should only
    // become visible when a real EPD cross-section (setProfile) or STEP file
    // (setStepProfile) is loaded. This prevents a ghost box appearing when
    // an .auf file lacks a valid profnr.
    // Hide STEP transform controls (no longer a STEP profile)
    _stepTransformGroup = null;
    const ctrl = document.getElementById('stepTransformControls');
    if (ctrl) ctrl.style.display = 'none';
  },
  /**
   * Set the profile from EPD cross-section data + length.
   * Looks up the profile number in the EPD database, creates an extruded
   * cross-section mesh, and replaces the current BoxGeometry profile.
   *
   * @param {string} profnr — Profile number/name from .auf metadata
   * @param {number} length — Bar length in mm
   */
  setProfile(profnr, length) {
    if (!_epdDatabase || !profnr) {
      // Fallback: just set length with BoxGeometry
      this.setProfileLength(length || pc.l);
      return;
    }

    // Look up profile in EPD database
    let profileDef = _epdDatabase.get(profnr);

    // Try without _MIR suffix
    if (!profileDef && profnr.endsWith('_MIR')) {
      profileDef = _epdDatabase.get(profnr.replace(/_MIR$/, ''));
    }

    // Try partial match (profile name might be a substring)
    if (!profileDef) {
      for (const [key, val] of _epdDatabase) {
        if (key.includes(profnr) || profnr.includes(key)) {
          profileDef = val;
          break;
        }
      }
    }

    if (!profileDef) {
      console.warn(`Profile "${profnr}" not found in EPD database, using BoxGeometry fallback`);
      this.setProfileLength(length || pc.l);
      return;
    }

    console.log(`Setting profile "${profnr}" → "${profileDef.name}" (${profileDef.width}×${profileDef.height}mm, ${profileDef.polygons.length} polygons)`);

    // Update profile dimensions
    pc.l = length || pc.l;
    pc.w = profileDef.width;
    pc.h = profileDef.height;

    // Look up EPO profile offsets (PY, PZ) — how far the profile sits from the clamp jaw
    // EPO Offsets: x=TransX(PX), y=OffsetY(PY), z=OffsetZ(PZ), w=OffsetY2, v5=OffsetTopY, v6=OffsetTopZ
    _profileOffsetY = 0;
    _profileOffsetZ = 0;
    _hasEpoProfileOffsets = false;
    if (_epoDatabase) {
      let epoEntry = _epoDatabase.get(profnr);
      if (!epoEntry && profnr.endsWith('_MIR')) {
        epoEntry = _epoDatabase.get(profnr.replace(/_MIR$/, ''));
      }
      if (!epoEntry) {
        for (const [key, val] of _epoDatabase) {
          if (key.includes(profnr) || profnr.includes(key)) {
            epoEntry = val;
            break;
          }
        }
      }
      if (epoEntry && epoEntry.stations[0]) {
        const off = epoEntry.stations[0].offsets;
        _profileOffsetY = off.y || 0;  // PY — depth into machine from clamp zero
        _profileOffsetZ = off.z || 0;  // PZ — height above clamp zero
        _hasEpoProfileOffsets = true;
        console.log(`Profile offsets from EPO: PY=${_profileOffsetY} PZ=${_profileOffsetZ}`);
      }
    }

    // Remove existing profile mesh and edges
    if (profileMesh) {
      profileGroup.remove(profileMesh);
      // Dispose geometries (profileMesh may be a Mesh or a Group)
      profileMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    if (profileEdges) {
      profileGroup.remove(profileEdges);
      if (profileEdges.geometry) profileEdges.geometry.dispose();
    }

    // Create extruded cross-section mesh
    const result = createProfileMesh(profileDef, pc.l, mat.profile);
    profileMesh = result.group;
    profileEdges = null;  // edges are inside the group, managed by the group

    // Hide STEP transform controls (no longer a STEP profile)
    _stepTransformGroup = null;
    const stepCtrl = document.getElementById('stepTransformControls');
    if (stepCtrl) stepCtrl.style.display = 'none';

    profileGroup.visible = true;

    // The profile mesh has EPD (0,0) at the group's local (0,0,0).
    // Coordinate mapping: EPD X → machine -Y, EPD Y → machine +Z, extrusion → machine +X.
    profileGroup.add(profileMesh);
    enableSpindleCamLayer(profileGroup);  // make visible in spindle cam
    enableSideViewLayer(profileGroup);    // make visible in side view

    // Position profile relative to clamp zero using EPO offsets:
    //   PY (mm) = profile offset in -Y direction from clamp zero (into machine)
    //   PZ (mm) = profile offset in +Z direction from clamp zero (upward)
    // The EPD polygon's origin (0,0) sits at these offsets from the clamp reference.
    profileGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
    _externalMeshGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
    console.log(`Profile position: Y=${(-_profileOffsetY).toFixed(1)} Z=${_profileOffsetZ.toFixed(1)} (PY=${_profileOffsetY}, PZ=${_profileOffsetZ})`);

    // Update slider displays
    updateSliderDisplay('profLength', pc.l);
    updateSliderDisplay('profWidth', pc.w);
    updateSliderDisplay('profHeight', pc.h);
  },
  /**
   * Position the profile in machine coordinates using NPV (zero point) data.
   * @param {Object} origin — { x, y, z } from simulationEngine.getOrigin()
   *
   * When EPO profile offsets (PY, PZ) are available, the profile is already
   * positioned by setProfile() using clamp-relative offsets. In that case,
   * this method is a no-op (profile is already correctly placed).
   *
   * Without EPO data (BoxGeometry fallback), this uses the NPV origin to
   * position the profile:
   *   origin.y = -(COffsetY + CWidth + dFixOffsetY) → profile front face Y
   *   origin.z = COffsetZ + CHeight + dFixOffsetZ   → profile top Z
   */
  setProfilePosition(origin) {
    if (!origin) return;
    // The toolpath is computed as (NPV origin + RTCP + delta) in MACHINE coords
    // — see simulationEngine: pos.{x,y,z} = origin{X,Y,Z} + rtcp + d. So the
    // profile MUST sit at the workpiece NPV to line up with the cuts.
    //
    // The EPO "offset" is the same generic value for every ASE60 profile
    // ({y:50,z:0}), NOT the real workpiece zero — trusting it left the bar
    // ~145 mm off in Y (in front of the clamps instead of held by them). So
    // whenever the .auf actually set a workpiece NPV, that wins over the EPO.
    //   origin.y = NPV-Y = -(55.6 + width) → the FAR edge (deepest into machine).
    //     The cross-section mesh extrudes toward -Y (local 0 → -width), and the
    //     cuts run +Y from the NPV (tool Y = originY + EV, EV∈[0,width]). So the
    //     group's near edge sits at origin.y + width (a fixed ~-55.6) and the mesh
    //     reaches back to origin.y — covering exactly the cut band.
    //   origin.z = NPV-Z = FixOffsetZ + height → profile TOP; group bottom = origin.z - height.
    const groupY = origin.y + (pc.w || 0);
    const groupZ = origin.z - pc.h;
    profileGroup.position.set(0, groupY, groupZ);
    _externalMeshGroup.position.set(0, groupY, groupZ);
    _hasEpoProfileOffsets = false;
    console.log(`Profile position (NPV): Y=${groupY.toFixed(1)} Z=${groupZ.toFixed(1)} (nearEdge=${groupY.toFixed(1)}, farEdge=${origin.y.toFixed(1)}, top=${origin.z.toFixed(1)}, w=${pc.w}, h=${pc.h})`);
  },

  /**
   * Replace the current profile with a STEP-imported mesh.
   * The STEP geometry is auto-aligned so the longest axis = machine X (bar length).
   * User can then adjust rotation, mirror, and position via setStepTransform().
   *
   * Scene graph:
   *   profileGroup
   *     └─ _stepTransformGroup  (user rotation/mirror/position — setStepTransform)
   *          └─ alignWrapper     (auto-alignment: longest axis→X, centered, Z=0)
   *               └─ stepGroup   (raw STEP geometry centered at origin)
   *
   * @param {THREE.Group} stepGroup — Group of tessellated meshes from stepLoader
   * @param {THREE.Box3} boundingBox — Bounding box of the raw STEP geometry
   * @param {Object} [opts] — { name }
   */
  setStepProfile(stepGroup, boundingBox, opts = {}) {
    // 1. Remove existing profile mesh + edges
    if (profileMesh) {
      profileGroup.remove(profileMesh);
      profileMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    if (profileEdges) {
      profileGroup.remove(profileEdges);
      if (profileEdges.geometry) profileEdges.geometry.dispose();
    }

    // 2. Apply aluminium material to all sub-meshes
    stepGroup.traverse(child => {
      if (child.isMesh) {
        child.material = mat.profile;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // 3. Auto-alignment: longest bounding box axis → machine +X
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    boundingBox.getSize(size);
    boundingBox.getCenter(center);

    // Center the raw geometry at the origin
    stepGroup.position.set(-center.x, -center.y, -center.z);

    // Alignment wrapper: rotate so longest axis → X, then position
    const alignWrapper = new THREE.Group();
    alignWrapper.name = 'stepAlignWrapper';
    alignWrapper.add(stepGroup);

    const dims = [
      { axis: 'x', size: size.x },
      { axis: 'y', size: size.y },
      { axis: 'z', size: size.z }
    ];
    dims.sort((a, b) => b.size - a.size);
    const longest = dims[0].axis;

    if (longest === 'y') {
      alignWrapper.rotation.z = -Math.PI / 2;
    } else if (longest === 'z') {
      alignWrapper.rotation.y = Math.PI / 2;
    }

    alignWrapper.updateMatrixWorld(true);
    const effectiveBox = new THREE.Box3().setFromObject(alignWrapper);
    const effSize = new THREE.Vector3();
    effectiveBox.getSize(effSize);

    // Position: bar starts at X=0, center Y, bottom at Z=0
    alignWrapper.position.x -= effectiveBox.min.x;
    alignWrapper.position.y -= (effectiveBox.min.y + effectiveBox.max.y) / 2;
    alignWrapper.position.z -= effectiveBox.min.z;

    // 4. User transform wrapper (rotation, mirror, position offset)
    _stepTransformGroup = new THREE.Group();
    _stepTransformGroup.name = 'stepTransform';
    _stepTransformGroup.add(alignWrapper);

    // Reset user transform state
    _stepRotationQ.identity();
    _stepMirror = { x: false, y: false, z: false };
    _stepOffset = { x: 0, y: 0, z: 0 };

    // 5. Update profile config
    pc.l = effSize.x;
    pc.w = effSize.y;
    pc.h = effSize.z;

    // 6. Assign to profileMesh
    profileMesh = _stepTransformGroup;
    profileEdges = null;

    // 7. Add to profileGroup
    profileGroup.add(profileMesh);
    profileGroup.visible = true;
    enableSpindleCamLayer(profileGroup);
    enableSideViewLayer(profileGroup);

    // 8. Reset positioning to default clamp offset
    _profileOffsetY = -51.6;
    _profileOffsetZ = 0;
    _hasEpoProfileOffsets = true;
    profileGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);
    _externalMeshGroup.position.set(0, -_profileOffsetY, _profileOffsetZ);

    // 9. Show STEP transform controls
    const ctrl = document.getElementById('stepTransformControls');
    if (ctrl) ctrl.style.display = '';

    // 10. Update displays
    _updateStepTransformUI();
    updateSliderDisplay('profLength', pc.l);
    updateSliderDisplay('profWidth', pc.w);
    updateSliderDisplay('profHeight', pc.h);

    console.log(`[STEP] Profile replaced: ${opts.name || 'STEP'}, ` +
      `${pc.l.toFixed(0)}×${pc.w.toFixed(0)}×${pc.h.toFixed(0)}mm, ` +
      `aligned ${longest}→X`);
  },

  /**
   * Set STEP profile transform (rotation, mirror, position offset).
   * Only has effect when a STEP profile is loaded.
   *
   * @param {Object} [transform]
   * @param {Object} [transform.rotation]   — Euler degrees { x, y, z } OR quaternion { _x, _y, _z, _w }
   * @param {Object} [transform.mirror]     — { x, y, z } booleans
   * @param {Object} [transform.offset]     — { x, y, z } in mm
   */
  setStepTransform(transform) {
    if (!_stepTransformGroup) return;

    if (transform.rotation) {
      const r = transform.rotation;
      if (r._w !== undefined) {
        // Quaternion supplied directly
        _stepRotationQ.set(r._x || 0, r._y || 0, r._z || 0, r._w);
      } else {
        // Euler degrees — convert to quaternion and replace
        const e = new THREE.Euler(
          (r.x || 0) * Math.PI / 180,
          (r.y || 0) * Math.PI / 180,
          (r.z || 0) * Math.PI / 180,
          'XYZ'
        );
        _stepRotationQ.setFromEuler(e);
      }
    }
    if (transform.mirror) {
      _stepMirror.x = transform.mirror.x ?? _stepMirror.x;
      _stepMirror.y = transform.mirror.y ?? _stepMirror.y;
      _stepMirror.z = transform.mirror.z ?? _stepMirror.z;
    }
    if (transform.offset) {
      _stepOffset.x = transform.offset.x ?? _stepOffset.x;
      _stepOffset.y = transform.offset.y ?? _stepOffset.y;
      _stepOffset.z = transform.offset.z ?? _stepOffset.z;
    }

    _applyStepTransform();
    _updateStepTransformUI();
  },

  /** Get current STEP transform state */
  getStepTransform() {
    return {
      rotation: { ..._stepRotation },
      mirror: { ..._stepMirror },
      offset: { ..._stepOffset }
    };
  },

  setManualControlsEnabled,

  /**
   * Swap the active tool in the toolGroup.
   * @param {Object} toolInfo — { tool, d, ident, diameter, lengthTotal, kind? }
   *
   * IMPORTANT dimensions:
   *   .auf TLengthTotal = GAUGE LENGTH (spindle nose to tool tip, includes mount)
   *   NCT TLength_Total = tool body length only (shank + cutting, NO mount)
   *   NCT TLengthMount + T2LengthMount = mount adapter length
   *
   * The toolVisualizer expects 'lengthTotal' = TOOL BODY length (without mount).
   * Mount dimensions are separate (mountLength, mount2Length).
   *
   * So: toolBody = aufGaugeLength - mountTotal
   */
  setTool(toolInfo) {
    if (!toolInfo) return;
    _lastToolInfo = toolInfo; // Save for live reload
    const toolId = toolInfo.tool;
    if (toolId === _currentToolId) return; // Already showing this tool
    _currentToolId = toolId;

    // Clear existing tool meshes
    while (toolGroup.children.length > 0) {
      const child = toolGroup.children[0];
      toolGroup.remove(child);
      child.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }

    // --- Build fullToolDef ---
    // .auf header: { ident, diameter, lengthTotal (gauge) }
    // NCT database: { kind, diameter, lengthTotal (body), lengthCutting, shankDiameter,
    //                  mountDiam, mountLength, mount2Diam, mount2Length, angle, ... }
    let fullToolDef = { ...toolInfo };
    const aufGaugeLength = toolInfo.lengthTotal || 0; // nose-to-tip, includes mount

    // Check NCT database for this TPlace
    let nctTool = (_nctDatabase && _nctDatabase.has(toolId)) ? _nctDatabase.get(toolId) : null;

    // If TPlace not found, try ident-based fallback lookup
    // (eluCad may remap tool numbers in .auf vs actual machine TPlace)
    const aufIdent = (toolInfo.ident || '').toLowerCase().trim();
    if (!nctTool && _nctDatabase && aufIdent) {
      for (const [, entry] of _nctDatabase) {
        const entryIdent = (entry.ident || '').toLowerCase().trim();
        if (entryIdent && (aufIdent === entryIdent || aufIdent.includes(entryIdent) || entryIdent.includes(aufIdent))) {
          nctTool = entry;
          console.log(`NCT fallback: .auf T${toolId} "${toolInfo.ident}" matched NCT TPlace=${entry.place} "${entry.ident}" by ident`);
          break;
        }
      }
    }

    // Check if NCT ident matches .auf ident (exact or substring)
    const nctIdent = nctTool ? (nctTool.ident || '').toLowerCase().trim() : '';
    const identMatch = nctTool && (aufIdent === nctIdent || aufIdent.includes(nctIdent) || nctIdent.includes(aufIdent));

    // Determine tool kind
    const kind = identMatch ? nctTool.kind
      : nctTool ? nctTool.kind  // same magazine pocket → likely same tool type
      : guessKind(fullToolDef.ident);
    fullToolDef.kind = kind;

    // --- Mount data ---
    // Mount is tied to the magazine pocket (TPlace), so NCT mount data is valid
    // even if the actual tool has been swapped (ident mismatch).
    // If no NCT, use defaults based on tool kind (SBZ151 HSK-63).
    if (nctTool && nctTool.mountDiam > 0) {
      fullToolDef.mountDiam = nctTool.mountDiam;
      fullToolDef.mountLength = nctTool.mountLength || 0;
      fullToolDef.mount2Diam = nctTool.mount2Diam || nctTool.mountDiam;
      fullToolDef.mount2Length = nctTool.mount2Length || 0;
    } else {
      // Default mounts for SBZ151
      if (kind === 'DRILL') {
        fullToolDef.mountDiam = 50; fullToolDef.mountLength = 81;
        fullToolDef.mount2Diam = 45; fullToolDef.mount2Length = 65;
      } else if (kind === 'SAW' || kind === 'NDISK') {
        fullToolDef.mountDiam = 63; fullToolDef.mountLength = 29;
        fullToolDef.mount2Diam = 63; fullToolDef.mount2Length = 0;
      } else {
        fullToolDef.mountDiam = 50; fullToolDef.mountLength = 35;
        fullToolDef.mount2Diam = 50; fullToolDef.mount2Length = 0;
      }
    }

    // --- Tool body dimensions ---
    // TLengthMount = total holder length (Gesamtlänge L), already includes T2LengthMount
    const mountTotal = fullToolDef.mountLength || 0;

    if (identMatch) {
      // Full NCT match — use NCT geometry details, .auf diameter
      if (toolInfo.diameter > 0) fullToolDef.diameter = toolInfo.diameter;
      fullToolDef.ident = toolInfo.ident || nctTool.ident;
      fullToolDef.lengthCutting = nctTool.lengthCutting;
      fullToolDef.shankDiameter = nctTool.shankDiameter;
      fullToolDef.angle = nctTool.angle;
      fullToolDef.screwDiameter = nctTool.screwDiameter;
      fullToolDef.screwLength = nctTool.screwLength;

      // Use NCT TLength_Total directly as tool body length (sticks out from mount end)
      fullToolDef.lengthTotal = nctTool.lengthTotal || Math.max(10, aufGaugeLength - mountTotal);
    } else {
      // No ident match — derive tool body from .auf data
      // Calculate body length: gauge - mount
      if (aufGaugeLength > mountTotal && mountTotal > 0) {
        fullToolDef.lengthTotal = aufGaugeLength - mountTotal;
      } else if (aufGaugeLength > 0) {
        fullToolDef.lengthTotal = aufGaugeLength;
      }

      // Shank diameter: drills = tool diameter, mills = slightly larger
      if (!fullToolDef.shankDiameter || !identMatch) {
        if (kind === 'DRILL') {
          fullToolDef.shankDiameter = fullToolDef.diameter;
        } else if (kind === 'SAW' || kind === 'NDISK') {
          fullToolDef.shankDiameter = nctTool ? nctTool.shankDiameter : 40;
        } else {
          fullToolDef.shankDiameter = Math.max(fullToolDef.diameter, Math.min(fullToolDef.diameter * 1.6, 16));
        }
      }

      // Drill tip angle
      if (kind === 'DRILL' && !fullToolDef.angle) {
        fullToolDef.angle = 120;
      }

      if (nctTool && !identMatch) {
        console.log(`NCT T${toolId}: "${nctTool.ident}" ≠ .auf "${toolInfo.ident}" — using mount from NCT, tool from .auf`);
      }
    }

    // Create new tool mesh
    const newTool = createToolMesh(fullToolDef, { tool: mat.tool, mount: mat.mount });
    toolGroup.add(newTool);
    enableSpindleCamLayer(toolGroup);  // make new tool visible in spindle cam
    enableSideViewLayer(toolGroup);    // make new tool visible in side view

    // Store gauge length for tool length compensation in setHeadPosition()
    const gaugeLength = aufGaugeLength > 0 ? aufGaugeLength : (fullToolDef.lengthTotal + mountTotal);
    _currentGaugeLength = gaugeLength;
    toolGroup.position.z = 0; // Tool hangs from spindle nose (Z=0)

    const mountInfo = fullToolDef.mountDiam ? ` mount:Ø${fullToolDef.mountDiam}×${mountTotal}` : '';

    // Show/hide angle head — only if the NCT pocket has an angle head AND the tool
    // ident actually matches (prevents a regular tool in the same pocket from getting
    // an angle head overlay when the pocket was configured for a different tool)
    const aufHintsAngleHead = aufIdent && (aufIdent.startsWith('wf') || aufIdent.startsWith('wk') || aufIdent.includes('angle'));
    const hasAngleHead = nctTool && nctTool.angleHead && (identMatch || aufHintsAngleHead);
    _currentHasAngleHead = !!hasAngleHead;
    angleHeadGroup.visible = hasAngleHead;
    const ahCb = document.getElementById('showAngleHead');
    if (ahCb) ahCb.checked = hasAngleHead;

    if (hasAngleHead) {
      // Look up specific angle head by TAngleHeadIdent from the database
      if (_angleHeadDatabase && nctTool.angleHeadIdent) {
        const headDef = _angleHeadDatabase.get(nctTool.angleHeadIdent);
        if (headDef) {
          buildAngleHead(headDef);
          console.log(`Angle head switched to: "${headDef.name}" for T${toolId}`);
        } else {
          console.warn(`Angle head "${nctTool.angleHeadIdent}" not found in database (${_angleHeadDatabase.size} heads available)`);
        }
      }

      // Move tool to angle head output port:
      // Remove from spindleOffset, add to angleHeadOutput (at angle head output position, rotated)
      if (toolGroup.parent !== angleHeadOutput) {
        toolGroup.removeFromParent();
        angleHeadOutput.add(toolGroup);
      }
      // Mirror the tool along Z so it points out of the angle head output
      toolGroup.position.set(0, 0, 0);
      toolGroup.rotation.set(0, 0, 0);
      toolGroup.scale.set(1, 1, -1);
    } else {
      // Normal: tool hangs from spindle nose
      if (toolGroup.parent !== spindleOffset) {
        toolGroup.removeFromParent();
        spindleOffset.add(toolGroup);
      }
      toolGroup.position.set(0, 0, 0);
      toolGroup.rotation.set(0, 0, 0);
      toolGroup.scale.set(1, 1, 1);
    }

    const ahInfo = hasAngleHead ? ` WFK:"${nctTool.angleHeadIdent}"` : '';
    console.log(`Tool: T${toolId} ${fullToolDef.ident || ''} (${fullToolDef.kind || '?'} Ø${fullToolDef.diameter} body:${fullToolDef.lengthTotal} gauge:${gaugeLength}${mountInfo}${ahInfo})`);
  },

  /**
   * Validate .auf tool table against NCT database.
   * Returns an array of warnings: { level: 'red'|'yellow', text: string }
   *  - red:    tool ident not found anywhere in NCT (completely unknown)
   *  - yellow: tool ident found in NCT but on a different TPlace (pocket mismatch)
   *  - (no warning): TPlace + ident match perfectly
   */
  validateTools(aufTools) {
    const warnings = [];
    if (!aufTools || !_nctDatabase || _nctDatabase.size === 0) return warnings;

    for (const [tPlace, aufTool] of Object.entries(aufTools)) {
      const aufId = (aufTool.ident || '').toLowerCase().trim();
      if (!aufId) continue;

      const nctByPlace = _nctDatabase.get(parseInt(tPlace));
      if (nctByPlace) {
        const nctId = (nctByPlace.ident || '').toLowerCase().trim();
        const match = aufId === nctId || aufId.includes(nctId) || nctId.includes(aufId);
        if (match) continue; // Perfect match on same TPlace — all good
      }

      // TPlace didn't match — search by ident across all NCT entries
      let foundOnOtherPlace = null;
      for (const [place, entry] of _nctDatabase) {
        const entryId = (entry.ident || '').toLowerCase().trim();
        if (entryId && (aufId === entryId || aufId.includes(entryId) || entryId.includes(aufId))) {
          foundOnOtherPlace = entry;
          break;
        }
      }

      if (foundOnOtherPlace) {
        // Yellow: found by ident but on different TPlace
        warnings.push({
          level: 'yellow',
          text: `T${tPlace} "${aufTool.ident}" \u2192 hittad som T${foundOnOtherPlace.place} i NCT (annan plats)`
        });
      } else {
        // Red: not found anywhere in NCT
        const extra = nctByPlace ? ` (NCT T${tPlace} = "${nctByPlace.ident}")` : '';
        warnings.push({
          level: 'red',
          text: `T${tPlace} "${aufTool.ident}" \u00D8${aufTool.diameter} \u2014 saknas i NCT${extra}`
        });
      }
    }
    return warnings;
  },

  /**
   * Set fixture geometry on clamps from EPO+EFD data.
   * @param {string} profnr — Profile number from .auf metadata
   */
  setFixtures(profnr) {
    if (!_efdDatabase || !_epoDatabase) {
      console.log('Database not loaded, skipping fixture setup');
      return;
    }

    // Try to find the profile in EPO
    let profileName = profnr;
    let epoEntry = _epoDatabase.get(profileName);

    // Try without _MIR suffix
    if (!epoEntry && profileName.includes('_MIR')) {
      epoEntry = _epoDatabase.get(profileName.replace(/_MIR$/, ''));
    }

    // Try partial match
    if (!epoEntry) {
      for (const [key, val] of _epoDatabase) {
        if (key.includes(profileName) || profileName.includes(key)) {
          epoEntry = val;
          break;
        }
      }
    }

    if (!epoEntry) {
      console.log(`No EPO entry found for profile: "${profnr}"`);
      return;
    }

    console.log(`Applying fixtures for profile: ${profnr}`, epoEntry);

    // ────────────────────────────────────────────────────
    // Fixture coordinate mapping:
    //
    // EFD polygon is a 2D cross-section viewed from the END of the bar:
    //   polygon local X = depth (horizontal in cross-section view)
    //   polygon local Y = height (vertical in cross-section view)
    //   ExtrudeGeometry extrudes the 2D shape along local +Z
    //
    // Rotation: localX→machine -Y, localY→machine +Z, localZ→machine -X
    // Extrusion goes in -X → compensate with +dimLx offset.
    //
    // Positioning: fixtures use EPO offsets relative to clamp zero (0,0),
    // same principle as profile offsets (PY/PZ).
    // ────────────────────────────────────────────────────

    // Fixture rotation: localX→(0,-1,0), localY→(0,0,1), localZ→(-1,0,0)
    // Rotation matrix (row-major): R = [[0,0,-1],[-1,0,0],[0,1,0]]
    // Proper rotation (det=+1): quaternion (w=0.5, x=-0.5, y=-0.5, z=0.5)
    const fixtureMat4 = new THREE.Matrix4().set(
       0,  0, -1, 0,
      -1,  0,  0, 0,
       0,  1,  0, 0,
       0,  0,  0, 1
    );
    const fixtureQuat = new THREE.Quaternion().setFromRotationMatrix(fixtureMat4);

    // ── Fixture positioning ──
    // Y-position: from EFD OffsetL.y / OffsetR.y (e.g. 11.6 → machine Y = -11.6)
    // Z-position: from EPO Offset Z1 (offsets.v5, e.g. -169.85)
    //
    // EPO "Offsets" 6 values per station:
    //   offsets.x  = Offset X  (TransX, usually 0)
    //   offsets.y  = Offset Y  (PY — profile Y offset from clamp zero, e.g. 51.6)
    //   offsets.z  = Offset Z  (PZ — profile Z offset from clamp zero, e.g. 3.3)
    //   offsets.w  = Offset Y2 (front fixture Y2 offset, for right/movable jaw)
    //   offsets.v5 = Offset Z1 (fixture Z offset from clamp zero, e.g. -169.85)
    //   offsets.v6 = Offset Z2 (unused / reserved)

    // Resolve station 0 as fallback for clamps without their own fixture definition
    const fallbackStation = epoEntry.stations[0] || null;

    for (let i = 0; i < NUM_CLAMPS; i++) {
      const fixtureGrp = clampFixtureGroups[i];

      // Clear existing fixture meshes
      while (fixtureGrp.children.length > 0) {
        const child = fixtureGrp.children[0];
        fixtureGrp.remove(child);
        child.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      }

      // Use this station's fixture, or fall back to station 0
      let station = epoEntry.stations[i];
      if (!station || !station.fixtureName) {
        station = fallbackStation;
      }
      if (!station || !station.fixtureName) continue;

      const fixtureDef = _efdDatabase.get(station.fixtureName);
      if (!fixtureDef) {
        console.log(`Fixture "${station.fixtureName}" not found in EFD`);
        continue;
      }

      // EPO offsets for this station — fixture placement relative to clamp zero
      const epoOff = station.offsets || {};
      const fixtureOffsetZ = epoOff.v5 || 0;  // Offset Z1 = fixture Z offset from clamp zero (e.g. -169.85)

      // Create and position LEFT (back/static) fixture mesh
      const leftMesh = createFixtureMesh(fixtureDef, 'L', mat.fixture);
      if (leftMesh.children.length > 0) {
        leftMesh.quaternion.copy(fixtureQuat);
        const dimLx  = fixtureDef.dimensionL.x || 0;   // LengthS = extrusion length

        // Position fixture relative to clamp zero:
        //   X: EFD OffsetL.x + extrusion compensation
        //   Y: EFD OffsetL.y = fixture depth offset from clamp zero (e.g. 11.6 → Y=-11.6)
        //   Z: EPO Offset Z1 = fixture height offset from clamp zero (e.g. -169.85)
        leftMesh.position.set(
          fixtureDef.offsetL.x + dimLx,                  // X: EFD offset + extrusion compensation
          -fixtureDef.offsetL.y,                         // Y: EFD OffsetL.y (into machine)
          fixtureOffsetZ                                 // Z: EPO Offset Z1
        );
        fixtureGrp.add(leftMesh);
      }

      // Create and position RIGHT (front/movable) fixture mesh
      const rightMesh = createFixtureMesh(fixtureDef, 'R', mat.fixture);
      if (rightMesh.children.length > 0) {
        rightMesh.quaternion.copy(fixtureQuat);
        const dimRx = fixtureDef.dimensionR.x || 0;   // LengthM = extrusion length

        // Front fixture uses EFD OffsetR.y for Y, same Z as back fixture
        rightMesh.position.set(
          fixtureDef.offsetR.x + dimRx,                  // X: EFD offset + extrusion compensation
          -fixtureDef.offsetR.y,                         // Y: EFD OffsetR.y (into machine)
          fixtureOffsetZ                                 // Z: EPO Offset Z1
        );
        fixtureGrp.add(rightMesh);
      }

      enableSpindleCamLayer(fixtureGrp);  // fixtures visible in spindle cam
      enableSideViewLayer(fixtureGrp);    // fixtures visible in side view
      console.log(`Clamp ${i}: fixture="${station.fixtureName}" EFD offsetL.y=${fixtureDef.offsetL.y} offsetR.y=${fixtureDef.offsetR.y} EPO Z1=${fixtureOffsetZ}`);
      console.log(`  LEFT:  Y=${(-fixtureDef.offsetL.y).toFixed(1)} Z=${fixtureOffsetZ.toFixed(1)}`);
      console.log(`  RIGHT: Y=${(-fixtureDef.offsetR.y).toFixed(1)} Z=${fixtureOffsetZ.toFixed(1)}`);
    }
  },

  /** Get the loaded databases for reference */
  get nctDatabase() { return _nctDatabase; },
  get efdDatabase() { return _efdDatabase; },
  get epoDatabase() { return _epoDatabase; },
  get epdDatabase() { return _epdDatabase; },

  // ============================================================================
  // EXTERNAL MESHES — receive 3D geometry from parent (iframe embedding)
  // ============================================================================

  /**
   * Add an external mesh to the scene.
   * @param {Object} opts
   * @param {string} opts.id — Unique identifier for this mesh
   * @param {Float32Array|number[]} opts.vertices — Flat array of XYZ positions
   * @param {Uint32Array|number[]} [opts.indices] — Triangle indices (optional, if omitted uses non-indexed geometry)
   * @param {Float32Array|number[]} [opts.normals] — Flat array of vertex normals (optional, auto-computed if omitted)
   * @param {Float32Array|number[]} [opts.uvs] — Flat array of UV coordinates (optional)
   * @param {Float32Array|number[]} [opts.colors] — Flat array of vertex RGB colors (optional)
   * @param {Object} [opts.material] — Material properties { color, metalness, roughness, opacity, transparent, doubleSide }
   * @param {Object} [opts.transform] — { position: {x,y,z}, rotation: {x,y,z}, scale: {x,y,z} }
   * @param {string} [opts.name] — Display name
   */
  addExternalMesh(opts) {
    if (!opts || !opts.id || !opts.vertices) return;

    // Remove existing mesh with same id
    this.removeExternalMesh(opts.id);

    // Build BufferGeometry
    const geo = new THREE.BufferGeometry();
    const verts = opts.vertices instanceof Float32Array ? opts.vertices : new Float32Array(opts.vertices);
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));

    if (opts.indices) {
      const idx = opts.indices instanceof Uint32Array ? opts.indices : new Uint32Array(opts.indices);
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }

    if (opts.normals) {
      const norms = opts.normals instanceof Float32Array ? opts.normals : new Float32Array(opts.normals);
      geo.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    } else {
      geo.computeVertexNormals();
    }

    if (opts.uvs) {
      const uv = opts.uvs instanceof Float32Array ? opts.uvs : new Float32Array(opts.uvs);
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }

    if (opts.colors) {
      const cols = opts.colors instanceof Float32Array ? opts.colors : new Float32Array(opts.colors);
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }

    // Build material
    const matOpts = opts.material || {};
    const meshMat = new THREE.MeshStandardMaterial({
      color: matOpts.color !== undefined ? matOpts.color : 0xcccccc,
      metalness: matOpts.metalness !== undefined ? matOpts.metalness : 0.3,
      roughness: matOpts.roughness !== undefined ? matOpts.roughness : 0.6,
      transparent: false,
      opacity: 1.0,
      side: matOpts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: !!opts.colors,
    });

    const mesh = new THREE.Mesh(geo, meshMat);
    mesh.name = opts.name || opts.id;
    mesh.userData._externalId = opts.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Apply transform
    if (opts.transform) {
      const t = opts.transform;
      if (t.position) mesh.position.set(t.position.x || 0, t.position.y || 0, t.position.z || 0);
      if (t.rotation) mesh.rotation.set(
        (t.rotation.x || 0) * Math.PI / 180,
        (t.rotation.y || 0) * Math.PI / 180,
        (t.rotation.z || 0) * Math.PI / 180
      );
      if (t.scale) mesh.scale.set(t.scale.x || 1, t.scale.y || 1, t.scale.z || 1);
    }

    _externalMeshGroup.add(mesh);
    enableSpindleCamLayer(_externalMeshGroup);
    enableSideViewLayer(_externalMeshGroup);
    console.log(`[External] Added mesh "${opts.id}" (${verts.length / 3} verts)`);
    return opts.id;
  },

  /**
   * Add an external mesh from a glTF/GLB URL or data URI.
   * @param {Object} opts
   * @param {string} opts.id — Unique identifier
   * @param {string} opts.url — URL to glTF/GLB file or data URI
   * @param {Object} [opts.transform] — { position, rotation, scale }
   * @param {string} [opts.name] — Display name
   */
  async addExternalGLTF(opts) {
    if (!opts || !opts.id || !opts.url) return;
    this.removeExternalMesh(opts.id);

    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
      loader.load(opts.url, (gltf) => {
        const group = gltf.scene;
        group.name = opts.name || opts.id;
        group.userData._externalId = opts.id;
        group.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        if (opts.transform) {
          const t = opts.transform;
          if (t.position) group.position.set(t.position.x || 0, t.position.y || 0, t.position.z || 0);
          if (t.rotation) group.rotation.set(
            (t.rotation.x || 0) * Math.PI / 180,
            (t.rotation.y || 0) * Math.PI / 180,
            (t.rotation.z || 0) * Math.PI / 180
          );
          if (t.scale) group.scale.set(t.scale.x || 1, t.scale.y || 1, t.scale.z || 1);
        }
        _externalMeshGroup.add(group);
        enableSpindleCamLayer(_externalMeshGroup);
        enableSideViewLayer(_externalMeshGroup);
        console.log(`[External] Added GLTF "${opts.id}" from ${opts.url.substring(0, 60)}...`);
        resolve(opts.id);
      }, undefined, (err) => {
        console.error(`[External] Failed to load GLTF "${opts.id}":`, err);
        reject(err);
      });
    });
  },

  /**
   * Remove an external mesh by id.
   * @param {string} id
   */
  removeExternalMesh(id) {
    const child = _externalMeshGroup.children.find(c => c.userData._externalId === id);
    if (child) {
      _externalMeshGroup.remove(child);
      child.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
      console.log(`[External] Removed mesh "${id}"`);
    }
  },

  /**
   * Remove all external meshes.
   */
  clearExternalMeshes() {
    while (_externalMeshGroup.children.length > 0) {
      const child = _externalMeshGroup.children[0];
      _externalMeshGroup.remove(child);
      child.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
    }
    console.log(`[External] Cleared all meshes`);
  },

  /**
   * Update transform of an existing external mesh.
   * @param {string} id
   * @param {Object} transform — { position: {x,y,z}, rotation: {x,y,z}, scale: {x,y,z} }
   */
  updateExternalMeshTransform(id, transform) {
    const child = _externalMeshGroup.children.find(c => c.userData._externalId === id);
    if (!child || !transform) return;
    if (transform.position) child.position.set(transform.position.x || 0, transform.position.y || 0, transform.position.z || 0);
    if (transform.rotation) child.rotation.set(
      (transform.rotation.x || 0) * Math.PI / 180,
      (transform.rotation.y || 0) * Math.PI / 180,
      (transform.rotation.z || 0) * Math.PI / 180
    );
    if (transform.scale) child.scale.set(transform.scale.x || 1, transform.scale.y || 1, transform.scale.z || 1);
  },

  /**
   * List all external mesh IDs currently in the scene.
   * @returns {string[]}
   */
  getExternalMeshIds() {
    return _externalMeshGroup.children.map(c => c.userData._externalId);
  },
};

const simUI = new SimulationUI(machineInterface);
_simUI = simUI;

// Enable postMessage API for iframe embedding
simUI.enablePostMessageAPI();

// Notify parent that simulator is ready, including available clamp types
// so the parent app can populate a fixture selector immediately.
if (window.parent && window.parent !== window) {
  window.parent.postMessage({
    type: 'READY',
    clampTypes: Object.keys(CLAMP_GEOS),
    activeClampType: activeClampGeo,
    profileOffset: { y: _profileOffsetY, z: _profileOffsetZ },
  }, '*');
}

// ============================================================================
// STEP PROFILE IMPORT — file picker + drag-drop
// ============================================================================

/**
 * Handle a STEP file: tessellate via WASM and replace the profile.
 * @param {File} file
 */
async function handleStepFileLoad(file) {
  const overlay = document.getElementById('stepLoadingOverlay');
  const loadingText = document.getElementById('stepLoadingText');
  const fileNameSpan = document.getElementById('stepFileName');

  try {
    if (overlay) overlay.style.display = 'flex';
    if (loadingText) loadingText.textContent = `Laddar ${file.name}...`;

    // Dynamic import — stepLoader.js + WASM only loaded when actually needed
    const { loadStepFile } = await import('./stepLoader.js');

    const buffer = await file.arrayBuffer();

    if (loadingText) loadingText.textContent = 'Tessellerar STEP geometri...';
    const result = await loadStepFile(buffer);

    machineInterface.setStepProfile(result.group, result.boundingBox, {
      name: file.name
    });

    if (fileNameSpan) fileNameSpan.textContent = file.name;
    console.log(`[STEP] Loaded ${file.name}: ${result.meshCount} meshes, ${result.vertexCount} vertices`);

  } catch (err) {
    console.error('[STEP] Failed to load:', err);
    alert('Kunde inte ladda STEP-fil: ' + err.message);
  } finally {
    if (overlay) overlay.style.display = 'none';
  }
}

// File picker
document.getElementById('stepFile')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await handleStepFileLoad(file);
});

// Drag-and-drop on the 3D viewport
renderer.domElement.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
renderer.domElement.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find(f =>
    /\.(step|stp)$/i.test(f.name)
  );
  if (file) await handleStepFileLoad(file);
});

// --- STEP Transform UI event handlers ---

// Rotation buttons (90° steps)
// Each click pre-multiplies a 90° rotation around a fixed world axis onto the
// cumulative quaternion. Pre-multiply = rotate in world space (machine axes),
// so X always means "tilt around machine X", regardless of previous rotations.
function _stepRotate(axis, delta) {
  const rad = delta * Math.PI / 180;
  const ax = axis === 'x' ? new THREE.Vector3(1, 0, 0)
           : axis === 'y' ? new THREE.Vector3(0, 1, 0)
                          : new THREE.Vector3(0, 0, 1);
  _stepRotTmp.setFromAxisAngle(ax, rad);
  // Post-multiply: new = old * stepTmp  →  rotates around world (machine) axes
  _stepRotationQ.multiply(_stepRotTmp);
  _applyStepTransform();
  _updateStepTransformUI();
}
document.getElementById('stepRotXm')?.addEventListener('click', () => _stepRotate('x', -90));
document.getElementById('stepRotXp')?.addEventListener('click', () => _stepRotate('x', 90));
document.getElementById('stepRotYm')?.addEventListener('click', () => _stepRotate('y', -90));
document.getElementById('stepRotYp')?.addEventListener('click', () => _stepRotate('y', 90));
document.getElementById('stepRotZm')?.addEventListener('click', () => _stepRotate('z', -90));
document.getElementById('stepRotZp')?.addEventListener('click', () => _stepRotate('z', 90));

// Mirror checkboxes
document.getElementById('stepMirX')?.addEventListener('change', (e) => {
  _stepMirror.x = e.target.checked; _applyStepTransform();
});
document.getElementById('stepMirY')?.addEventListener('change', (e) => {
  _stepMirror.y = e.target.checked; _applyStepTransform();
});
document.getElementById('stepMirZ')?.addEventListener('change', (e) => {
  _stepMirror.z = e.target.checked; _applyStepTransform();
});

// Position offset sliders
for (const axis of ['X', 'Y', 'Z']) {
  const slider = document.getElementById('stepOff' + axis);
  if (slider) {
    slider.addEventListener('input', () => {
      _stepOffset[axis.toLowerCase()] = parseFloat(slider.value);
      _applyStepTransform();
      const valEl = document.getElementById('stepOff' + axis + '_val');
      if (valEl) valEl.textContent = `${slider.value} mm`;
    });
  }
}

// Reset transform button
document.getElementById('stepResetTransform')?.addEventListener('click', () => {
  _stepRotationQ.identity();
  _stepMirror = { x: false, y: false, z: false };
  _stepOffset = { x: 0, y: 0, z: 0 };
  _applyStepTransform();
  _updateStepTransformUI();
});

// ============================================================================
// LOAD AXIUM DATABASE FILES
// ============================================================================
async function loadDatabases() {
  const statusEl = document.getElementById('dbStatus');
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

  try {
    setStatus('Laddar databaser...');

    // 1. Get active machine file mappings
    let activeFiles = {};
    let activeName = null;
    try {
      const configRes = await fetch('api/active-files');
      const config = await configRes.json();
      activeFiles = config.files || {};
      activeName = config.name;
    } catch (e) {
      console.warn('Could not load active machine config:', e);
    }

    // 2. Fetch each file that's configured in the active machine profile
    //    encodeURIComponent so filenames with spaces (e.g. "SBZ151_ME _7m.ncm")
    //    resolve correctly.
    const fetchFile = (filename) =>
      filename ? fetch('data/' + encodeURIComponent(filename)).then(r => r.ok ? r.text() : null).catch(() => null) : Promise.resolve(null);

    const [nctRes, efdRes, epoRes, epdRes, ahRes, ncmRes] = await Promise.all([
      fetchFile(activeFiles.nct),
      fetchFile(activeFiles.efd),
      fetchFile(activeFiles.epo),
      fetchFile(activeFiles.epd),
      fetchFile(activeFiles.anglehead),
      fetchFile(activeFiles.ncm),
    ]);

    const parts = [];

    if (nctRes) {
      _nctDatabase = parseNctFile(nctRes);
      parts.push(`${_nctDatabase.size} verktyg`);
      console.log(`NCT: Loaded ${_nctDatabase.size} tools`, [..._nctDatabase.keys()]);

      // Check for embedded :ANGLEHEAD sections in NCT
      if (_nctDatabase.angleHeads && _nctDatabase.angleHeads.size > 0) {
        _angleHeadDatabase = _nctDatabase.angleHeads;
        console.log(`NCT: Loaded ${_angleHeadDatabase.size} angle heads from NCT`, [..._angleHeadDatabase.keys()]);
        // Build the first angle head as default geometry
        const firstHead = _angleHeadDatabase.values().next().value;
        buildAngleHead(firstHead);
        parts.push(`WFK "${firstHead.name}" (NCT)`);
      }
    }

    if (efdRes) {
      _efdDatabase = parseEfdFile(efdRes);
      parts.push(`${_efdDatabase.size} fixturer`);
      console.log(`EFD: Loaded ${_efdDatabase.size} fixtures`, [..._efdDatabase.keys()]);
    }

    if (epoRes) {
      _epoDatabase = parseEpoFile(epoRes);
      parts.push(`${_epoDatabase.size} profiler`);
      console.log(`EPO: Loaded ${_epoDatabase.size} profile offsets`, [..._epoDatabase.keys()]);
    }

    if (epdRes) {
      _epdDatabase = parseEpdFile(epdRes);
      parts.push(`${_epdDatabase.size} profiltvärsnitt`);
      console.log(`EPD: Loaded ${_epdDatabase.size} profile cross-sections`, [..._epdDatabase.keys()]);
    }

    // Machine-specific clamp geometry from the active .ncm :CLAMPGEO. The 7m
    // and Axium clamps are physically different (support/jaw heights, fixture
    // offsets), so build the real geometry for whichever machine is active
    // instead of the hardcoded approximation.
    if (ncmRes) {
      const cg = parseNcmClampGeo(ncmRes);
      if (cg && (cg.boxStatic.length || cg.boxMovable.length)) {
        const key = `${activeName || cg.ident} (NCM)`;
        CLAMP_GEOS[key] = {
          ident: key,
          comment: `${cg.ident} från ${activeFiles.ncm} (${cg.boxStatic.length} static + ${cg.boxMovable.length} rörliga)`,
          full: true,
          boxStatic: cg.boxStatic,
          boxMovable: cg.boxMovable,
          fixOffsetY: cg.fixOffsetY,
          fixOffsetZ: cg.fixOffsetZ,
        };
        setClampType(key);
        parts.push(`klamp "${cg.ident}"`);
        console.log(`NCM: Clamp geometry "${cg.ident}" — ${cg.boxStatic.length} static + ${cg.boxMovable.length} movable boxes, FixOffsetY=${cg.fixOffsetY} FixOffsetZ=${cg.fixOffsetZ}`);
      }
    }

    // Fallback: load AngleHead.ini only if NCT didn't have angle heads
    if (ahRes && !_angleHeadDatabase) {
      const ahDatabase = parseAngleHeadIni(ahRes);
      if (ahDatabase.size > 0) {
        _angleHeadDatabase = ahDatabase;
        const firstHead = ahDatabase.values().next().value;
        buildAngleHead(firstHead);
        parts.push(`WFK "${firstHead.name}" (INI)`);
      }
    }

    const prefix = activeName ? `[${activeName}] ` : '';
    if (parts.length > 0) {
      setStatus(`${prefix}${parts.join(', ')}`);
    } else {
      setStatus(prefix + 'Inga databaser hittades');
    }

    // Re-apply the current profile now that EPD/EPO/NCM are loaded — fixes the
    // plain-box fallback when the .auf was opened before the databases were
    // ready, or after switching the active machine profile.
    if (typeof simUI !== 'undefined' && simUI && simUI.reapplyCurrentProfile) {
      simUI.reapplyCurrentProfile();
    }
  } catch (err) {
    console.error('Failed to load databases:', err);
    setStatus('DB-laddning misslyckades');
  }
}

// Start loading databases immediately
loadDatabases();
// Expose for settings panel (non-module script) to trigger reload after file changes
window._reloadDatabases = async () => {
  // Reset all database state
  _nctDatabase = null;
  _efdDatabase = null;
  _epoDatabase = null;
  _epdDatabase = null;
  _angleHeadDatabase = null;

  // Reload all databases from active machine profile
  await loadDatabases();

  // --- Re-apply visual state so changes are immediately visible ---

  // 1. Rebuild clamps with current geometry type (uses EFD for fixtures)
  setClampType(activeClampGeo);

  // 2. Re-apply profile (uses EPD for cross-section, EPO for offsets)
  updateProfile(pc.l, pc.w, pc.h);

  // 3. Force tool rebuild (uses NCT) — reset _currentToolId so setTool re-runs
  if (_lastToolInfo) {
    _currentToolId = null; // force rebuild
    machineInterface.setTool(_lastToolInfo);
  }

  console.log('[RELOAD] Databases reloaded and visual state refreshed');
};

// ============================================================================
// JOG TO ZERO & SET ZERO POINT
// ============================================================================
const zeroOffset = { x: 0, y: 0, z: 0, a: 0, c: 0 };

function updateZeroDisplay() {
  const el = document.getElementById('simZeroOffset');
  if (!el) return;
  const o = zeroOffset;
  if (o.x === 0 && o.y === 0 && o.z === 0 && o.a === 0 && o.c === 0) {
    el.textContent = '';
  } else {
    el.textContent = `0-punkt: X${o.x.toFixed(1)} Y${o.y.toFixed(1)} Z${o.z.toFixed(1)} A${o.a.toFixed(1)}\u00B0 C${o.c.toFixed(1)}\u00B0`;
  }
}

document.getElementById('jogZero')?.addEventListener('click', () => {
  // Animate machine to zero point (0 + offset)
  const targetX = zeroOffset.x;
  const targetY = zeroOffset.y;
  const targetZ = zeroOffset.z;
  const targetA = zeroOffset.a;
  const targetC = zeroOffset.c;

  const startX = headX.position.x;
  const startY = headYZ.position.y;
  const startZ = headYZ.position.z;
  const startA = aPivot.rotation.x * 180 / Math.PI;
  const startC = cPivot.rotation.z * 180 / Math.PI;

  const dx = Math.abs(targetX - startX) + Math.abs(targetY - startY) + Math.abs(targetZ - startZ);
  const da = Math.abs(targetA - startA) + Math.abs(targetC - startC);
  const jogDuration = Math.max(0.5, Math.min(3.0, Math.max(dx / 2000, da / 180)));
  const jogStart = performance.now();

  jogAnimation = { startX, startY, startZ, startA, startC,
    targetX, targetY, targetZ, targetA, targetC,
    duration: jogDuration * 1000, startTime: jogStart };
});

document.getElementById('setZero')?.addEventListener('click', () => {
  // Current position becomes the new zero
  zeroOffset.x = headX.position.x;
  zeroOffset.y = headYZ.position.y;
  zeroOffset.z = headYZ.position.z;
  zeroOffset.a = aPivot.rotation.x * 180 / Math.PI;
  zeroOffset.c = cPivot.rotation.z * 180 / Math.PI;
  updateZeroDisplay();
});

document.getElementById('clearZero')?.addEventListener('click', () => {
  zeroOffset.x = 0; zeroOffset.y = 0; zeroOffset.z = 0;
  zeroOffset.a = 0; zeroOffset.c = 0;
  updateZeroDisplay();
});

// Jog animation tick — runs in animate loop
function tickJog(timestamp) {
  if (!jogAnimation) return;
  const elapsed = timestamp - jogAnimation.startTime;
  let t = Math.min(1, elapsed / jogAnimation.duration);
  // Smooth ease-in-out
  t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  const j = jogAnimation;
  const x = j.startX + (j.targetX - j.startX) * t;
  const y = j.startY + (j.targetY - j.startY) * t;
  const z = j.startZ + (j.targetZ - j.startZ) * t;
  const a = j.startA + (j.targetA - j.startA) * t;
  const c = j.startC + (j.targetC - j.startC) * t;

  machineInterface.setHeadPosition(x, y, z, a, c);

  if (elapsed >= jogAnimation.duration) {
    jogAnimation = null;
  }
}
