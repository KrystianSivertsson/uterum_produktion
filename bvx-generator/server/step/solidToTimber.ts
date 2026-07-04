import type { Drilling, Lap, Operation, Part, SawCut } from "../../shared/schema.ts";
import { isRef, parseStep, type StepFile, type StepInstance, type StepValue } from "./parser.ts";
import { canonical, cross, dot, normalize, roundTo, scale, sub, type Vec3 } from "./geometry.ts";

/**
 * Konverterar 3D-solider ur en STEP-fil till timber-delar med kap och
 * borrningar (motsvarigheten till hsbCAD:s "solid till balk").
 *
 * Metod per solid:
 *  1. Lokalt koordinatsystem ur de dominerande planytenormalerna.
 *  2. Längd/höjd/bredd ur hörnpunkternas utbredning (längd = störst,
 *     höjd = minsta tvärmåttet).
 *  3. Ändytor → SawCut (vinklade ytor ger Angle/Bevel ≠ 90).
 *  4. Cylinderytor vinkelräta mot balkaxeln → Drilling.
 *
 * Det som inte känns igen (urtag, snedborrningar, friformsytor)
 * rapporteras som varningar i stället för att gissas.
 */

interface PlaneFace {
  kind: "plane";
  origin: Vec3;
  normal: Vec3; // utåtriktad (justerad med same_sense)
  vertices: Vec3[];
}

interface CylinderFace {
  kind: "cylinder";
  origin: Vec3;
  axis: Vec3;
  radius: number;
  vertices: Vec3[];
}

interface OtherFace {
  kind: "other";
  surfaceType: string;
  vertices: Vec3[];
}

type Face = PlaneFace | CylinderFace | OtherFace;

export interface StepImportResult {
  parts: Part[];
  warnings: string[];
}

const PARALLEL_TOL = 0.999;
const SIDE_FACE_TOL = 0.05;
/** Ändkap måste vara ändlika: minst 45° mot balkaxeln (|n·L̂| ≥ cos 45°) */
const END_FACE_TOL = Math.SQRT1_2;
/** Urtagsbottnar får luta upp till 15° mot balksidan (birdsmouth i platta delar) */
const LAP_FLOOR_MAX_TILT_DEG = 15;

/**
 * Sidnumrering (Hundegger/BTL-referenssida) per lokal axel och riktning.
 * Antagen konvention — verifiera mot maskinuppställningen och justera
 * här om sidorna hamnar spegelvänt.
 */
const SIDE_HEIGHT_MIN = 3;
const SIDE_HEIGHT_MAX = 1;
const SIDE_WIDTH_MIN = 2;
const SIDE_WIDTH_MAX = 4;

function asList(value: StepValue): StepValue[] {
  if (!Array.isArray(value)) throw new Error(`Väntade lista, fick ${JSON.stringify(value)}`);
  return value;
}

function readPoint(file: StepFile, ref: StepValue, unitScale: number): Vec3 {
  const instance = file.deref(ref);
  const coords = asList(instance.args[1]).map((component) => Number(component) * unitScale);
  return [coords[0], coords[1], coords[2] ?? 0];
}

function readDirection(file: StepFile, ref: StepValue): Vec3 {
  const instance = file.deref(ref);
  const coords = asList(instance.args[1]).map(Number);
  return normalize([coords[0], coords[1], coords[2] ?? 0]);
}

function readPlacement(file: StepFile, ref: StepValue, unitScale: number): { origin: Vec3; z: Vec3 } {
  const instance = file.deref(ref);
  const origin = readPoint(file, instance.args[1], unitScale);
  const z = instance.args[2] != null ? readDirection(file, instance.args[2]) : ([0, 0, 1] as Vec3);
  return { origin, z };
}

