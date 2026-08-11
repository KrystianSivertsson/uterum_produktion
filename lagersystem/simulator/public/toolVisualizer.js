// ============================================================================
// toolVisualizer.js — Parametric 3D tool mesh builder for CNC tools
// Creates Three.js meshes for mills, drills, saws, and disc cutters (NDISK)
//
// COORDINATE SYSTEM (in toolGroup's local frame):
//   Z=0 = spindle nose (attachment point)
//   -Z  = toward workpiece (tool extends downward)
//
// TOOL STACK (from spindle nose downward):
//   1. Mount body (adapter)        Z=0  to  Z=-mountLen
//   2. Mount taper (optional)      Z=-mountLen  to  Z=-(mountLen+mount2Len)
//   3. Tool shank                  Z=-mountTotal  to  Z=-(mountTotal + shankLen)
//   4. Cutting portion             Z=-(mountTotal + shankLen)  to  Z=-(mountTotal + lTotal)
//   5. Tip (drill only)            conical tip at the very bottom
//
// TLength_Total (NCT) = tool body length (shank + cutting) WITHOUT mount
// TLengthTotal (.auf) = total gauge length from spindle nose to tip (includes mount)
// ============================================================================

import * as THREE from 'three';

/**
 * Create a 3D mesh group for a CNC tool.
 *
 * @param {Object} toolDef — Tool definition from NCT + .auf:
 *   { kind, diameter, lengthTotal, lengthCutting?, shankDiameter?,
 *     mountDiam?, mountLength?, mount2Diam?, mount2Length?,
 *     screwDiameter?, screwLength?, ident?, angle? }
 * @param {Object} materials — { tool, mount } Three.js materials
 * @returns {THREE.Group}
 */
export function createToolMesh(toolDef, materials) {
  const group = new THREE.Group();
  group.name = 'toolAssembly';

  if (!toolDef || !toolDef.diameter) return group;

  const kind = (toolDef.kind || guessKind(toolDef.ident)).toUpperCase();
  const d = toolDef.diameter;
  const r = d / 2;
  const lTotal = toolDef.lengthTotal || d * 3;     // tool body length (NCT TLength_Total)
  const lCut = toolDef.lengthCutting || lTotal * 0.4;
  const shankD = toolDef.shankDiameter || d;
  const shankR = shankD / 2;

  // Mount dimensions
  const mountDiam = toolDef.mountDiam || 0;
  const mountLen = toolDef.mountLength || 0;
  const mount2Diam = toolDef.mount2Diam || mountDiam;
  const mount2Len = toolDef.mount2Length || 0;
  const mountTotalLen = mountLen + mount2Len;

  // Tool material
  const matTool = materials.tool;
  const matMount = materials.mount || materials.tool;

  // Build mount first (closest to spindle nose)
  let zCursor = 0; // Start at spindle nose
  if (mountDiam > 0 && mountLen > 0) {
    zCursor = buildMount(group, mountDiam, mount2Diam, mountLen, mount2Len, matMount);
  }

  // Build tool geometry based on kind (starting from below mount)
  switch (kind) {
    case 'MILL':
      buildMill(group, r, shankR, lCut, lTotal, zCursor, matTool);
      break;
    case 'DRILL':
      buildDrill(group, r, shankR, lTotal, toolDef.angle || 120, zCursor, matTool);
      break;
    case 'SAW':
    case 'NDISK':
      buildSaw(group, toolDef, zCursor, matTool, matMount);
      break;
    default:
      buildMill(group, r, shankR, lCut, lTotal, zCursor, matTool);
      break;
  }

  return group;
}

/**
 * Guess tool kind from TIdent string.
 * "B..." = drill, "F..." = mill, "S..." or "Saw..." = saw
 */
