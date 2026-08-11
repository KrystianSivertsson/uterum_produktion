// ============================================================================
// aufParser.js — Parser for elumatec SBZ151 .auf files (CNC G-code)
// Exports: parseAufFile(text) -> { metadata, instructions[] }
// ============================================================================

/**
 * Evaluate a simple arithmetic expression with L-variable references.
 * Supports: +, -, *, / — left-to-right, no precedence.
 * Examples: "0*1000", "-92.800*1000-60000", "L19/1+300500"
 */
function evalExpr(expr, variables) {
  // Replace L-variable references with their numeric values
  let s = expr.replace(/L(\d+)/g, (_, n) => {
    const v = variables['L' + n];
    return v !== undefined ? String(v) : '0';
  });
  // Replace E-parameter references
  s = s.replace(/E(\d+)/g, (_, n) => {
    const v = variables['E' + n];
    return v !== undefined ? String(v) : '0';
  });

  // Tokenize into numbers and operators
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    if ('+-*/'.includes(s[i]) && tokens.length > 0 && typeof tokens[tokens.length - 1] === 'number') {
      tokens.push(s[i]);
      i++;
    } else {
      // Parse number (may start with - for negative)
      let numStr = '';
      if (s[i] === '-' || s[i] === '+') { numStr += s[i]; i++; }
      while (i < s.length && (s[i] >= '0' && s[i] <= '9' || s[i] === '.')) {
        numStr += s[i]; i++;
      }
      if (numStr === '' || numStr === '-' || numStr === '+') {
        i++; continue; // skip unexpected chars
      }
      tokens.push(parseFloat(numStr));
    }
  }

  // Evaluate left-to-right
  if (tokens.length === 0) return 0;
  let result = tokens[0];
  for (let j = 1; j < tokens.length - 1; j += 2) {
    const op = tokens[j];
    const val = tokens[j + 1];
    if (typeof val !== 'number') break;
    switch (op) {
      case '+': result += val; break;
      case '-': result -= val; break;
      case '*': result *= val; break;
      case '/': result = val !== 0 ? result / val : 0; break;
    }
  }
  return result;
}

/**
 * Extract axis values from a token string.
 * Handles: X123.4 Y-56 Z0 A-90 C0 F825 R1.250
 * Also handles EU, EV, EW, EA, EB, EC for G151
 */
function extractAxes(text) {
  const axes = {};
  // Standard single-letter axes + F/R/S/T/D
  const re = /(?<![A-Z])([XYZACFRSD])(-?\d+\.?\d*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    axes[m[1]] = parseFloat(m[2]);
  }
  // G151 extended axes: EU, EV, EW, EA, EB, EC
  const reExt = /(E[UVWABC])(-?\d+\.?\d*)/g;
  while ((m = reExt.exec(text)) !== null) {
    axes[m[1]] = parseFloat(m[2]);
  }
  // T and D with integer values (for tool change)
  const reT = /\bT(\d+)/g;
  while ((m = reT.exec(text)) !== null) {
    axes['T'] = parseInt(m[1]);
  }
  const reD = /\bD(\d+)/g;
  while ((m = reD.exec(text)) !== null) {
    axes['D'] = parseInt(m[1]);
  }
  return axes;
}

/**
 * Parse an .auf file into metadata and an instruction list.
 */
