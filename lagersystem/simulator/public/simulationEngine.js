// ============================================================================
// simulationEngine.js — CNC simulation engine for elumatec SBZ151
// Transforms parsed .auf instructions into an animated timeline
// ============================================================================

const Z_MAX = 494; // Machine Z-MAX safe height (mm)
const RAPID_SPEED = 10000; // mm/min visual rapid speed
const RAPID_ROT_SPEED = 360; // deg/sec visual rotation speed
const STATE_CHANGE_DURATION = 0.15; // seconds for instant state changes
const CLAMP_MOVE_DURATION = 1.0; // seconds for clamp animation

class MachineState {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = Z_MAX;
    this.a = 0;
    this.c = 0;
    this.clamps = [400, 1300, 2200, 3100, 4000, 4900, 5800, 6700];
    this.activeClamps = 8;
    this.tool = 0;
    this.toolDiameter = 0;
    this.spindleRpm = 0;
    this.spindleOn = false;
    this.coordMode = 'G54';
    this.absMode = true;
    this.originX = 0;
    this.originY = 0;
    this.originZ = 0;
    this.rtcpActive = false;
    this.rtcp = { eu: 0, ev: 0, ew: 0, ea: 0, eb: 0, ec: 0 };
    // Local-plane position tracking (the X/Y/Z values in the rotated coord system)
    this.localX = 0;
    this.localY = 0;
    this.localZ = 0;
    this.lastFeed = 1000;
    this.profileLength = 3000;
  }

  get pos() { return { x: this.x, y: this.y, z: this.z, a: this.a, c: this.c }; }
}

/**
 * Rotate a local-plane vector (lx,ly,lz) by RTCP angles EA (A-axis) and EC (C-axis).
 * SBZ151 rotation order: A rotates around machine X first, then C rotates around machine Z.
 * Returns machine-relative delta {dx, dy, dz}.
 */
function rtcpRotate(lx, ly, lz, eaDeg, ecDeg) {
  const a = eaDeg * Math.PI / 180;
  const c = ecDeg * Math.PI / 180;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const cosC = Math.cos(c), sinC = Math.sin(c);
  // Apply A rotation (around X) first, then C rotation (around Z)
  // Ra = [[1, 0, 0], [0, cosA, -sinA], [0, sinA, cosA]]
  // Rc = [[cosC, -sinC, 0], [sinC, cosC, 0], [0, 0, 1]]
  // Combined R = Rc * Ra
  const dx =  cosC * lx - sinC * cosA * ly + sinC * sinA * lz;
  const dy =  sinC * lx + cosC * cosA * ly - cosC * sinA * lz;
  const dz =                      sinA * ly +         cosA * lz;
  return { dx, dy, dz };
}

function resolvePosition(instr, state) {
  const pos = { x: state.x, y: state.y, z: state.z, a: state.a, c: state.c };

  // Check if RTCP has meaningful (non-zero) pivot or angles
  const rtcpHasTransform = state.rtcpActive &&
    (state.rtcp.eu !== 0 || state.rtcp.ev !== 0 || state.rtcp.ew !== 0 ||
     state.rtcp.ea !== 0 || state.rtcp.ec !== 0);

  if (rtcpHasTransform) {
    // Update local-plane coordinates with whatever the instruction specifies
    const lx = (instr.x !== null && instr.x !== undefined) ? instr.x : state.localX;
    const ly = (instr.y !== null && instr.y !== undefined) ? instr.y : state.localY;
    const lz = (instr.z !== null && instr.z !== undefined) ? instr.z : state.localZ;

    // Store local position for next instruction
    state.localX = lx;
    state.localY = ly;
    state.localZ = lz;

    // Rotate local coordinates through EA/EC angles to get machine offsets
    const { dx, dy, dz } = rtcpRotate(lx, ly, lz, state.rtcp.ea, state.rtcp.ec);

    // Machine position = G54 origin + RTCP pivot + rotated local offset
    pos.x = state.originX + state.rtcp.eu + dx;
    pos.y = state.originY + state.rtcp.ev + dy;
    pos.z = state.originZ + state.rtcp.ew + dz;

    // A/C axes: use explicit values if given, otherwise keep current state
    // (state.a/c were set by previous G143 or G00-with-A/C moves)
    if (instr.a !== null && instr.a !== undefined) pos.a = instr.a;
    if (instr.c !== null && instr.c !== undefined) pos.c = instr.c;
  } else if (state.coordMode === 'G54') {
    if (instr.x !== null && instr.x !== undefined) pos.x = state.originX + instr.x;
    if (instr.y !== null && instr.y !== undefined) pos.y = state.originY + instr.y;
    if (instr.z !== null && instr.z !== undefined) pos.z = state.originZ + instr.z;
    if (instr.a !== null && instr.a !== undefined) pos.a = instr.a;
    if (instr.c !== null && instr.c !== undefined) pos.c = instr.c;
  } else {
    if (instr.x !== null && instr.x !== undefined) pos.x = instr.x;
    if (instr.y !== null && instr.y !== undefined) pos.y = instr.y;
    if (instr.z !== null && instr.z !== undefined) pos.z = instr.z;
    if (instr.a !== null && instr.a !== undefined) pos.a = instr.a;
    if (instr.c !== null && instr.c !== undefined) pos.c = instr.c;
  }
  return pos;
}