export function guessKind(ident) {
  if (!ident) return 'MILL';
  const id = ident.trim();
  if (id.match(/^B\d/i)) return 'DRILL';
  if (id.match(/^F\d/i)) return 'MILL';
  if (id.match(/^S/i) || id.match(/saw/i)) return 'SAW';
  return 'MILL';
}

/**
 * Helper: create a cylinder mesh aligned along the spindle Z-axis.
 * CylinderGeometry default axis is Y, so we rotate 90° around X.
 *
 * After rotation.x = PI/2:
 *   CylinderGeometry +Y → -Z (lower/workpiece side)
 *   CylinderGeometry -Y → +Z (upper/spindle side)
 *
 * So CylGeo(radiusTop, radiusBottom) maps to:
 *   radiusTop → -Z end (bottom of our cylinder)
 *   radiusBottom → +Z end (top of our cylinder)
 *
 * We want rTop at Z=z (top) and rBot at Z=z-height (bottom), so:
 *   CylGeo.radiusTop = rBot (goes to -Z = bottom)
 *   CylGeo.radiusBottom = rTop (goes to +Z = top)
 */
function zCylinder(rTop, rBot, height, z, mat, segments = 24) {
  const geo = new THREE.CylinderGeometry(rBot, rTop, height, segments);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(0, 0, z - height / 2); // z is the TOP of the cylinder
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- Tool Holder / Mount ----
// NCT convention (from elumatec postprocessor):
//   d1 = TDiamMount  — upper (wider) stage diameter
//   d2 = T2DiamMount — lower (narrower) stage diameter
//   lTotal = TLengthMount  — TOTAL holder length (Gesamtlänge L)
//   l2 = T2LengthMount — upper stage length (Länge 1 L1)
//   Lower stage length = lTotal - l2
//
// Stack from spindle nose (Z=0) downward:
//   Upper stage: Ø d1, length l2       (Z=0 to Z=-l2)
//   Lower stage: Ø d2, length lTotal-l2 (Z=-l2 to Z=-lTotal)
//
// Returns zCursor = Z position of the mount's bottom face
function buildMount(group, d1, d2, lTotal, l2, mat) {
  const r1 = d1 / 2;
  const r2 = (d2 || d1) / 2;
  const l1 = lTotal - l2;  // lower stage length

  if (l2 > 0 && d2 > 0) {
    // Two-stage mount: upper (wider) then lower (narrower)
    group.add(zCylinder(r1, r1, l2, 0, mat));
    if (l1 > 0.5) {
      group.add(zCylinder(r2, r2, l1, -l2, mat));
    }
  } else {
    // Single-stage mount
    group.add(zCylinder(r1, r1, lTotal, 0, mat));
  }

  return -lTotal;
}

// ---- Mill (end mill / face mill) ----
// zStart = Z position where tool body begins (below mount)
function buildMill(group, r, shankR, lCut, lTotal, zStart, mat) {
  const segs = 24;
  const shankLen = lTotal - lCut;

  // Shank portion (above cutting part, just below mount)
  if (shankLen > 0.5) {
    group.add(zCylinder(shankR, shankR, shankLen, zStart, mat, segs));
  }

  // Cutting portion (below shank)
  const cutTop = zStart - shankLen;
  group.add(zCylinder(r, r, lCut, cutTop, mat, segs));

  // Flat bottom face cap
  const endGeo = new THREE.CircleGeometry(r, segs);
  const endMesh = new THREE.Mesh(endGeo, mat);
  endMesh.position.set(0, 0, cutTop - lCut);
  endMesh.rotation.x = Math.PI; // face -Z (downward)
  group.add(endMesh);
}

// ---- Drill (twist drill with conical tip) ----
function buildDrill(group, r, shankR, lTotal, tipAngleDeg, zStart, mat) {
  const segs = 24;
  const tipAngle = tipAngleDeg * Math.PI / 180;
  const tipHeight = r / Math.tan(tipAngle / 2);

  // Shank portion (straight cylinder, above cutting part)
  const bodyLen = Math.max(0.5, lTotal - tipHeight);
  const shankLen = Math.max(0, bodyLen * 0.4);
  const cutLen = bodyLen - shankLen;

  if (shankLen > 0.5 && Math.abs(shankR - r) > 0.1) {
    group.add(zCylinder(shankR, shankR, shankLen, zStart, mat, segs));
    group.add(zCylinder(r, r, cutLen, zStart - shankLen, mat, segs));
  } else {
    group.add(zCylinder(r, r, bodyLen, zStart, mat, segs));
  }

  // Conical tip at the bottom
  const tipTop = zStart - bodyLen;
  const tipGeo = new THREE.ConeGeometry(r, tipHeight, segs);
  const tipMesh = new THREE.Mesh(tipGeo, mat);
  tipMesh.rotation.x = -Math.PI / 2;  // Point tip downward (-Z)
  tipMesh.position.set(0, 0, tipTop - tipHeight / 2);
  tipMesh.castShadow = true;
  group.add(tipMesh);
}

// ---- Saw / NDISK (disc cutter) ----
// Saw blade architecture on SBZ151:
//   Mount adapter → arbor (screw through disc center) → saw disc
//   The disc is perpendicular to spindle axis, centered on the arbor.
//   Disc center sits at the arbor tip.
function buildSaw(group, toolDef, zStart, matTool, matMount) {
  const r = toolDef.diameter / 2;
  const t = Math.max(toolDef.lengthCutting || 4, 2);  // disc thickness
  const lTotal = toolDef.lengthTotal || 50;
  const shankR = (toolDef.shankDiameter || 40) / 2;

  // Arbor / hub shaft from mount down through disc center
  const arborLen = lTotal;
  group.add(zCylinder(shankR, shankR, arborLen, zStart, matMount, 16));

  // Saw disc — centered at bottom of arbor
  // The disc plane is perpendicular to spindle axis (flat face faces +Z/-Z)
  const discCenter = zStart - arborLen + t / 2;
  group.add(zCylinder(r, r, t, discCenter + t / 2, matTool, 64));

  // Screw / flange that holds the disc (if data available)
  if (toolDef.screwDiameter > 0 && toolDef.screwLength > 0) {
    const sR = toolDef.screwDiameter / 2;
    const sL = toolDef.screwLength;
    // Screw cap on the outer face of the disc
    const screwZ = discCenter - t / 2;
    group.add(zCylinder(sR, sR, sL, screwZ, matMount, 16));
  }
}


// ============================================================================
// FIXTURE MESH (from EFD polygon data)
// ============================================================================

/**
 * Create fixture mesh from EFD polygon data.
 * Returns a THREE.Group with extruded shapes for the fixture cross-section.
 *
 * @param {Object} fixtureDef — from parseEfdFile: { polygons, dimensionL, dimensionR, ... }
 * @param {string} side — 'L' (left) or 'R' (right)
 * @param {THREE.Material} material
 * @returns {THREE.Group}
 */
export function createFixtureMesh(fixtureDef, side, material) {
  const group = new THREE.Group();
  group.name = 'fixture_' + fixtureDef.name;

  if (!fixtureDef || !fixtureDef.polygons || fixtureDef.polygons.length === 0) {
    return group;
  }

  const dim = side === 'R' ? fixtureDef.dimensionR : fixtureDef.dimensionL;
  // Depth for extrusion = dimension X (the fixture width along the bar direction)
  // Use explicit check to avoid 0 being falsy — 0 means no fixture on this side
  const depth = dim.x > 0 ? dim.x : 0;

  if (depth <= 0) return group;

  for (const poly of fixtureDef.polygons) {
    // flags[1] = 0 for left side, 1 for right side
    const polyIsRight = poly.flags[1] === 1;
    if (side === 'L' && polyIsRight) continue;
    if (side === 'R' && !polyIsRight) continue;

    if (poly.points.length < 3) continue;

    // Build THREE.Shape from polygon points
    // Fixture cross-section is in Y-Z plane (Y=depth into machine, Z=height)
    // Points in EFD are (x, y) where x=depth, y=height
    const shape = new THREE.Shape();
    const pts = poly.points;

    shape.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];

      if (prev.bulge && Math.abs(prev.bulge) > 0.001) {
        // Bulge factor: convert to arc
        // bulge = tan(angle/4), positive = CCW
        addBulgeArc(shape, prev.x, prev.y, curr.x, curr.y, prev.bulge);
      } else {
        shape.lineTo(curr.x, curr.y);
      }
    }

    // Extrude along X (bar direction)
    const extrudeSettings = {
      depth: depth,
      bevelEnabled: false
    };

    try {
      const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    } catch (e) {
      console.warn('Failed to create fixture mesh for', fixtureDef.name, e);
    }
  }

  return group;
}

