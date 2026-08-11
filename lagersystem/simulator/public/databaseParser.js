// ============================================================================
// databaseParser.js — Parsers for elumatec/Axium database files
// Formats: .nct (tool database), .efd (fixture definitions),
//          .epo (profile offsets), .epd (profile cross-sections)
// ============================================================================

/**
 * Parse an Axium .nct tool database file.
 * Returns a Map keyed by TPlace (integer) → ToolDef object.
 */
export function parseNctFile(text) {
  const tools = new Map();
  const angleHeads = new Map();

  // --- Parse :ANGLEHEAD sections ---
  const ahSections = text.split(/^:ANGLEHEAD\b/m);
  for (let i = 1; i < ahSections.length; i++) {
    // Stop at next :TOOL or :ANGLEHEAD or :OPTIONS
    const secText = ahSections[i].split(/^:/m)[0];

    const str = (key) => {
      const m = secText.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm'));
      return m ? m[1].trim() : '';
    };
    const num = (key) => {
      const m = secText.match(new RegExp(`^\\s*${key}\\s*=\\s*([\\d.\\-]+)`, 'm'));
      return m ? parseFloat(m[1]) : 0;
    };

    const head = {
      name: str('TIdent'),
      description: str('TDescription'),
      manufacturer: str('TManufactor'),
      positions: [],
      collisionObjects: []
    };

    // Positions (NCT uses TPosition0_A etc.)
    // Count how many positions exist (typically 1)
    for (let p = 0; p < 4; p++) {
      const a = num(`TPosition${p}_A`);
      const z = num(`TPosition${p}_Z`);
      if (p > 0 && a === 0 && z === 0) break; // no more positions
      head.positions.push({
        id: Math.round(num(`TPosition${p}_ID`)),
        a, c: num(`TPosition${p}_C`),
        x: num(`TPosition${p}_X`),
        y: num(`TPosition${p}_Y`),
        z,
        flex: num(`TPosition${p}_Flex`)
      });
    }

    // Collision objects (NCT uses TColType0, TColOffset0_X etc.)
    for (let c = 0; c < 20; c++) {
      const typeKey = `TColType${c}`;
      if (!secText.match(new RegExp(`^\\s*${typeKey}\\s*=`, 'm'))) break;
      head.collisionObjects.push({
        type: Math.round(num(typeKey)),
        angleA: num(`TColAngle${c}_A`),
        angleC: num(`TColAngle${c}_C`),
        offsetX: num(`TColOffset${c}_X`),
        offsetY: num(`TColOffset${c}_Y`),
        offsetZ: num(`TColOffset${c}_Z`),
        lengthX: num(`TColLength${c}_X`),
        lengthY: num(`TColLength${c}_Y`),
        lengthZ: num(`TColLength${c}_Z`),
        mount: Math.round(num(`TColMount${c}`))
      });
    }

    if (head.name) {
      angleHeads.set(head.name, head);
    }
  }

  // --- Parse :TOOL sections ---
  const sections = text.split(/^:TOOL\b/m);

  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i];
    const tool = {};

    const str = (key) => {
      const m = sec.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm'));
      return m ? m[1].trim() : '';
    };
    const num = (key) => {
      const m = sec.match(new RegExp(`^\\s*${key}\\s*=\\s*([\\d.\\-]+)`, 'm'));
      return m ? parseFloat(m[1]) : 0;
    };

    tool.ident = str('TIdent');
    tool.description = str('TDescription');
    tool.kind = str('TKind');        // MILL, DRILL, SAW, NDISK
    tool.place = Math.round(num('TPlace'));
    tool.diameter = num('TDiameter');
    tool.lengthCutting = num('TLength_Cutting');
    tool.lengthTotal = num('TLength_Total');
    tool.lengthIntrusion = num('TLengthIntrusion');
    tool.shankDiameter = num('TShankDiameter');
    tool.speed = num('TSpeed');
    tool.forward = num('TForward');
    tool.angle = num('TAngle');
    tool.direction = Math.round(num('TDirection'));

    // Mount / holder info
    tool.mountName = str('TNameMount');
    tool.mountDiam = num('TDiamMount');
    tool.mount2Diam = num('T2DiamMount');
    tool.mountLength = num('TLengthMount');
    tool.mount2Length = num('T2LengthMount');

    // Saw-specific
    tool.screwDiameter = num('TScrewDiameter');
    tool.screwLength = num('TScrewLength');

    // Angle head (Winkelhaupt / WFK)
    tool.angleHead = Math.round(num('TAngleHead')) === 1;
    tool.angleHeadIdent = str('TAngleHeadIdent');
    tool.angleHeadPlace = Math.round(num('TAngleHeadPlace'));

    if (tool.place > 0) {
      tools.set(tool.place, tool);
    }
  }

  // Return both tools and angle heads
  // For backward compatibility, the Map is tools, but .angleHeads is attached
  tools.angleHeads = angleHeads;
  return tools;
}