function computeArcPoints(sx, sy, ex, ey, r, clockwise, numSegs = 32) {
  const dx = ex - sx;
  const dy = ey - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const rAbs = Math.max(Math.abs(r), dist / 2);
  const h = Math.sqrt(Math.max(0, rAbs * rAbs - (dist / 2) * (dist / 2)));
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const px = -dy / (dist || 1);
  const py = dx / (dist || 1);
  const side = (r > 0) !== clockwise ? 1 : -1;
  const cx = mx + side * h * px;
  const cy = my + side * h * py;
  const startAngle = Math.atan2(sy - cy, sx - cx);
  const endAngle = Math.atan2(ey - cy, ex - cx);
  let sweep = endAngle - startAngle;
  if (clockwise) {
    if (sweep > 0) sweep -= 2 * Math.PI;
    if (sweep === 0) sweep = -2 * Math.PI;
  } else {
    if (sweep < 0) sweep += 2 * Math.PI;
    if (sweep === 0) sweep = 2 * Math.PI;
  }
  const points = [];
  const steps = Math.max(4, Math.round(Math.abs(sweep) / (2 * Math.PI) * numSegs));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = startAngle + sweep * t;
    points.push({ x: cx + rAbs * Math.cos(angle), y: cy + rAbs * Math.sin(angle) });
  }
  return { points, arcLength: Math.abs(sweep) * rAbs };
}

