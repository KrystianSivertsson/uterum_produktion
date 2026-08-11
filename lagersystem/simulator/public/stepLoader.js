/**
 * stepLoader.js — STEP file tessellation using occt-import-js (WASM)
 *
 * Lazy-loads the occt-import-js WASM library on first use (~7MB download),
 * tessellates STEP B-Rep geometry into triangle meshes, and returns
 * Three.js-ready BufferGeometry objects.
 *
 * Usage:
 *   import { loadStepFile } from './stepLoader.js';
 *   const result = await loadStepFile(arrayBuffer);
 *   // result.group = THREE.Group with all mesh parts
 *   // result.boundingBox = THREE.Box3
 */

import * as THREE from 'three';

// ============================================================================
// WASM singleton — loaded once, cached forever
// ============================================================================

let _occtPromise = null;

function _initOcct() {
  if (_occtPromise) return _occtPromise;

  _occtPromise = new Promise((resolve, reject) => {
    // occt-import-js is a UMD module — load via <script> tag
    const script = document.createElement('script');
    script.src = 'lib/occt-import-js/occt-import-js.js';
    script.onload = () => {
      // The script exposes a global `occtimportjs` factory function.
      // Calling it initialises the WASM module (fetches .wasm relative to .js).
      if (typeof occtimportjs !== 'function') {
        reject(new Error('occtimportjs not found after script load'));
        return;
      }
      occtimportjs().then(resolve).catch(reject);
    };
    script.onerror = () => reject(new Error('Failed to load occt-import-js.js'));
    document.head.appendChild(script);
  });

  return _occtPromise;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Tessellate a STEP file and return Three.js geometry.
 *
 * @param {ArrayBuffer} buffer — Raw STEP file bytes
 * @param {Object} [options]
 * @param {number} [options.linearDeflection] — Tessellation quality (lower = finer)
 * @returns {Promise<{
 *   group: THREE.Group,
 *   boundingBox: THREE.Box3,
 *   meshCount: number,
 *   vertexCount: number,
 *   name: string
 * }>}
 */
export async function loadStepFile(buffer, options = {}) {
  const occt = await _initOcct();

  const fileBuffer = new Uint8Array(buffer);
  const result = occt.ReadStepFile(fileBuffer, null);

  if (!result || !result.meshes || result.meshes.length === 0) {
    throw new Error('No geometry found in STEP file');
  }

  // Build Three.js group from all result meshes
  const group = new THREE.Group();
  group.name = 'stepImport';
  let totalVerts = 0;

  for (const resultMesh of result.meshes) {
    const geo = new THREE.BufferGeometry();

    // Vertex positions (flat Float32Array: x,y,z,x,y,z,...)
    const positions = resultMesh.attributes.position.array;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    totalVerts += positions.length / 3;

    // Vertex normals
    if (resultMesh.attributes.normal) {
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(
        resultMesh.attributes.normal.array, 3
      ));
    } else {
      geo.computeVertexNormals();
    }

    // Triangle indices
    if (resultMesh.index) {
      geo.setIndex(new THREE.BufferAttribute(
        new Uint32Array(resultMesh.index.array), 1
      ));
    }

    geo.computeBoundingBox();

    // Create mesh (material will be assigned by caller / setStepProfile)
    const mesh = new THREE.Mesh(geo);
    mesh.name = resultMesh.name || 'stepPart';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Also add edge lines for better visual definition
    const edgeGeo = new THREE.EdgesGeometry(geo, 30); // 30 degree threshold
    if (edgeGeo.attributes.position && edgeGeo.attributes.position.count > 0) {
      const edges = new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.3 })
      );
      edges.name = 'stepEdges';
      group.add(edges);
    }
  }

  // Compute overall bounding box
  const boundingBox = new THREE.Box3().setFromObject(group);

  return {
    group,
    boundingBox,
    meshCount: result.meshes.length,
    vertexCount: totalVerts,
    name: result.meshes[0]?.name || 'STEP'
  };
}