function collectFaceVertices(file: StepFile, boundRefs: StepValue[], unitScale: number): Vec3[] {
  const seen = new Set<string>();
  const vertices: Vec3[] = [];
  for (const boundRef of boundRefs) {
    if (!isRef(boundRef)) continue;
    const bound = file.deref(boundRef);
    if (bound.type !== "FACE_OUTER_BOUND" && bound.type !== "FACE_BOUND") continue;
    if (!isRef(bound.args[1])) continue;
    const loop = file.deref(bound.args[1]);
    if (loop.type !== "EDGE_LOOP") continue; // degenererade filer utan topologi
    for (const orientedEdgeRef of asList(loop.args[1])) {
      if (!isRef(orientedEdgeRef)) continue;
      const orientedEdge = file.deref(orientedEdgeRef);
      const edgeCurveRef = orientedEdge.type === "ORIENTED_EDGE" ? orientedEdge.args[3] : orientedEdgeRef;
      if (!isRef(edgeCurveRef)) continue;
      const edgeCurve = file.deref(edgeCurveRef);
      if (edgeCurve.type !== "EDGE_CURVE") continue;
      for (const vertexRef of [edgeCurve.args[1], edgeCurve.args[2]]) {
        if (!isRef(vertexRef)) continue;
        const vertexPoint = file.deref(vertexRef);
        if (vertexPoint.type !== "VERTEX_POINT") continue;
        const point = readPoint(file, vertexPoint.args[1], unitScale);
        const key = point.map((component) => component.toFixed(6)).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          vertices.push(point);
        }
      }
    }
  }
  return vertices;
}

function readFace(file: StepFile, faceRef: StepValue, unitScale: number): Face | null {
  const face = file.deref(faceRef);
  if (face.type !== "ADVANCED_FACE" && face.type !== "FACE_SURFACE") return null;
  const bounds = asList(face.args[1]);
  const vertices = collectFaceVertices(file, bounds, unitScale);
  const surface = file.deref(face.args[2]);
  const sameSense = face.args[3] !== false;

  if (surface.type === "PLANE") {
    const { origin, z } = readPlacement(file, surface.args[1], unitScale);
    return { kind: "plane", origin, normal: sameSense ? z : scale(z, -1), vertices };
  }
  if (surface.type === "CYLINDRICAL_SURFACE") {
    const { origin, z } = readPlacement(file, surface.args[1], unitScale);
    return { kind: "cylinder", origin, axis: z, radius: Number(surface.args[2]) * unitScale, vertices };
  }
  return { kind: "other", surfaceType: surface.type, vertices };
}

/**
 * Ungefärlig ytarea: hörnpunkternas utbredning i två ortogonala
 * riktningar i planet. Exakt för rektanglar, tillräcklig som vikt.
 */
function faceWeight(face: PlaneFace): number {
  if (face.vertices.length < 2) return 1;
  const arbitrary: Vec3 = Math.abs(face.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(face.normal, arbitrary));
  const v = cross(face.normal, u);
  const uValues = face.vertices.map((vertex) => dot(vertex, u));
  const vValues = face.vertices.map((vertex) => dot(vertex, v));
  const area =
    (Math.max(...uValues) - Math.min(...uValues)) * (Math.max(...vValues) - Math.min(...vValues));
  return Math.max(area, 1);
}

/**
 * Dominant ortogonal treaxel ur planytenormalerna, viktad efter ytarea.
 * Area (inte antal ytor) avgör så att en lutande balks stora ovan- och
 * undersidor vinner över många små urtags- och kapytor som följer
 * byggnadens axlar — annars blir måtten bounding box i fel riktning.
 */
function detectFrameAxes(faces: Face[]): [Vec3, Vec3, Vec3] {
  const clusters: { direction: Vec3; weight: number }[] = [];
  for (const face of faces) {
    if (face.kind !== "plane") continue;
    const direction = canonical(face.normal);
    const weight = faceWeight(face);
    const existing = clusters.find((cluster) => dot(cluster.direction, direction) > PARALLEL_TOL);
    if (existing) existing.weight += weight;
    else clusters.push({ direction, weight });
  }
  clusters.sort((a, b) => b.weight - a.weight);

  const a1 = clusters[0]?.direction ?? ([1, 0, 0] as Vec3);
  const a2candidate = clusters.find((cluster) => Math.abs(dot(cluster.direction, a1)) < 0.001)?.direction;
  const a2 = a2candidate ?? (Math.abs(a1[0]) < 0.9 ? normalize(cross(a1, [1, 0, 0])) : normalize(cross(a1, [0, 1, 0])));
  const a3 = normalize(cross(a1, a2));
  return [a1, a2, a3];
}