/**
 * Parse an AngleHead.ini file.
 * Returns a Map keyed by HeadName (string) → AngleHeadDef object.
 *
 * AngleHeadDef: {
 *   name: string,          // HeadName e.g. "150 20 86 04"
 *   description: string,   // HeadDescr e.g. "WFK2e von unten"
 *   manufacturer: string,
 *   positions: [{          // Typically 1 position (Position0)
 *     id: number, a: number, c: number, x: number, y: number, z: number, flex: number
 *   }],
 *   collisionObjects: [{   // ColObjectNum entries
 *     type: number,        // 1=box, 2=cylinder
 *     angleA: number, angleC: number,
 *     offsetX: number, offsetY: number, offsetZ: number,
 *     lengthX: number, lengthY: number, lengthZ: number,
 *     mount: number        // 1 = follows output rotation
 *   }]
 * }
 */
export function parseAngleHeadIni(text) {
  const heads = new Map();
  const lines = text.split(/\r?\n/);

  // Find [AngleHead] header → NumEntries
  let numEntries = 0;
  for (const line of lines) {
    const m = line.match(/^\s*NumEntries\s*=\s*(\d+)/);
    if (m) { numEntries = parseInt(m[1]); break; }
  }

  for (let hi = 0; hi < numEntries; hi++) {
    // Find [AngleHeadN] section
    const sectionHeader = `[AngleHead${hi}]`;
    let startIdx = lines.findIndex(l => l.trim() === sectionHeader);
    if (startIdx < 0) continue;

    // Collect all lines until next [section] or end
    const sectionLines = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) break;
      sectionLines.push(lines[i]);
    }
    const sec = sectionLines.join('\n');

    const str = (key) => {
      const m = sec.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const num = (key) => {
      const m = sec.match(new RegExp(`^\\s*${key}\\s*=\\s*([\\d.\\-]+)`, 'm'));
      return m ? parseFloat(m[1]) : 0;
    };

    const head = {
      name: str('HeadName'),
      description: str('HeadDescr'),
      manufacturer: str('Manufactor'),
      positions: [],
      collisionObjects: []
    };

    // Parse positions
    const numPositions = Math.round(num('Positions')) || 1;
    for (let p = 0; p < numPositions; p++) {
      head.positions.push({
        id: Math.round(num(`Position${p}ID`)),
        a: num(`Position${p}A`),
        c: num(`Position${p}C`),
        x: num(`Position${p}X`),
        y: num(`Position${p}Y`),
        z: num(`Position${p}Z`),
        flex: num(`Position${p}Flex`)
      });
    }

    // Parse collision objects
    const numCol = Math.round(num('ColObjectNum')) || 0;
    for (let c = 0; c < numCol; c++) {
      head.collisionObjects.push({
        type: Math.round(num(`Col${c}Type`)),
        angleA: num(`Col${c}AngleA`),
        angleC: num(`Col${c}AngleC`),
        offsetX: num(`Col${c}OffsetX`),
        offsetY: num(`Col${c}OffsetY`),
        offsetZ: num(`Col${c}OffsetZ`),
        lengthX: num(`Col${c}LengthX`),
        lengthY: num(`Col${c}LengthY`),
        lengthZ: num(`Col${c}LengthZ`),
        mount: Math.round(num(`Col${c}Mount`))
      });
    }

    if (head.name) {
      heads.set(head.name, head);
    }
  }

  return heads;
}