export function parseAufFile(text) {
  const lines = text.split(/\r?\n/);
  const metadata = {};
  const instructions = [];
  const variables = {}; // L-variables and E-parameters

  let headerDone = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // --- Program ID line ---
    if (trimmed.startsWith('%')) {
      metadata.programId = trimmed;
      continue;
    }

    // --- Header metadata: (#key : value) ---
    const metaMatch = trimmed.match(/^\(#(\w+)\s*:\s*(.*?)\s*\)/);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();
      if (key === 'length') metadata.length = parseFloat(val);
      else if (key.startsWith('angle')) metadata[key] = parseFloat(val);
      else if (key.startsWith('clamp')) metadata[key] = parseFloat(val);
      else if (key === 'profnr') metadata.profnr = val;
      else if (key === 'job') metadata.job = val.trim();
      else if (key === 'position') metadata.position = val.trim();
      else if (key === 'jobdesc') metadata.jobDesc = val;
      else if (key === 'prgdesc') metadata.prgDesc = val;
      continue;
    }

    // --- Check for END HEADER ---
    if (trimmed.includes('END HEADER')) { headerDone = true; continue; }

    // --- Tool list in header: extract tool info ---
    // Format: ( 1. tool --> TPlace : 21  ;  TIDENT : SAW-500 ;  TDIAMETER : 500 ;  TLengthTotal : 55.800)
    // MUST come before the generic comment skip below!
    const toolListMatch = trimmed.match(/^\(\s*\d+\.\s*tool\s*-->\s*TPlace\s*:\s*(\d+)\s*;\s*TIDENT\s*:\s*([^;]*?)\s*;\s*TDIAMETER\s*:\s*([^;]*?)\s*;\s*TLengthTotal\s*:\s*([^)]*)/i);
    if (toolListMatch) {
      if (!metadata.tools) metadata.tools = {};
      const tPlace = parseInt(toolListMatch[1]);
      metadata.tools[tPlace] = {
        place: tPlace,
        ident: toolListMatch[2].trim(),
        diameter: parseFloat(toolListMatch[3]) || 0,
        lengthTotal: parseFloat(toolListMatch[4]) || 0
      };
      continue;
    }
    if (trimmed.match(/^\(\s*Used tools/i)) continue;

    // --- Pure comment lines (no Nxxx prefix, starts with '(') ---
    if (trimmed.startsWith('(') && !trimmed.match(/^N\d/)) continue;

    // --- Bare E-parameter before header end (e.g., E30110=0) ---
    if (!headerDone && trimmed.match(/^E\d+=/) && !trimmed.match(/^N\d/)) {
      const eqIdx = trimmed.indexOf('=');
      const reg = trimmed.substring(0, eqIdx);
      const val = evalExpr(trimmed.substring(eqIdx + 1), variables);
      variables[reg] = val;
      continue;
    }

    // --- NC block lines: strip Nxxx prefix ---
    let line = trimmed;
    const lineNumMatch = line.match(/^N(\d+)\s+/);
    let lineNum = null;
    if (lineNumMatch) {
      lineNum = parseInt(lineNumMatch[1]);
      line = line.substring(lineNumMatch[0].length);
    }

    // --- Extract operator messages: $(...) ---
    const msgMatch = line.match(/\$\(([^)]*)\)/);
    if (msgMatch) {
      instructions.push({ type: 'MESSAGE', text: msgMatch[1].trim(), lineNum });
      // Continue processing the rest of the line (might have G-codes after)
      line = line.replace(/\$\([^)]*\)/, '').trim();
      if (!line) continue;
    }

    // --- Strip inline comments (...) ---
    line = line.replace(/\([^)]*\)/g, '').trim();
    if (!line) continue;

    // --- L-variable assignment: L19=expr ---
    const lMatch = line.match(/^(L\d+)\s*=\s*(.+)/);
    if (lMatch) {
      const name = lMatch[1];
      const val = evalExpr(lMatch[2].trim(), variables);
      variables[name] = val;
      instructions.push({ type: 'VAR_SET', name, value: val, lineNum });
      continue;
    }

    // --- E-parameter assignment: E30002=expr ---
    const eMatch = line.match(/^(E\d+)\s*=\s*(.+)/);
    if (eMatch) {
      const reg = eMatch[1];
      const val = evalExpr(eMatch[2].trim(), variables);
      variables[reg] = val;

      // Check if this is a clamp position register
      const regNum = parseInt(reg.substring(1));
      if (regNum >= 30031 && regNum <= 30044) {
        instructions.push({
          type: 'CLAMP_POSITION',
          clampIndex: regNum - 30031,
          valueMicrons: val,
          lineNum
        });
      } else if (regNum >= 81401 && regNum <= 81408) {
        instructions.push({
          type: 'CLAMP_POSITION',
          clampIndex: regNum - 81401,
          valueMicrons: val,
          lineNum
        });
      } else if (regNum === 60001 || regNum === 61001 || regNum === 62001) {
        const axis = regNum === 60001 ? 'X' : regNum === 61001 ? 'Y' : 'Z';
        instructions.push({ type: 'SET_ORIGIN', axis, register: reg, value: val, lineNum });
      } else {
        instructions.push({ type: 'PARAM_SET', register: reg, value: val, lineNum });
      }
      continue;
    }

    // --- Parse multiple G/M codes and motion on the same line ---
    parseLine(line, lineNum, instructions, variables);
  }

  return { metadata, instructions };
}