/**
 * Add a bulge arc segment to a THREE.Shape.
 * Bulge = tan(included_angle / 4). Positive = CCW arc.
 */
function addBulgeArc(shape, x1, y1, x2, y2, bulge) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.001) {
    shape.lineTo(x2, y2);
    return;
  }

  const angle = 4 * Math.atan(Math.abs(bulge));
  const radius = dist / (2 * Math.sin(angle / 2));

  // Midpoint
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Perpendicular direction
  const px = -dy / dist;
  const py = dx / dist;

  // Distance from midpoint to center
  const h = radius * Math.cos(angle / 2);
  const sign = bulge > 0 ? 1 : -1;

  const cx = mx + sign * h * px;
  const cy = my + sign * h * py;

  // Start and end angles
  const startAngle = Math.atan2(y1 - cy, x1 - cx);
  const endAngle = Math.atan2(y2 - cy, x2 - cx);

  // Use absarc — clockwise if bulge < 0
  const clockwise = bulge < 0;

  shape.absarc(cx, cy, Math.abs(radius), startAngle, endAngle, clockwise);
}


// ============================================================================
// PROFILE MESH (from EPD polygon data)
// ============================================================================

/**
 * Create profile mesh from EPD cross-section polygon data.
 * Returns a THREE.Group with an extruded shape for the profile cross-section.
 *
 * BUILD COORDINATES (in ExtrudeGeometry local frame):
 *   Shape X = EPD_polygon_X   (profile width, always positive)
 *   Shape Y = EPD_polygon_Y   (profile height, always positive)
 *   Extrude Z = bar length    (extrusion depth)
 *
 * ROTATION (120° around (1,1,1), quaternion w=0.5, x=0.5, y=0.5, z=0.5):
 *   mesh local X → machine +Y
 *   mesh local Y → machine +Z
 *   mesh local Z → machine +X
 *
 * Since EPD width should go into -Y (into machine), we apply scale.x = -1
 * on the group to flip the Y direction. This also flips face normals, but
 * Three.js handles negative scale determinants by flipping triangle winding.
 *
 * Result in profileGroup local coords:
 *   X: 0 → +length (bar direction)
 *   Y: 0 → -width (into machine)
 *   Z: 0 → +height (upward)
 *
 * @param {Object} profileDef — from parseEpdFile: { width, height, polygons, ... }
 * @param {number} length — bar length in mm
 * @param {THREE.Material} material
 * @returns {{ group: THREE.Group, edges: THREE.LineSegments }}
 */