/**
 * Parse an Axium .efd fixture definition file.
 * Returns a Map keyed by MName (string) → FixtureDef object.
 * Only parses active fixtures (`:FIXTURE`), skips disabled (`~FIXTURE`).
 */
export function parseEfdFile(text) {
  const fixtures = new Map();
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for :FIXTURE (active) — skip ~FIXTURE (disabled)
    if (line === ':FIXTURE') {
      const fixture = parseFixtureSection(lines, i + 1);
      if (fixture && fixture.name) {
        // Only store the first occurrence of each name
        if (!fixtures.has(fixture.name)) {
          fixtures.set(fixture.name, fixture);
        }
      }
      i = fixture ? fixture._endLine : i + 1;
      continue;
    }

    // Skip ~FIXTURE sections entirely
    if (line === '~FIXTURE') {
      // Find next :FIXTURE or ~FIXTURE or end
      i++;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l === ':FIXTURE' || l === '~FIXTURE') break;
        i++;
      }
      continue;
    }

    i++;
  }

  return fixtures;
}

function parseFixtureSection(lines, startIdx) {
  const fixture = {
    name: '',
    comment: '',
    offsetL: { x: 0, y: 0, z: 0 },
    offsetR: { x: 0, y: 0, z: 0 },
    dimensionL: { x: 0, y: 0, z: 0 },
    dimensionR: { x: 0, y: 0, z: 0 },
    polygons: [],   // Array of { points: [{x,y,z,bulge}], flags: [f1,f2,f3] }
    _endLine: startIdx
  };

  let i = startIdx;
  let inData = false;
  let currentPoly = null;
  let pointCount = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Stop at next fixture section
    if (line === ':FIXTURE' || line === '~FIXTURE') {
      fixture._endLine = i;
      break;
    }

    if (!inData) {
      // Parse header fields
      const nameMatch = line.match(/MName\s*=\s*"([^"]*)"/);
      if (nameMatch) fixture.name = nameMatch[1];

      const commentMatch = line.match(/MComment\s*=\s*"([^"]*)"/);
      if (commentMatch) fixture.comment = commentMatch[1];

      const parseVec3 = (key) => {
        const m = line.match(new RegExp(`${key}\\s*=\\s*([\\d.\\-]+)\\s+([\\d.\\-]+)\\s+([\\d.\\-]+)`));
        if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
        return null;
      };

      const ol = parseVec3('OffsetL');    if (ol) fixture.offsetL = ol;
      const or_ = parseVec3('OffsetR');   if (or_) fixture.offsetR = or_;
      const dl = parseVec3('DimensionL'); if (dl) fixture.dimensionL = dl;
      const dr = parseVec3('DimensionR'); if (dr) fixture.dimensionR = dr;

      if (line === ':DATA') {
        inData = true;
      }
    } else {
      // Parse polygon data
      // P numPoints flag1 flag2 flag3
      const pMatch = line.match(/^P\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (pMatch) {
        // Save previous polygon if exists
        if (currentPoly) {
          fixture.polygons.push(currentPoly);
        }
        pointCount = parseInt(pMatch[1]);
        currentPoly = {
          expectedPoints: pointCount,
          flags: [parseInt(pMatch[2]), parseInt(pMatch[3]), parseInt(pMatch[4])],
          points: []
        };
        i++;
        continue;
      }

      // E 0 0 — end of data section
      if (line.startsWith('E ') || line === 'E') {
        if (currentPoly) {
          fixture.polygons.push(currentPoly);
          currentPoly = null;
        }
        inData = false;
        i++;
        continue;
      }

      // Coordinate line: x y z  or  x y bulge
      if (currentPoly) {
        const parts = line.split(/\s+/).map(Number);
        if (parts.length >= 2 && !isNaN(parts[0])) {
          const pt = { x: parts[0], y: parts[1] };
          if (parts.length >= 3 && parts[2] !== 0) {
            // Third value: if it looks like a bulge factor (small value), it's bulge
            // If z coordinate, it's typically 0 for 2D fixture cross-sections
            pt.bulge = parts[2];
          }
          currentPoly.points.push(pt);
        }
      }
    }

    i++;
  }

  // Handle case where we reached end of file
  if (currentPoly) {
    fixture.polygons.push(currentPoly);
  }
  if (fixture._endLine === startIdx) {
    fixture._endLine = i;
  }

  return fixture;
}