interface Frame {
  length: Vec3;
  height: Vec3;
  width: Vec3;
  min: Vec3; // minsta koordinat per axel (length, height, width)
  dims: { length: number; height: number; width: number };
}

function buildFrame(faces: Face[]): Frame {
  const axes = detectFrameAxes(faces);

  let points = faces.flatMap((face) => face.vertices);
  if (points.length === 0) {
    // Degenererad fil utan topologi: använd ytornas placeringspunkter
    points = faces.filter((face): face is PlaneFace => face.kind === "plane").map((face) => face.origin);
  }
  if (points.length === 0) throw new Error("Soliden saknar både hörnpunkter och plana ytor");

  const extents = axes.map((axis) => {
    const values = points.map((point) => dot(point, axis));
    return { min: Math.min(...values), max: Math.max(...values) };
  });
  const sizes = extents.map((extent) => extent.max - extent.min);

  const order = [0, 1, 2].sort((a, b) => sizes[b] - sizes[a]);
  const lengthIndex = order[0];
  // Höjd = minsta tvärmåttet, bredd = största (samma konvention som hsbCAD:s export)
  const heightIndex = sizes[order[1]] <= sizes[order[2]] ? order[1] : order[2];
  const widthIndex = heightIndex === order[1] ? order[2] : order[1];

  return {
    length: axes[lengthIndex],
    height: axes[heightIndex],
    width: axes[widthIndex],
    min: [extents[lengthIndex].min, extents[heightIndex].min, extents[widthIndex].min],
    dims: {
      length: sizes[lengthIndex],
      height: sizes[heightIndex],
      width: sizes[widthIndex],
    },
  };
}

function toLocal(frame: Frame, point: Vec3): Vec3 {
  return [
    dot(point, frame.length) - frame.min[0],
    dot(point, frame.height) - frame.min[1],
    dot(point, frame.width) - frame.min[2],
  ];
}

/**
 * Rektangulära urtag: en planyta parallell med en balksida men belägen
 * inne i balken tolkas som urtagsbotten. Fullbreddsurtag blir Lap;
 * delbreddsfickor rapporteras som varning (BVX Lap saknar breddmått).
 */