function dist3D(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distAngle(a, b) {
  return Math.max(Math.abs(b.a - a.a), Math.abs(b.c - a.c));
}

/**
 * Compute visual duration for a rapid move considering both XYZ distance and A/C rotation.
 * Returns the slower of the two (they move simultaneously), with a sane minimum.
 */
function rapidDuration(startPos, endPos, minDur = 0.25) {
  const d = dist3D(startPos, endPos);
  const da = distAngle(startPos, endPos);
  const tXYZ = d / (RAPID_SPEED / 60);   // seconds for XYZ travel
  const tRot = da / RAPID_ROT_SPEED;     // seconds for rotation
  return Math.max(minDur, tXYZ, tRot);
}

// ============================================================================
// SimulationEngine
// ============================================================================

export class SimulationEngine {
  constructor(instructions, metadata) {
    this.instructions = instructions;
    this.metadata = metadata;
    this.segments = [];
    this.state = new MachineState();
    this.currentIndex = 0;
    this.segmentProgress = 0;
    this.paused = false;
    this.pauseMessage = '';
    // Cached position — updated incrementally instead of looping all segments
    this._cachedPos = { x: 0, y: 0, z: Z_MAX, a: 0, c: 0 };
    this._cachedClamps = [400, 1300, 2200, 3100, 4000, 4900, 5800, 6700];
    this._cacheValidIndex = -1;
  }

  buildTimeline() {
    this.segments = [];
    const state = this.state;
    const pendingClamps = {};

    if (this.metadata.length) {
      state.profileLength = this.metadata.length;
    }

    for (const instr of this.instructions) {
      switch (instr.type) {

        case 'SET_ORIGIN': {
          const valMm = instr.value / 1000;
          if (instr.axis === 'X') state.originX = valMm;
          else if (instr.axis === 'Y') state.originY = valMm;
          else if (instr.axis === 'Z') state.originZ = valMm;
          // Capture the workpiece NPV (header zero point) — the FIRST non-zero
          // value set per axis. Programs reset E60001/E61001/E62001 to 0 at
          // the end, so getOrigin() (final state) would be 0 and the profile
          // would be mis-placed. This preserves the real workpiece origin for
          // profile positioning. See getWorkpieceOrigin().
          if (valMm !== 0) {
            if (state.wpOrigin === undefined) state.wpOrigin = {};
            if (state.wpOrigin[instr.axis] === undefined) state.wpOrigin[instr.axis] = valMm;
          }
          break;
        }

        case 'PARAM_SET': {
          const regNum = parseInt(instr.register.substring(1));
          if (regNum === 30002) state.profileLength = instr.value / 1000;
          else if (regNum === 30029) state.activeClamps = instr.value;
          break;
        }

        case 'CLAMP_POSITION': {
          pendingClamps[instr.clampIndex] = instr.valueMicrons / 1000;
          break;
        }

        case 'CLAMP_EXECUTE': {
          const startClamps = [...state.clamps];
          for (const [idx, val] of Object.entries(pendingClamps)) {
            state.clamps[parseInt(idx)] = val;
          }
          const endClamps = [...state.clamps];
          this.segments.push({
            type: 'CLAMP_MOVE', startClamps, endClamps,
            duration: CLAMP_MOVE_DURATION,
            description: 'Klämmor flyttas', lineNum: instr.lineNum
          });
          for (const k of Object.keys(pendingClamps)) delete pendingClamps[k];
          break;
        }

        case 'SUBROUTINE': {
          // G77 H9006.x = "Move clamps to position" subroutine
          // Triggers pending clamp positions, same as M112 (CLAMP_EXECUTE)
          if (instr.code >= 9006 && instr.code < 9007) {
            if (Object.keys(pendingClamps).length > 0) {
              const startClamps = [...state.clamps];
              for (const [idx, val] of Object.entries(pendingClamps)) {
                state.clamps[parseInt(idx)] = val;
              }
              const endClamps = [...state.clamps];
              this.segments.push({
                type: 'CLAMP_MOVE', startClamps, endClamps,
                duration: CLAMP_MOVE_DURATION,
                description: 'Klämmor positioneras (G77 H9006)', lineNum: instr.lineNum
              });
              for (const k of Object.keys(pendingClamps)) delete pendingClamps[k];
            }
          }
          // G77 H9040 = "Go to load position" — skip (informational)
          // G77 H9050 = "Clamps moved OK" — skip (confirmation)
          break;
        }

        case 'TOOL_CHANGE': {
          state.tool = instr.tool;
          state.toolDiameter = instr.d;
          // Build toolInfo from metadata.tools (extracted from .auf header)
          const aufToolInfo = this.metadata.tools ? this.metadata.tools[instr.tool] : null;
          const toolInfo = {
            tool: instr.tool,
            d: instr.d,
            ident: aufToolInfo ? aufToolInfo.ident : `T${instr.tool}`,
            diameter: aufToolInfo ? aufToolInfo.diameter : 0,
            lengthTotal: aufToolInfo ? aufToolInfo.lengthTotal : 0
          };
          this.segments.push({
            type: 'TOOL_CHANGE',
            toolInfo,
            description: `Verktygsbyte T${instr.tool}${aufToolInfo ? ' (' + aufToolInfo.ident + ' \u00D8' + aufToolInfo.diameter + ')' : ''}`,
            duration: STATE_CHANGE_DURATION, lineNum: instr.lineNum
          });
          if (instr.rapidX !== null) {
            const startPos = { ...state.pos };
            state.x = instr.rapidX;
            const endPos = { ...state.pos };
            const d = dist3D(startPos, endPos);
            if (d > 0.01) {
              this.segments.push({
                type: 'MOTION', moveType: 'RAPID', startPos, endPos,
                duration: rapidDuration(startPos, endPos),
                description: `Rapid X${instr.rapidX.toFixed(0)}`, lineNum: instr.lineNum
              });
            }
          }
          break;
        }

        case 'SPINDLE_ON': {
          state.spindleRpm = instr.rpm;
          state.spindleOn = true;
          // No visible segment needed — just state
          break;
        }

        case 'SPINDLE_OFF': {
          state.spindleOn = false;
          state.spindleRpm = 0;
          break;
        }

        case 'COORD_MODE': { state.coordMode = instr.mode; break; }
        case 'ABS_MODE': { state.absMode = true; break; }
        case 'RTCP_OFF': { state.rtcpActive = false; break; }
        case 'RTCP_ON': { state.rtcpActive = true; break; }

        case 'RTCP_SET': {
          state.rtcp.eu = instr.eu; state.rtcp.ev = instr.ev; state.rtcp.ew = instr.ew;
          state.rtcp.ea = instr.ea; state.rtcp.eb = instr.eb ?? 0; state.rtcp.ec = instr.ec;
          const hasNonZero = instr.eu || instr.ev || instr.ew || instr.ea || instr.ec;
          if (hasNonZero) {
            // Activate RTCP with non-zero pivot/angle — real coordinate transformation
            state.rtcpActive = true;
          } else {
            // G151 EU0 EV0 EW0 EA0 EC0 = reset/clear RTCP → deactivate
            state.rtcpActive = false;
          }
          // Reset local-plane position — new plane starts at local origin (0,0,0)
          state.localX = 0;
          state.localY = 0;
          state.localZ = 0;
          break;
        }

        case 'POSITION_ROTARY': {
          // G143 = "Jump over clamp" — per ECI spec, sequence is:
          //   Step 1: Retract to Z-MAX (safety clearance)
          //   Step 2: Rapid X, Y, A, C to target (at Z-MAX height)
          //   Step 3: Rapid Z down to G143's Z value (approach height)
          // G143 coordinates are ALWAYS in G54, never in RTCP local plane
          const wasRtcp = state.rtcpActive;
          state.rtcpActive = false;
          const finalPos = resolvePosition(instr, state);
          state.rtcpActive = wasRtcp;

          // Step 1: Retract to Z-MAX for safety
          if (Math.abs(state.z - Z_MAX) > 0.01) {
            const s1Start = { ...state.pos };
            state.z = Z_MAX;
            const s1End = { ...state.pos };
            this.segments.push({
              type: 'MOTION', moveType: 'RAPID', startPos: s1Start, endPos: s1End,
              duration: rapidDuration(s1Start, s1End, 0.1),
              description: `G143 → Z-MAX`, lineNum: instr.lineNum
            });
          }

          // Step 2: Rapid X/Y and rotate A/C (at safe Z-MAX height)
          const s2Start = { ...state.pos };
          state.x = finalPos.x; state.y = finalPos.y;
          state.a = finalPos.a; state.c = finalPos.c;
          const s2End = { ...state.pos };
          const d2 = dist3D(s2Start, s2End);
          const da2 = distAngle(s2Start, s2End);
          if (d2 > 0.01 || da2 > 0.01) {
            this.segments.push({
              type: 'MOTION', moveType: 'RAPID', startPos: s2Start, endPos: s2End,
              duration: rapidDuration(s2Start, s2End, 0.2),
              description: `G143 X${finalPos.x.toFixed(0)} A${finalPos.a.toFixed(0)}° C${finalPos.c.toFixed(0)}°`,
              lineNum: instr.lineNum
            });
          }

          // Step 3: Rapid Z down to approach height (G143's Z value)
          if (Math.abs(state.z - finalPos.z) > 0.01) {
            const s3Start = { ...state.pos };
            state.z = finalPos.z;
            const s3End = { ...state.pos };
            this.segments.push({
              type: 'MOTION', moveType: 'RAPID', startPos: s3Start, endPos: s3End,
              duration: rapidDuration(s3Start, s3End, 0.1),
              description: `G143 Z${finalPos.z.toFixed(0)}`, lineNum: instr.lineNum
            });
          }
          break;
        }

        case 'RAPID_ZMAX': {
          const startPos = { ...state.pos };
          state.z = Z_MAX;
          const endPos = { ...state.pos };
          this.segments.push({
            type: 'MOTION', moveType: 'RAPID', startPos, endPos,
            duration: rapidDuration(startPos, endPos, 0.1),
            description: 'Z-MAX', lineNum: instr.lineNum
          });
          break;
        }

        case 'RAPID': {
          const startPos = { ...state.pos };
          const endPos = resolvePosition(instr, state);
          state.x = endPos.x; state.y = endPos.y; state.z = endPos.z;
          state.a = endPos.a; state.c = endPos.c;
          this.segments.push({
            type: 'MOTION', moveType: 'RAPID', startPos, endPos: { ...state.pos },
            duration: rapidDuration(startPos, { ...state.pos }),
            description: 'Rapid', lineNum: instr.lineNum
          });
          break;
        }

        case 'LINEAR': {
          if (instr.feed !== null) state.lastFeed = instr.feed;
          const startPos = { ...state.pos };
          const endPos = resolvePosition(instr, state);
          state.x = endPos.x; state.y = endPos.y; state.z = endPos.z;
          if (endPos.a !== undefined) state.a = endPos.a;
          if (endPos.c !== undefined) state.c = endPos.c;
          const d = dist3D(startPos, endPos);
          const da = distAngle(startPos, { ...state.pos });
          const feed = state.lastFeed || 1000;
          // Duration = max of XYZ travel time, rotation time, and minimum
          const tXYZ = d / (feed / 60);
          const tRot = da / RAPID_ROT_SPEED;
          const duration = Math.max(0.15, tXYZ, tRot);
          this.segments.push({
            type: 'MOTION', moveType: 'LINEAR', startPos, endPos: { ...state.pos },
            duration, feed, description: `G01 F${feed}`, lineNum: instr.lineNum
          });
          break;
        }

        case 'ARC_CW':
        case 'ARC_CCW': {
          if (instr.feed !== null) state.lastFeed = instr.feed;
          const clockwise = instr.type === 'ARC_CW';
          const feed = state.lastFeed || 300;

          // Get local-plane start coordinates
          // Only use RTCP path if there's an actual non-zero transform
          const arcRtcp = state.rtcpActive &&
            (state.rtcp.eu !== 0 || state.rtcp.ev !== 0 || state.rtcp.ew !== 0 ||
             state.rtcp.ea !== 0 || state.rtcp.ec !== 0);
          let localStartX, localStartY, localStartZ;
          if (arcRtcp) {
            localStartX = state.localX;
            localStartY = state.localY;
            localStartZ = state.localZ;
          } else if (state.coordMode === 'G54') {
            localStartX = state.x - state.originX;
            localStartY = state.y - state.originY;
            localStartZ = state.z - state.originZ;
          } else {
            localStartX = state.x;
            localStartY = state.y;
            localStartZ = state.z;
          }
          const localEndX = instr.x ?? localStartX;
          const localEndY = instr.y ?? localStartY;
          const localEndZ = instr.z ?? localStartZ;

          // Compute arc in the local plane (X/Y plane)
          const { points, arcLength } = computeArcPoints(
            localStartX, localStartY, localEndX, localEndY, instr.r || 1, clockwise
          );

          const duration = Math.max(0.01, arcLength / (feed / 60));

          // Transform each arc point to machine coordinates
          const machinePoints = points.map((p, i) => {
            const t = i / (points.length - 1);
            const lz = localStartZ + (localEndZ - localStartZ) * t;
            if (arcRtcp) {
              const { dx, dy, dz } = rtcpRotate(p.x, p.y, lz, state.rtcp.ea, state.rtcp.ec);
              return {
                x: state.originX + state.rtcp.eu + dx,
                y: state.originY + state.rtcp.ev + dy,
                z: state.originZ + state.rtcp.ew + dz,
                a: state.a, c: state.c
              };
            } else if (state.coordMode === 'G54') {
              return {
                x: state.originX + p.x, y: state.originY + p.y,
                z: state.originZ + lz, a: state.a, c: state.c
              };
            }
            return { x: p.x, y: p.y, z: lz, a: state.a, c: state.c };
          });

          // Update state
          if (arcRtcp) {
            state.localX = localEndX;
            state.localY = localEndY;
            state.localZ = localEndZ;
          }
          const endM = machinePoints[machinePoints.length - 1];
          state.x = endM.x; state.y = endM.y; state.z = endM.z;
          this.segments.push({
            type: 'ARC_MOTION', points: machinePoints, duration, feed,
            description: `${clockwise ? 'G02' : 'G03'} R${(instr.r || 0).toFixed(2)} F${feed}`,
            lineNum: instr.lineNum
          });
          break;
        }

        case 'HOME': {
          const startPos = { ...state.pos };
          state.z = Z_MAX; state.x = 0; state.a = 0; state.c = 0;
          const endPos = { ...state.pos };
          this.segments.push({
            type: 'MOTION', moveType: 'RAPID', startPos, endPos,
            duration: rapidDuration(startPos, endPos, 0.3),
            description: 'Hemposition', lineNum: instr.lineNum
          });
          break;
        }

        case 'OPTIONAL_STOP': {
          this.segments.push({
            type: 'PAUSE',
            message: 'M01 Operatörsstopp — tryck Play',
            lineNum: instr.lineNum
          });
          break;
        }

        case 'PROGRAM_END': {
          this.segments.push({
            type: 'STATE_CHANGE',
            description: 'Program slut (M02)',
            duration: STATE_CHANGE_DURATION, lineNum: instr.lineNum
          });
          break;
        }

        case 'MESSAGE': {
          // Skip clamp/tool messages that already have their own segments
          const t = instr.text;
          if (t.startsWith('START MOVING') || t.startsWith('TOOLCHANGE') || t.startsWith('Load machine')) break;
          this.segments.push({
            type: 'STATE_CHANGE', description: t,
            duration: STATE_CHANGE_DURATION, lineNum: instr.lineNum
          });
          break;
        }

        default: break;
      }
    }

    // Build position cache snapshots for fast seeking
    this._buildSnapshots();
    return this.segments;
  }

  /**
   * Pre-compute end-of-segment positions and cumulative time for fast seeking.
   */
  _buildSnapshots() {
    this._snapPos = [];   // position after each segment completes
    this._snapClamps = []; // clamps after each segment completes
    this._snapTool = [];   // active tool after each segment completes
    this._cumulTime = [];  // cumulative time at END of each segment
    let pos = { x: 0, y: 0, z: Z_MAX, a: 0, c: 0 };
    let clamps = [400, 1300, 2200, 3100, 4000, 4900, 5800, 6700];
    let activeTool = null;
    let t = 0;

    for (const seg of this.segments) {
      if (seg.type === 'MOTION') {
        pos = { ...seg.endPos };
      } else if (seg.type === 'ARC_MOTION') {
        const last = seg.points[seg.points.length - 1];
        pos = { ...last };
      } else if (seg.type === 'CLAMP_MOVE') {
        clamps = [...seg.endClamps];
      } else if (seg.type === 'TOOL_CHANGE') {
        activeTool = seg.toolInfo;
      }
      t += seg.duration || 0;
      this._snapPos.push({ ...pos });
      this._snapClamps.push([...clamps]);
      this._snapTool.push(activeTool);
      this._cumulTime.push(t);
    }
  }

  get totalSegments() { return this.segments.length; }

  get totalDuration() {
    return this.segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  }

  reset() {
    this.currentIndex = 0;
    this.segmentProgress = 0;
    this.paused = false;
    this.pauseMessage = '';
  }

  isFinished() {
    return this.currentIndex >= this.segments.length;
  }

  /**
   * Advance the simulation by dt seconds.
   */
  advance(dt) {
    if (this.isFinished() || this.paused) return this.getPosition();

    let seg = this.segments[this.currentIndex];
    if (!seg) return this.getPosition();

    if (seg.type === 'PAUSE') {
      this.paused = true;
      this.pauseMessage = seg.message || '';
      return this.getPosition();
    }

    let dur = seg.duration || 0.01;
    this.segmentProgress += dt / dur;

    while (this.segmentProgress >= 1.0) {
      const overflow = (this.segmentProgress - 1.0) * dur; // remaining time in seconds
      this.currentIndex++;

      if (this.currentIndex >= this.segments.length) {
        this.segmentProgress = 1.0;
        this.currentIndex = this.segments.length;
        return this.getPosition();
      }

      seg = this.segments[this.currentIndex];
      if (seg.type === 'PAUSE') {
        this.paused = true;
        this.pauseMessage = seg.message || '';
        this.segmentProgress = 0;
        return this.getPosition();
      }

      dur = seg.duration || 0.01;
      this.segmentProgress = overflow / dur;
    }

    return this.getPosition();
  }

  resume() {
    if (this.paused) {
      this.paused = false;
      this.pauseMessage = '';
      this.currentIndex++;
      this.segmentProgress = 0;
    }
  }

  stepForward() {
    if (this.paused) { this.resume(); return; }
    if (this.currentIndex < this.segments.length) {
      this.currentIndex++;
      this.segmentProgress = 0;
    }
  }

  stepBack() {
    this.paused = false;
    this.pauseMessage = '';
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.segmentProgress = 0;
    }
  }

  seekTo(index) {
    this.paused = false;
    this.pauseMessage = '';
    this.currentIndex = Math.max(0, Math.min(index, this.segments.length));
    this.segmentProgress = 0;
  }

  /**
   * Seek to an exact time position (in seconds). Smooth video-like scrubbing.
   * Sets currentIndex AND segmentProgress so the position is interpolated mid-segment.
   */
  seekToTime(targetTime) {
    this.paused = false;
    this.pauseMessage = '';

    if (!this._cumulTime || this._cumulTime.length === 0) {
      this.currentIndex = 0;
      this.segmentProgress = 0;
      return;
    }

    const total = this._cumulTime[this._cumulTime.length - 1];
    targetTime = Math.max(0, Math.min(targetTime, total));

    if (targetTime <= 0) {
      this.currentIndex = 0;
      this.segmentProgress = 0;
      return;
    }
    if (targetTime >= total) {
      this.currentIndex = this.segments.length;
      this.segmentProgress = 1;
      return;
    }

    // Binary search for the segment that contains targetTime
    let lo = 0, hi = this._cumulTime.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._cumulTime[mid] < targetTime) lo = mid + 1;
      else hi = mid;
    }
    // lo is the first segment whose cumulative end time >= targetTime
    this.currentIndex = lo;
    const segStart = lo > 0 ? this._cumulTime[lo - 1] : 0;
    const segDur = this.segments[lo].duration || 0.01;
    this.segmentProgress = Math.max(0, Math.min(1, (targetTime - segStart) / segDur));
  }

  /**
   * Get the currently elapsed time (seconds) including segment progress.
   */
  getElapsedTime() {
    if (!this._cumulTime || this._cumulTime.length === 0) return 0;
    if (this.currentIndex >= this.segments.length) {
      return this._cumulTime[this._cumulTime.length - 1];
    }
    const segStart = this.currentIndex > 0 ? this._cumulTime[this.currentIndex - 1] : 0;
    const segDur = this.segments[this.currentIndex].duration || 0;
    return segStart + segDur * this.segmentProgress;
  }

  /**
   * Get the interpolated position using pre-computed snapshots.
   */
  getPosition() {
    if (this.segments.length === 0 || !this._snapPos) {
      return { x: 0, y: 0, z: Z_MAX, a: 0, c: 0, clamps: [400, 1300, 2200, 3100, 4000, 4900, 5800, 6700] };
    }

    // Get base position from previous segment snapshot
    let pos;
    let clamps;
    if (this.currentIndex > 0 && this.currentIndex <= this._snapPos.length) {
      pos = { ...this._snapPos[this.currentIndex - 1] };
      clamps = [...this._snapClamps[this.currentIndex - 1]];
    } else {
      pos = { x: 0, y: 0, z: Z_MAX, a: 0, c: 0 };
      clamps = [400, 1300, 2200, 3100, 4000, 4900, 5800, 6700];
    }

    // Interpolate within current segment
    if (this.currentIndex < this.segments.length) {
      const seg = this.segments[this.currentIndex];
      const tLinear = Math.max(0, Math.min(1, this.segmentProgress));
      // Subtle ramp: 50% linear + 50% smoothstep for gentle accel/decel
      const tSmooth = tLinear * tLinear * (3 - 2 * tLinear);
      const t = 0.5 * tLinear + 0.5 * tSmooth;

      if (seg.type === 'MOTION') {
        const s = seg.startPos, e = seg.endPos;
        pos = {
          x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t,
          z: s.z + (e.z - s.z) * t, a: s.a + (e.a - s.a) * t,
          c: s.c + (e.c - s.c) * t,
        };
      } else if (seg.type === 'ARC_MOTION') {
        const pts = seg.points;
        const idx = t * (pts.length - 1);
        const i0 = Math.floor(idx);
        const i1 = Math.min(i0 + 1, pts.length - 1);
        const frac = idx - i0;
        const p0 = pts[i0], p1 = pts[i1];
        pos = {
          x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac,
          z: p0.z + (p1.z - p0.z) * frac, a: p0.a, c: p0.c,
        };
      } else if (seg.type === 'CLAMP_MOVE') {
        const s = seg.startClamps, e = seg.endClamps;
        clamps = s.map((sv, i) => sv + (e[i] - sv) * t);
      }
    }

    return { ...pos, clamps };
  }

  getCurrentDescription() {
    if (this.paused) return this.pauseMessage;
    if (this.currentIndex >= this.segments.length) return 'Klar';
    return this.segments[this.currentIndex].description || '';
  }

  getCurrentLineNum() {
    if (this.currentIndex >= this.segments.length) return null;
    return this.segments[this.currentIndex].lineNum;
  }

  getCurrentMoveType() {
    if (this.currentIndex >= this.segments.length) return null;
    const seg = this.segments[this.currentIndex];
    if (seg.type === 'MOTION') return seg.moveType;
    if (seg.type === 'ARC_MOTION') return 'ARC';
    return seg.type;
  }

  /**
   * Get the active tool info at the current position.
   * Uses the snapshot cache for fast seeking.
   */
  getActiveTool() {
    if (!this._snapTool || this._snapTool.length === 0) return null;

    // If we're at or past a TOOL_CHANGE segment, use its snapshot
    // _snapTool[i] = tool state AFTER segment i completes
    const idx = Math.min(this.currentIndex, this._snapTool.length - 1);
    if (idx >= 0) {
      // Check current segment first — if it's a TOOL_CHANGE, use it
      if (idx < this.segments.length && this.segments[idx].type === 'TOOL_CHANGE') {
        return this._snapTool[idx];
      }
      // Otherwise use previous segment's snapshot
      if (idx > 0) return this._snapTool[idx - 1];
    }
    // At segment 0 or before any tool change
    return null;
  }

  getProfileLength() {
    return this.metadata.length || this.state.profileLength || 3000;
  }

  /**
   * Get the workpiece origin (NPV) in machine coordinates (mm).
   * Set from E60001/E61001/E62001 (= L19/L18/L17) in the .auf header.
   *   originX = NPV-X (typically 0)
   *   originY = NPV-Y (profile front face Y in machine coords, negative = into machine)
   *   originZ = NPV-Z (profile bottom Z in machine coords)
   */
  getOrigin() {
    return {
      x: this.state.originX,
      y: this.state.originY,
      z: this.state.originZ
    };
  }

  /**
   * The WORKPIECE origin (NPV / zero point) for positioning the profile mesh.
   * Uses the first non-zero value set per axis (the header L19/L18/L17), NOT
   * the final state — programs reset the origin to 0 at the end, which would
   * otherwise leave the profile at the wrong position.
   */
  getWorkpieceOrigin() {
    const wp = this.state.wpOrigin || {};
    return {
      x: wp.X !== undefined ? wp.X : this.state.originX,
      y: wp.Y !== undefined ? wp.Y : this.state.originY,
      z: wp.Z !== undefined ? wp.Z : this.state.originZ
    };
  }
}