/**
 * Parse an Axium .epo profile offset file.
 * Returns a Map keyed by profile name (string) → POffsetDef.
 * Only parses active entries (`:POFFSET`), skips `~POFFSET`.
 */
export function parseEpoFile(text) {
  const offsets = new Map();
  const sections = text.split(/^:POFFSET\b/m);

  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i];

    // Check that this section wasn't preceded by ~ (disabled)
    // Actually the split on :POFFSET won't catch ~POFFSET, so we're fine

    const nameMatch = sec.match(/MName\s*=\s*"([^"]*)"/);
    if (!nameMatch) continue;

    // Strip ":Profiles.epd" suffix if present
    let name = nameMatch[1];
    name = name.replace(/:Profiles\.epd$/i, '');

    const entry = {
      name,
      stations: []  // Array of 8 stations
    };

    for (let s = 0; s < 8; s++) {
      const fixMatch = sec.match(new RegExp(`Fixture${s}\\s*=\\s*"([^"]*)"`));
      const offMatch = sec.match(new RegExp(`Offsets${s}\\s*=\\s*([\\d.\\-]+)\\s+([\\d.\\-]+)\\s+([\\d.\\-]+)\\s+([\\d.\\-]+)\\s+([\\d.\\-]+)\\s+([\\d.\\-]+)`));

      entry.stations.push({
        fixtureName: fixMatch ? fixMatch[1] : '',
        offsets: offMatch ? {
          x: parseFloat(offMatch[1]),
          y: parseFloat(offMatch[2]),
          z: parseFloat(offMatch[3]),
          w: parseFloat(offMatch[4]),
          v5: parseFloat(offMatch[5]),
          v6: parseFloat(offMatch[6])
        } : { x: 0, y: 0, z: 0, w: 0, v5: 0, v6: 0 }
      });
    }

    // Store first occurrence only
    if (!offsets.has(name)) {
      offsets.set(name, entry);
    }
  }

  return offsets;
}

/**
 * Parse an EPD profile cross-section database file (Profiles.epd).
 * Returns a Map keyed by MName (string) → ProfileDef object.
 * Only parses active profiles (`:PROFILE`), skips disabled (`~PROFILE`).
 *
 * ProfileDef: {
 *   name: string,
 *   width: number,        // Dimension[0] — profile width (mm)
 *   height: number,       // Dimension[1] — profile height (mm)
 *   defaultLength: number,// Dimension[2] — default bar length (mm)
 *   polygons: [{points: [{x,y,bulge?}], flags: [f1,f2,f3]}, ...]
 * }
 */
export function parseEpdFile(text) {
  const profiles = new Map();
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for :PROFILE (active) — skip ~PROFILE (disabled)
    if (line === ':PROFILE') {
      const profile = parseProfileSection(lines, i + 1);
      if (profile && profile.name) {
        if (!profiles.has(profile.name)) {
          profiles.set(profile.name, profile);
        }
      }
      i = profile ? profile._endLine : i + 1;
      continue;
    }

    // Skip ~PROFILE sections entirely
    if (line === '~PROFILE') {
      i++;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l === ':PROFILE' || l === '~PROFILE') break;
        i++;
      }
      continue;
    }

    i++;
  }

  return profiles;
}

/**
 * Parse a single :PROFILE section from an EPD file.
 * Reuses the same :DATA / P / point / E polygon parsing as fixtures.
 */