/**
 * Parse a single NC line (after stripping comments and line number).
 * A line can contain multiple codes: "G54 G90 G00" or "T13 D13 M6 G0 X859.594"
 */
function parseLine(line, lineNum, instructions, variables) {
  // --- Emit coordinate mode changes FIRST (they appear with motion on same line) ---
  if (line.match(/\bG54\b/)) {
    instructions.push({ type: 'COORD_MODE', mode: 'G54', lineNum });
  }
  if (line.match(/\bG52\b/) && !line.match(/ZE72003/)) {
    instructions.push({ type: 'COORD_MODE', mode: 'G52', lineNum });
  }
  if (line.match(/\bG90\b/)) {
    instructions.push({ type: 'ABS_MODE', lineNum });
  }

  // Check for G151 with EU/EV/EW parameters (RTCP set)
  if (line.includes('G151') && line.match(/E[UVWABC]/)) {
    const axes = extractAxes(line);
    instructions.push({
      type: 'RTCP_SET',
      eu: axes.EU ?? 0, ev: axes.EV ?? 0, ew: axes.EW ?? 0,
      ea: axes.EA ?? 0, eb: axes.EB ?? 0, ec: axes.EC ?? 0,
      tool: axes.T ?? null, d: axes.D ?? null,
      lineNum
    });
    return;
  }

  // G151 S0 — RTCP off
  if (line.match(/G151\s+S0/)) {
    instructions.push({ type: 'RTCP_OFF', lineNum });
    return;
  }

  // G151 S1 — RTCP on
  if (line.match(/G151\s+S1/)) {
    instructions.push({ type: 'RTCP_ON', lineNum });
    return;
  }

  // G143 — position rotary axes
  if (line.includes('G143')) {
    const axes = extractAxes(line);
    instructions.push({
      type: 'POSITION_ROTARY',
      x: axes.X ?? null, y: axes.Y ?? null, z: axes.Z ?? null,
      a: axes.A ?? null, c: axes.C ?? null,
      lineNum
    });
    return;
  }

  // Tool change: T13 D13 M6 ...
  if (line.match(/\bT\d+/) && line.includes('M6')) {
    const axes = extractAxes(line);
    instructions.push({
      type: 'TOOL_CHANGE',
      tool: axes.T ?? 0, d: axes.D ?? 0,
      rapidX: axes.X ?? null,
      lineNum
    });
    return;
  }

  // Spindle on: S6500 M3 or S6500 M4
  if (line.match(/S\d+/) && (line.includes('M3') || line.includes('M4'))) {
    const sMatch = line.match(/S(\d+)/);
    const rpm = sMatch ? parseInt(sMatch[1]) : 0;
    const dir = line.includes('M4') ? 'CCW' : 'CW';
    instructions.push({ type: 'SPINDLE_ON', rpm, direction: dir, lineNum });
    return;
  }

  // G0 G52 ZE72003 — rapid to Z-MAX in machine coords
  if (line.match(/G52/) && line.match(/ZE72003/)) {
    instructions.push({ type: 'RAPID_ZMAX', lineNum });
    return;
  }

  // G02/G03 — arc
  if (line.match(/G0?[23]\b/)) {
    const cw = line.match(/G0?2\b/) !== null;
    const axes = extractAxes(line);
    instructions.push({
      type: cw ? 'ARC_CW' : 'ARC_CCW',
      x: axes.X ?? null, y: axes.Y ?? null, z: axes.Z ?? null,
      r: axes.R ?? null,
      feed: axes.F ?? null,
      lineNum
    });
    return;
  }

  // G01 — linear feed
  if (line.match(/G0?1\b/) && !line.match(/G0?1\d/)) {
    const axes = extractAxes(line);
    instructions.push({
      type: 'LINEAR',
      x: axes.X ?? null, y: axes.Y ?? null, z: axes.Z ?? null,
      a: axes.A ?? null, c: axes.C ?? null,
      feed: axes.F ?? null,
      lineNum
    });
    // Check for M300 on same line (coolant off after retract)
    if (line.includes('M300')) {
      instructions.push({ type: 'COOLANT_OFF', lineNum });
    }
    return;
  }

  // G00/G0 — rapid
  if (line.match(/G0?0\b/) && !line.match(/G0?0[1-9]/)) {
    const axes = extractAxes(line);
    const rapid = {
      type: 'RAPID',
      x: axes.X ?? null, y: axes.Y ?? null, z: axes.Z ?? null,
      a: axes.A ?? null, c: axes.C ?? null,
      lineNum
    };
    instructions.push(rapid);
    // Check for M300 on same line
    if (line.includes('M300')) {
      instructions.push({ type: 'COOLANT_OFF', lineNum });
    }
    return;
  }

  // M-codes (standalone or combined)
  if (line.includes('M112')) {
    instructions.push({ type: 'CLAMP_EXECUTE', lineNum });
  }
  if (line.includes('M111')) {
    instructions.push({ type: 'HOME', lineNum });
  }
  if (line.match(/\bM01\b/)) {
    instructions.push({ type: 'OPTIONAL_STOP', lineNum });
  }
  if (line.match(/\bM02\b/)) {
    instructions.push({ type: 'PROGRAM_END', lineNum });
  }
  if (line.match(/\bM5\b/) && !line.match(/M5\d/)) {
    instructions.push({ type: 'SPINDLE_OFF', lineNum });
  }
  if (line.includes('M300')) {
    instructions.push({ type: 'COOLANT_OFF', lineNum });
  }
  if (line.match(/\bM10\b/) && !line.match(/M10\d/)) {
    instructions.push({ type: 'AXIS_LOCK', lineNum });
  }
  if (line.match(/\bM11\b/) && !line.match(/M11[12]/)) {
    instructions.push({ type: 'AXIS_UNLOCK', lineNum });
  }

  // G77 Hxxxx — subroutine call
  const g77Match = line.match(/G77\s+H(\d+\.?\d*)/);
  if (g77Match) {
    instructions.push({ type: 'SUBROUTINE', code: parseFloat(g77Match[1]), lineNum });
  }

  // G04 dwell (paired with M-codes, mostly informational)
  // M374/M375/M376/M377 — clamp zone control (skip for simulation)
  // D0 — cancel tool offset (skip for simulation)
}