function detectLaps(
  frame: Frame,
  faces: Face[],
  warnings: string[],
  partName: string,
): { ops: Lap[]; spans: [number, number][] } {
  const INSIDE_TOL = 0.5;
  const ops: Lap[] = [];
  const spans: [number, number][] = [];

  const sides = [
    { axisIndex: 1 as const, axis: frame.height, dim: frame.dims.height, crossIndex: 2 as const, crossDim: frame.dims.width, minSide: SIDE_HEIGHT_MIN, maxSide: SIDE_HEIGHT_MAX },
    { axisIndex: 2 as const, axis: frame.width, dim: frame.dims.width, crossIndex: 1 as const, crossDim: frame.dims.height, minSide: SIDE_WIDTH_MIN, maxSide: SIDE_WIDTH_MAX },
  ];

  const maxTiltCos = Math.cos((LAP_FLOOR_MAX_TILT_DEG * Math.PI) / 180);

  for (const face of faces) {
    if (face.kind !== "plane" || face.vertices.length < 2) continue;
    for (const side of sides) {
      const alignment = dot(face.normal, side.axis);
      // Botten får luta något (birdsmouth i platta delar) men inte mer
      if (Math.abs(alignment) < maxTiltCos) continue;

      const locals = face.vertices.map((vertex) => toLocal(frame, vertex));
      const levels = locals.map((local) => local[side.axisIndex]);
      // Hela botten måste ligga inne i balken — annars är det en yttersida
      if (Math.min(...levels) < INSIDE_TOL || Math.max(...levels) > side.dim - INSIDE_TOL) continue;

      const lengthValues = locals.map((local) => local[0]);
      const crossValues = locals.map((local) => local[side.crossIndex]);
      const spanStart = Math.min(...lengthValues);
      const spanEnd = Math.max(...lengthValues);
      if (spanEnd - spanStart < 1) continue;

      const crossSpan = Math.max(...crossValues) - Math.min(...crossValues);
      if (crossSpan < side.crossDim - 1) {
        warnings.push(
          `${partName}: ficka/delbreddsurtag vid ${roundTo(spanStart, 1)}–${roundTo(spanEnd, 1)} mm konverterades inte (endast fullbreddsurtag stöds)`,
        );
        break;
      }

      // Djupet mäts vid urtagets startkant (referenspunkten i BTL)
      const startIndex = lengthValues.indexOf(spanStart);
      const levelAtStart = levels[startIndex];

      // Öppningssidan avgörs av var balkens YTTERSIDA saknas över
      // urtagets spann: finns kantytan kvar är urtaget inte öppet åt
      // det hållet. (Ytnormaler och väggar är opålitliga — ändytor och
      // materialgränser förväxlas lätt med urtagsväggar.)
      const coverage = (atMax: boolean): number => {
        const targetLevel = atMax ? side.dim : 0;
        let covered = 0;
        for (const outer of faces) {
          if (outer === face || outer.kind !== "plane" || outer.vertices.length < 2) continue;
          if (Math.abs(dot(outer.normal, side.axis)) < maxTiltCos) continue;
          const outerLocals = outer.vertices.map((vertex) => toLocal(frame, vertex));
          if (!outerLocals.every((local) => Math.abs(local[side.axisIndex] - targetLevel) <= 1.5)) continue;
          const outerLengths = outerLocals.map((local) => local[0]);
          const overlap =
            Math.min(spanEnd, Math.max(...outerLengths)) - Math.max(spanStart, Math.min(...outerLengths));
          if (overlap > 0) covered += overlap;
        }
        return covered;
      };
      const coverMin = coverage(false);
      const coverMax = coverage(true);
      const spanLength = spanEnd - spanStart;
      // Tydlig skillnad i täckning → öppnar åt den sida som saknar
      // yttersida; annars faller vi tillbaka på bottnens normalriktning
      const openTowardMax =
        Math.abs(coverMin - coverMax) > spanLength * 0.2 ? coverMin > coverMax : alignment > 0;

      const depth = roundTo(openTowardMax ? side.dim - levelAtStart : levelAtStart, 3);

      // Bottens lutning längs balken → BTL P07 (90 = plan botten).
      // Teckenkonvention följer hsbCAD:s export: >90 när urtaget öppnar
      // bort från referenssidan (ClosedBirdsmouth), <90 mot den.
      const endIndex = lengthValues.indexOf(spanEnd);
      const tiltDeg = (Math.atan2(levels[endIndex] - levelAtStart, spanEnd - spanStart) * 180) / Math.PI;
      const inclination = roundTo(openTowardMax ? 90 + tiltDeg : 90 - tiltDeg, 2);

      ops.push({
        type: "Lap",
        referenceSide: openTowardMax ? side.maxSide : side.minSide,
        lengthMeas: roundTo((spanStart + spanEnd) / 2, 3),
        crossMeas1: depth,
        crossMeas2: roundTo(side.crossDim / 2, 3),
        angle: 90,
        bevel: 0,
        rotation: 0,
        length: roundTo(spanEnd - spanStart, 3),
        lengthOrientation: "Center",
        depth,
        inclination,
      });
      spans.push([spanStart, spanEnd]);
      break;
    }
  }
  return { ops, spans };
}