export function createProfileMesh(profileDef, length, material) {
  const group = new THREE.Group();
  group.name = 'profileCrossSection';

  if (!profileDef || !profileDef.polygons || profileDef.polygons.length === 0) {
    return { group, edges: null };
  }

  const validPolys = profileDef.polygons.filter(p => p.points.length >= 3);
  if (validPolys.length === 0) {
    return { group, edges: null };
  }

  // Aluminium profile cross-sections have multiple polygons.
  // A polygon is a HOLE if ALL its points lie inside another polygon.
  // Holes are subtracted from their parent and NOT extruded separately.
  // All other polygons (walls) are extruded as solid meshes, each with
  // their own holes subtracted.

  // For each polygon, find if it's entirely inside another polygon → hole
  // parentOf[i] = index of the smallest containing polygon, or -1 if none
  const parentOf = new Array(validPolys.length).fill(-1);

  // Sort by bounding-box area descending for efficient nesting detection
  const byArea = validPolys.map((p, i) => ({ idx: i, area: polyBoundingArea(p.points) }));
  byArea.sort((a, b) => b.area - a.area);

  for (let ai = 0; ai < byArea.length; ai++) {
    const i = byArea[ai].idx;
    const pts = validPolys[i].points;

    // Compute centroid of polygon i
    let cx = 0, cy = 0;
    for (const pt of pts) { cx += pt.x; cy += pt.y; }
    cx /= pts.length;
    cy /= pts.length;

    // Compute bounding box of polygon i
    let iMinX = Infinity, iMaxX = -Infinity, iMinY = Infinity, iMaxY = -Infinity;
    for (const pt of pts) {
      if (pt.x < iMinX) iMinX = pt.x;
      if (pt.x > iMaxX) iMaxX = pt.x;
      if (pt.y < iMinY) iMinY = pt.y;
      if (pt.y > iMaxY) iMaxY = pt.y;
    }

    // Test against all OTHER polygons with larger area
    for (let aj = 0; aj < ai; aj++) {
      const j = byArea[aj].idx;
      const jPts = validPolys[j].points;

      // Check if ALL points of polygon i are inside OR on the edge of polygon j.
      // Shared edges between parent and hole polygons mean some vertices lie
      // exactly on the parent's boundary — ray-casting returns false for those.
      // We use three checks per point:
      //   1. Ray-casting (fast, handles interior points)
      //   2. Nudge toward centroid (handles near-edge points)
      //   3. Point-on-edge test (handles exact boundary points)
      const EDGE_TOL = 0.5; // mm tolerance for on-edge test
      const NUDGE = 0.2;    // mm nudge toward centroid
      let allInside = true;
      for (const pt of pts) {
        // Fast: standard ray-cast
        if (_pointInPolygon(pt.x, pt.y, jPts)) continue;
        // Nudge toward centroid and re-test
        const dx = cx - pt.x;
        const dy = cy - pt.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.001) {
          const nx = pt.x + (dx / dist) * NUDGE;
          const ny = pt.y + (dy / dist) * NUDGE;
          if (_pointInPolygon(nx, ny, jPts)) continue;
        }
        // Check if point lies on an edge of polygon j
        if (_pointOnPolygonEdge(pt.x, pt.y, jPts, EDGE_TOL)) continue;
        // Point is truly outside
        allInside = false;
        break;
      }

      if (allInside) {
        parentOf[i] = j;
      }
    }
  }

  // isHole = has a parent
  const isHole = parentOf.map(p => p >= 0);

  // Debug
  for (let i = 0; i < validPolys.length; i++) {
    const role = isHole[i] ? `HOLE(in ${parentOf[i]})` : 'WALL';
    const p = validPolys[i].points;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    let cx2=0,cy2=0;
    for (const pt of p){if(pt.x<minX)minX=pt.x;if(pt.x>maxX)maxX=pt.x;if(pt.y<minY)minY=pt.y;if(pt.y>maxY)maxY=pt.y;cx2+=pt.x;cy2+=pt.y;}
    cx2/=p.length; cy2/=p.length;
    console.log(`Profile poly ${i}: ${role} pts=${p.length} bbox=[${minX.toFixed(1)},${minY.toFixed(1)} → ${maxX.toFixed(1)},${maxY.toFixed(1)}] centroid=(${cx2.toFixed(1)},${cy2.toFixed(1)}) bboxArea=${polyBoundingArea(p).toFixed(0)} signedArea=${_signedPolygonArea(p).toFixed(1)}`);
  }

  const doubleMat = material.clone();
  doubleMat.side = THREE.DoubleSide;
  const extrudeSettings = { depth: length, bevelEnabled: false };

  // Extrude each non-hole polygon as a solid mesh, with its holes subtracted
  for (let pi = 0; pi < validPolys.length; pi++) {
    if (isHole[pi]) continue;  // holes are only subtracted, not extruded

    const shape = new THREE.Shape();
    buildShapeFromPoly(shape, validPolys[pi].points);

    // Subtract any polygons that are holes inside THIS polygon
    for (let hi = 0; hi < validPolys.length; hi++) {
      if (parentOf[hi] === pi) {
        const h = new THREE.Path();
        buildPathFromPoly(h, validPolys[hi].points);
        shape.holes.push(h);
      }
    }

    try {
      const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      const mesh = new THREE.Mesh(geo, doubleMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.quaternion.set(0.5, 0.5, 0.5, 0.5);
      mesh.scale.x = -1;
      group.add(mesh);

      const edgeGeo = new THREE.EdgesGeometry(geo, 15);
      const edgeLineMat = new THREE.LineBasicMaterial({
        color: 0x888888, transparent: true, opacity: 0.4
      });
      const edges = new THREE.LineSegments(edgeGeo, edgeLineMat);
      edges.quaternion.set(0.5, 0.5, 0.5, 0.5);
      edges.scale.x = -1;
      group.add(edges);
    } catch (e) {
      console.warn('Failed to extrude profile polygon', pi, profileDef.name, e);
    }
  }

  return { group, edges: null };
}