/**
 * Parse a multi-job .auf file into an array of jobs.
 * Each job is separated by a `%1 (ID ...)` line.
 * Returns: [ { metadata, instructions, rawLineOffset, rawLineCount }, ... ]
 * Single-job files return a 1-element array (backwards compatible).
 */
export function parseAufFileMultiJob(text) {
  const lines = text.split(/\r?\n/);

  // Find all program-start markers. A job starts on a line beginning with '%'
  // followed by a program name or number — eluCad emits one %<name> program per
  // part/position (e.g. "%gustavsson_p3"), while some posts use "%1"/"%2". Both
  // match /^\s*%\S/. (A bare "%" is a program-end marker, not a start.)
  const jobStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*%\S/.test(lines[i])) {
      jobStarts.push(i);
    }
  }

  // If no %1 found or only one, treat as single job
  if (jobStarts.length <= 1) {
    const result = parseAufFile(text);
    return [{
      metadata: result.metadata,
      instructions: result.instructions,
      rawLineOffset: 0,
      rawLineCount: lines.length
    }];
  }

  // Split into chunks at each %1 line
  const jobs = [];
  for (let j = 0; j < jobStarts.length; j++) {
    const startLine = jobStarts[j];
    const endLine = (j + 1 < jobStarts.length) ? jobStarts[j + 1] : lines.length;
    const chunkLines = lines.slice(startLine, endLine);
    const chunkText = chunkLines.join('\n');

    const result = parseAufFile(chunkText);
    jobs.push({
      metadata: result.metadata,
      instructions: result.instructions,
      rawLineOffset: startLine,
      rawLineCount: endLine - startLine
    });
  }

  return jobs;
}