function endCuts(
  frame: Frame,
  faces: Face[],
  warnings: string[],
  partName: string,
  lapSpans: [number, number][] = [],
): SawCut[] {
  interface Candidate {
    t: number;
    axisComp: number;
    heightComp: number;
    widthComp: number;
  }
  const candidates: Candidate[] = [];

  // Snittets läge mäts där snittplanet korsar balkens centrumlinje
  const center: Vec3 = [0, frame.dims.height / 2, frame.dims.width / 2];

  // Flacka ytor (mellan långsida och ändkap) som inte hör till ett
  // igenkänt urtag är oftast klyvningar eller långa snedkap — varna.
  let unconvertedSlanted = 0;
  for (const face of faces) {
    if (face.kind !== "plane") continue;
    const axisComp = dot(face.normal, frame.length);
    if (Math.abs(axisComp) >= SIDE_FACE_TOL && Math.abs(axisComp) < END_FACE_TOL) {
      const lengthValues = face.vertices.map((vertex) => toLocal(frame, vertex)[0]);
      const inLapSpan =
        lengthValues.length > 0 &&
        lapSpans.some(
          ([spanStart, spanEnd]) =>
            Math.min(...lengthValues) >= spanStart - 1 && Math.max(...lengthValues) <= spanEnd + 1,
        );
      if (!inLapSpan) unconvertedSlanted++;
    }
  }
  if (unconvertedSlanted > 0) {
    warnings.push(
      `${partName}: ${unconvertedSlanted} flacka ytor konverterades inte (klyvning eller långt snedkap?) — komplettera för hand`,
    );
  }

  for (const face of faces) {
    if (face.kind !== "plane") continue;
    const axisComp = dot(face.normal, frame.length);
    // Ändkap måste vara ändlika — flackare ytor är urtagsbottnar eller
    // längsgående ytor och ska inte bli kap
    if (Math.abs(axisComp) < END_FACE_TOL) continue;

    const originLocal = toLocal(frame, face.origin);
    const normalLocal: Vec3 = [axisComp, dot(face.normal, frame.height), dot(face.normal, frame.width)];
    // Snittplanets skärning med centrumlinjen center + t·L̂
    candidates.push({
      t: dot(sub(originLocal, center), normalLocal) / normalLocal[0],
      axisComp,
      heightComp: normalLocal[1],
      widthComp: normalLocal[2],
    });
  }

  // Väggar i redan igenkända urtag ska inte räknas som ändytor.
  // Ytor vid själva balkänden (±1 mm) behålls alltid — de är riktiga ändkap.
  const relevant = candidates.filter((candidate) => {
    const atBeamEnd = Math.abs(candidate.t) <= 1 || Math.abs(candidate.t - frame.dims.length) <= 1;
    if (atBeamEnd) return true;
    return !lapSpans.some(([spanStart, spanEnd]) => candidate.t >= spanStart - 1 && candidate.t <= spanEnd + 1);
  });

  // Klassa efter läge, inte normalriktning — vissa filer har inåtriktade normaler
  const mid = frame.dims.length / 2;
  const startCandidates = relevant.filter((candidate) => candidate.t <= mid);
  const endCandidates = relevant.filter((candidate) => candidate.t > mid);

  function pickCut(candidates: Candidate[], pickMin: boolean, fallbackT: number, label: string): SawCut {
    if (candidates.length === 0) {
      warnings.push(`${partName}: ingen ändyta hittades vid ${label} — vinkelrätt kap antaget`);
    } else if (candidates.length > 1) {
      warnings.push(
        `${partName}: ${candidates.length} ytor pekar mot ${label} — övriga kan vara urtag som inte konverterats`,
      );
    }
    // Kapet närmast änden är det riktiga ändkapet — övriga är urtagsväggar
    const endPosition = pickMin ? 0 : frame.dims.length;
    const chosen =
      candidates.length === 0
        ? undefined
        : candidates.reduce((best, candidate) =>
            Math.abs(candidate.t - endPosition) < Math.abs(best.t - endPosition) ? candidate : best,
          );

    const angle = chosen ? roundTo((Math.atan2(Math.abs(chosen.axisComp), Math.abs(chosen.widthComp)) * 180) / Math.PI, 2) : 90;
    const bevel = chosen ? roundTo((Math.atan2(Math.abs(chosen.axisComp), Math.abs(chosen.heightComp)) * 180) / Math.PI, 2) : 90;
    return {
      type: "SawCut",
      referenceSide: 3,
      lengthMeas: roundTo(chosen?.t ?? fallbackT, 3),
      crossMeas1: roundTo(frame.dims.height / 2, 3),
      crossMeas2: roundTo(frame.dims.width / 2, 3),
      orientation: pickMin ? "Right" : "Left",
      angle,
      bevel,
    };
  }

  return [
    pickCut(startCandidates, true, 0, "starten"),
    pickCut(endCandidates, false, frame.dims.length, "slutet"),
  ];
}