function parseProfileSection(lines, startIdx) {
  const profile = {
    name: '',
    comment: '',
    width: 0,
    height: 0,
    defaultLength: 6000,
    polygons: [],
    _endLine: startIdx
  };

  let i = startIdx;
  let inData = false;
  let currentPoly = null;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Stop at next section
    if (line === ':PROFILE' || line === '~PROFILE') {
      profile._endLine = i;
      break;
    }

    if (!inData) {
      // Parse header fields
      const nameMatch = line.match(/MName\s*=\s*"([^"]*)"/);
      if (nameMatch) profile.name = nameMatch[1];

      const commentMatch = line.match(/MComment\s*=\s*"([^"]*)"/);
      if (commentMatch) profile.comment = commentMatch[1];

      // Dimension = width height defaultLength
      const dimMatch = line.match(/Dimension\s*=\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (dimMatch) {
        profile.width = parseFloat(dimMatch[1]);
        profile.height = parseFloat(dimMatch[2]);
        profile.defaultLength = parseFloat(dimMatch[3]);
      }

      if (line === ':DATA') {
        inData = true;
      }
    } else {
      // Parse polygon data — same format as fixture :DATA
      const pMatch = line.match(/^P\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (pMatch) {
        if (currentPoly) {
          profile.polygons.push(currentPoly);
        }
        currentPoly = {
          expectedPoints: parseInt(pMatch[1]),
          flags: [parseInt(pMatch[2]), parseInt(pMatch[3]), parseInt(pMatch[4])],
          points: []
        };
        i++;
        continue;
      }

      // E 0 0 — end of data section
      if (line.startsWith('E ') || line === 'E') {
        if (currentPoly) {
          profile.polygons.push(currentPoly);
          currentPoly = null;
        }
        inData = false;
        i++;
        continue;
      }

      // Coordinate line: x y bulge(or z)
      if (currentPoly) {
        const parts = line.split(/\s+/).map(Number);
        if (parts.length >= 2 && !isNaN(parts[0])) {
          const pt = { x: parts[0], y: parts[1] };
          if (parts.length >= 3 && parts[2] !== 0) {
            pt.bulge = parts[2];
          }
          currentPoly.points.push(pt);
        }
      }
    }

    i++;
  }

  if (currentPoly) {
    profile.polygons.push(currentPoly);
  }
  if (profile._endLine === startIdx) {
    profile._endLine = i;
  }

  return profile;
}

/**
 * Parse the :CLAMPGEO section from a machine .ncm file.
 *
 * The clamp's physical geometry differs per machine (e.g. the SBZ151-2008-7m
 * has taller support/jaw boxes than the Axium). Each box line is:
 *   BoxStatic  = LX LY LZ  OX OY OZ   (fixed frame — does not move)
 *   BoxMovable = LX LY LZ  OX OY OZ   (the jaw — closes onto the profile)
 * LX/LY/LZ = box size, OX/OY/OZ = min-corner offset (same convention as
 * ncmBox() in app.js). Also reads Station 1's FixOffsetY/Z (profile support
 * offset relative to the clamp zero).
 *
 * @returns {null | { ident, boxStatic:number[][], boxMovable:number[][], fixOffsetY:number, fixOffsetZ:number }}
 */
export function parseNcmClampGeo(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*:CLAMPGEO\b/.test(lines[i])) i++;
  if (i >= lines.length) return null;
  const geo = { ident: '', boxStatic: [], boxMovable: [], fixOffsetY: 0, fixOffsetZ: 0 };
  i++;
  // Box list ends at the first :STATION / :CLAMP / next :CLAMPGEO
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*:(STATION|CLAMP|CLAMPGEO)\b/.test(ln)) break;
    const mId = ln.match(/Ident\s*=\s*"([^"]*)"/);
    if (mId) geo.ident = mId[1];
    const mBox = ln.match(/\b(BoxStatic|BoxMovable)\s*=\s*([-\d.\s]+)/);
    if (mBox) {
      const nums = mBox[2].trim().split(/\s+/).map(Number);
      if (nums.length >= 6 && nums.every(n => !isNaN(n))) {
        (mBox[1] === 'BoxStatic' ? geo.boxStatic : geo.boxMovable).push(nums.slice(0, 6));
      }
    }
  }
  // Station 1 fixture offsets (up to its first :CLAMP)
  for (; i < lines.length; i++) {
    const mY = lines[i].match(/FixOffsetY\s*=\s*([-\d.]+)/);
    const mZ = lines[i].match(/FixOffsetZ\s*=\s*([-\d.]+)/);
    if (mY) geo.fixOffsetY = Number(mY[1]);
    if (mZ) geo.fixOffsetZ = Number(mZ[1]);
    if (/^\s*:CLAMP\b/.test(lines[i])) break;
  }
  return geo;
}