/**
 * Compute bounding box area for a polygon — used to identify the outer contour.
 */
function polyBoundingArea(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return (maxX - minX) * (maxY - minY);
}

/**
 * Compute the signed area of a polygon (Shoelace formula).
 * Positive = CCW, Negative = CW.
 */
function _signedPolygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

/**
 * Check if point (px,py) is ON any edge of the polygon (within tolerance).
 */
function _pointOnPolygonEdge(px, py, points, tol) {
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = points[j].x, y1 = points[j].y;
    const x2 = points[i].x, y2 = points[i].y;
    // Check if point is within segment bounding box (with tolerance)
    const minX = Math.min(x1, x2) - tol, maxX = Math.max(x1, x2) + tol;
    const minY = Math.min(y1, y2) - tol, maxY = Math.max(y1, y2) + tol;
    if (px < minX || px > maxX || py < minY || py > maxY) continue;
    // Distance from point to line segment
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) {
      // Degenerate segment (point), check distance to point
      const d = Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
      if (d <= tol) return true;
      continue;
    }
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    const projX = x1 + t * dx, projY = y1 + t * dy;
    const dist = Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
    if (dist <= tol) return true;
  }
  return false;
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if (px,py) is inside the polygon defined by points[].
 */
function _pointInPolygon(px, py, points) {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Build a THREE.Shape (outer contour) from EPD polygon points.
 * Uses EPD coordinates directly — no negation to preserve CCW winding.
 */
function buildShapeFromPoly(shape, points) {
  shape.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    if (prev.bulge && Math.abs(prev.bulge) > 0.001) {
      addBulgeArc(shape, prev.x, prev.y, curr.x, curr.y, prev.bulge);
    } else {
      shape.lineTo(curr.x, curr.y);
    }
  }
}

/**
 * Build a THREE.Path (hole) from EPD polygon points.
 * Same coordinate mapping as outer contour.
 */
function buildPathFromPoly(path, points) {
  path.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    if (prev.bulge && Math.abs(prev.bulge) > 0.001) {
      addBulgeArc(path, prev.x, prev.y, curr.x, curr.y, prev.bulge);
    } else {
      path.lineTo(curr.x, curr.y);
    }
  }
}