function drillings(frame: Frame, faces: Face[], warnings: string[], partName: string): Drilling[] {
  // Slå ihop cylinderytor som beskriver samma hål (t.ex. två halvcylindrar)
  interface HoleGroup {
    key: string;
    axis: Vec3;
    anchor: Vec3;
    radius: number;
    vertices: Vec3[];
  }
  const groups = new Map<string, HoleGroup>();

  for (const face of faces) {
    if (face.kind !== "cylinder") continue;
    const axis = canonical(face.axis);
    const anchor = sub(face.origin, scale(axis, dot(face.origin, axis)));
    const key = [
      face.radius.toFixed(3),
      ...axis.map((component) => component.toFixed(4)),
      ...anchor.map((component) => component.toFixed(2)),
    ].join("|");
    const group = groups.get(key);
    if (group) group.vertices.push(...face.vertices);
    else groups.set(key, { key, axis, anchor: face.origin, radius: face.radius, vertices: [...face.vertices] });
  }

  const result: Drilling[] = [];
  for (const group of groups.values()) {
    const alongHeight = Math.abs(dot(group.axis, frame.height)) > PARALLEL_TOL;
    const alongWidth = Math.abs(dot(group.axis, frame.width)) > PARALLEL_TOL;
    if (!alongHeight && !alongWidth) {
      warnings.push(
        `${partName}: cylinder Ø${roundTo(group.radius * 2, 1)} är inte vinkelrät mot balkaxeln — hoppas över`,
      );
      continue;
    }

    const anchorLocal = toLocal(frame, group.anchor);
    const thickness = alongHeight ? frame.dims.height : frame.dims.width;
    let holeDepth = 0;
    if (group.vertices.length > 0) {
      const depthValues = group.vertices.map((vertex) => toLocal(frame, vertex)[alongHeight ? 1 : 2]);
      const span = Math.max(...depthValues) - Math.min(...depthValues);
      holeDepth = span >= thickness - 0.01 ? 0 : roundTo(span, 3);
    }

    result.push({
      type: "Drilling",
      // Sida 3 = borrning i höjdled, sida 2 = i breddled. Verifiera mot
      // maskinuppställningen innan skarp körning.
      referenceSide: alongHeight ? 3 : 2,
      lengthMeas: roundTo(anchorLocal[0], 3),
      crossMeas1: roundTo(alongHeight ? anchorLocal[2] : anchorLocal[1], 3),
      crossMeas2: 0,
      bevel: 0,
      angle: 0,
      drillDiam: roundTo(group.radius * 2, 3),
      holeDepth,
      countersinkDiam: 0,
      countersinkDepth: 0,
      splinterFree: "sfNone",
    });
  }
  return result.sort((a, b) => a.lengthMeas - b.lengthMeas);
}

function productNameForRepresentation(file: StepFile, representationId: number): string | undefined {
  for (const sdr of file.byType("SHAPE_DEFINITION_REPRESENTATION")) {
    if (!isRef(sdr.args[1]) || sdr.args[1].ref !== representationId) continue;
    try {
      const propertyDefinition = file.deref(sdr.args[0]);
      const productDefinition = file.deref(propertyDefinition.args[2]);
      const formation = file.deref(productDefinition.args[2]);
      const product = file.deref(formation.args[2]);
      const name = product.args[0] || product.args[1];
      if (typeof name === "string" && name.trim() !== "") return name.trim();
    } catch {
      // ofullständig produktkedja — prova nästa
    }
  }
  return undefined;
}

function solidName(file: StepFile, solid: StepInstance, index: number): string {
  // Solid → representation(er) → produkt. I assemblies kopplas solidens
  // representation till produktens via SHAPE_REPRESENTATION_RELATIONSHIP;
  // sökningen görs nivåvis så att närmaste (mest specifika) produkt vinner.
  let level = new Set<number>();
  for (const repType of ["ADVANCED_BREP_SHAPE_REPRESENTATION", "SHAPE_REPRESENTATION"]) {
    for (const representation of file.byType(repType)) {
      const items = Array.isArray(representation.args[1]) ? representation.args[1] : [];
      if (items.some((item) => isRef(item) && item.ref === solid.id)) level.add(representation.id);
    }
  }

  const visited = new Set<number>();
  for (let hops = 0; hops < 5 && level.size > 0; hops++) {
    for (const representationId of level) {
      const name = productNameForRepresentation(file, representationId);
      if (name) return name;
    }
    for (const id of level) visited.add(id);

    const next = new Set<number>();
    for (const relationship of file.byType("SHAPE_REPRESENTATION_RELATIONSHIP")) {
      for (const record of relationship.records) {
        const a = record.args[2];
        const b = record.args[3];
        if (!isRef(a) || !isRef(b)) continue;
        if (level.has(a.ref) && !visited.has(b.ref)) next.add(b.ref);
        if (level.has(b.ref) && !visited.has(a.ref)) next.add(a.ref);
      }
    }
    level = next;
  }

  const products = file.byType("PRODUCT");
  if (products.length === 1 && typeof products[0].args[0] === "string" && products[0].args[0].trim() !== "") {
    return (products[0].args[0] as string).trim();
  }
  return `Del ${index + 1}`;
}

function convertSolid(file: StepFile, solid: StepInstance, index: number, unitScale: number): { part: Part; warnings: string[] } {
  const warnings: string[] = [];
  const name = solidName(file, solid, index);

  const shell = file.deref(solid.args[1]);
  const faces: Face[] = [];
  for (const faceRef of asList(shell.args[1])) {
    const face = readFace(file, faceRef, unitScale);
    if (face) faces.push(face);
  }

  const otherSurfaces = faces.filter((face): face is OtherFace => face.kind === "other");
  if (otherSurfaces.length > 0) {
    const types = [...new Set(otherSurfaces.map((face) => face.surfaceType))].join(", ");
    warnings.push(`${name}: ${otherSurfaces.length} ytor med ohanterad yttyp (${types}) ignorerades`);
  }

  const frame = buildFrame(faces);
  const laps = detectLaps(frame, faces, warnings, name);
  const operations: Operation[] = [
    ...endCuts(frame, faces, warnings, name, laps.spans),
    ...laps.ops,
    ...drillings(frame, faces, warnings, name),
  ];

  const part: Part = {
    name,
    quantity: 1,
    unit: "",
    grade: "",
    profile: "",
    comments: "Importerad från STEP",
    dimension: `${roundTo(frame.dims.height, 1)}x${roundTo(frame.dims.width, 1)}`,
    length: roundTo(frame.dims.length, 3),
    height: roundTo(frame.dims.height, 3),
    width: roundTo(frame.dims.width, 3),
    operations,
  };
  return { part, warnings };
}

export function stepToParts(text: string): StepImportResult {
  const file = parseStep(text);
  const unitScale = file.lengthScale();

  const solids = [...file.byType("MANIFOLD_SOLID_BREP"), ...file.byType("BREP_WITH_VOIDS")];
  if (solids.length === 0) throw new Error("Inga solider (MANIFOLD_SOLID_BREP) hittades i STEP-filen");

  const parts: Part[] = [];
  const warnings: string[] = [];
  solids.forEach((solid, index) => {
    const converted = convertSolid(file, solid, index, unitScale);
    parts.push(converted.part);
    warnings.push(...converted.warnings);
  });
  return { parts, warnings };
}
