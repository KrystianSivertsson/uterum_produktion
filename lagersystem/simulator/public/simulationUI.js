// ============================================================================
// simulationUI.js — Playback controls, file upload, G-code viewer, and
//                    animation bridge for the elumatec SBZ151 3D simulator
// ============================================================================

import { parseAufFile, parseAufFileMultiJob } from './aufParser.js';
import { SimulationEngine } from './simulationEngine.js';

const SCRUBBER_RESOLUTION = 10000; // slider steps for smooth scrubbing

export class SimulationUI {
  constructor(machineInterface) {
    this.machine = machineInterface;
    this.engine = null;
    this.playing = false;
    this.speedMultiplier = 2;
    this.lastTimestamp = 0;
    this._scrubbing = false; // true while user is dragging the scrubber

    // Multi-job state
    this._jobs = [];              // parsed job array from parseAufFileMultiJob()
    this._currentJobIndex = 0;
    this._fullRawLines = [];      // all raw text lines from original .auf file
    this._currentFilename = '';

    // G-code viewer state
    this._rawLines = [];          // raw text lines for current job
    this._gcodeVisible = false;
    this._lineNumToSegments = {}; // map: lineNum -> [segmentIndex, ...]
    this._segToLineNum = [];      // map: segmentIndex -> lineNum
    this._activeLineEl = null;    // currently highlighted DOM element
    this._lastHighlightedLine = -1;

    this.bindUI();
  }

  bindUI() {
    // File upload
    const fileInput = document.getElementById('aufFile');
    const fileName = document.getElementById('aufFileName');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (fileName) fileName.textContent = file.name;
        const reader = new FileReader();
        reader.onload = (ev) => this.loadFile(ev.target.result, file.name);
        reader.readAsText(file, 'latin1');
      });
    }

    // Job selector dropdown
    const jobSelector = document.getElementById('jobSelector');
    if (jobSelector) {
      jobSelector.addEventListener('change', () => {
        this.selectJob(parseInt(jobSelector.value));
      });
    }

    // Transport buttons
    const btnReset = document.getElementById('simReset');
    const btnStepBack = document.getElementById('simStepBack');
    const btnPlay = document.getElementById('simPlay');
    const btnStepFwd = document.getElementById('simStepFwd');
    const btnEnd = document.getElementById('simEnd');

    if (btnReset) btnReset.addEventListener('click', () => this.reset());
    if (btnStepBack) btnStepBack.addEventListener('click', () => this.stepBack());
    if (btnPlay) btnPlay.addEventListener('click', () => this.togglePlay());
    if (btnStepFwd) btnStepFwd.addEventListener('click', () => this.stepForward());
    if (btnEnd) btnEnd.addEventListener('click', () => this.goToEnd());

    // Speed slider — continuous 0–10x
    const speedSlider = document.getElementById('simSpeed');
    const speedVal = document.getElementById('simSpeed_val');
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        const v = parseFloat(speedSlider.value);
        this.speedMultiplier = v;
        if (speedVal) {
          speedVal.textContent = v === 0 ? '0x' : v.toFixed(1) + 'x';
        }
      });
      this.speedMultiplier = parseFloat(speedSlider.value) || 2;
      if (speedVal) speedVal.textContent = this.speedMultiplier.toFixed(1) + 'x';
    }

    // Progress slider — smooth time-based scrubbing (like a video player)
    const progressSlider = document.getElementById('simProgress');
    if (progressSlider) {
      // Track drag state for smooth live preview
      progressSlider.addEventListener('mousedown', () => { this._scrubbing = true; });
      progressSlider.addEventListener('touchstart', () => { this._scrubbing = true; }, { passive: true });

      const endScrub = () => { this._scrubbing = false; };
      document.addEventListener('mouseup', endScrub);
      document.addEventListener('touchend', endScrub);

      progressSlider.addEventListener('input', () => {
        if (!this.engine) return;
        const pct = parseInt(progressSlider.value) / SCRUBBER_RESOLUTION;
        const totalTime = this.engine.totalDuration;
        this.engine.seekToTime(pct * totalTime);
        this.applyPosition();
        this.updateInfoPanel();
      });
    }

    // G-code search
    const searchInput = document.getElementById('gcodeSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this._filterGcodeLines(searchInput.value);
      });
    }

    // Reposition G-code panel on window resize
    window.addEventListener('resize', () => {
      if (this._gcodeVisible) this._positionGcodePanel();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't capture if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!this.engine) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            this._scrubByTime(1.0);
          } else {
            this.stepForward();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            this._scrubByTime(-1.0);
          } else {
            this.stepBack();
          }
          break;
        case 'Home':
          e.preventDefault();
          this.reset();
          break;
        case 'End':
          e.preventDefault();
          this.goToEnd();
          break;
        case 'g':
        case 'G':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this._toggleGcodePanel();
          }
          break;
        case 'PageDown':
          e.preventDefault();
          if (this._jobs.length > 1) {
            this.selectJob(Math.min(this._currentJobIndex + 1, this._jobs.length - 1));
          }
          break;
        case 'PageUp':
          e.preventDefault();
          if (this._jobs.length > 1) {
            this.selectJob(Math.max(this._currentJobIndex - 1, 0));
          }
          break;
      }
    });
  }

  /** Scrub forward/back by a number of seconds */
  _scrubByTime(deltaSec) {
    if (!this.engine) return;
    const current = this.engine.getElapsedTime();
    this.engine.seekToTime(current + deltaSec);
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();
  }

  _toggleGcodePanel() {
    this._gcodeVisible = !this._gcodeVisible;
    const panel = document.getElementById('gcodePanel');
    if (panel) panel.classList.toggle('visible', this._gcodeVisible);
    if (this._gcodeVisible) {
      this._positionGcodePanel();
      if (this.engine) this._highlightCurrentLine();
    }
  }

  /** Position the G-code panel right below the sim panel */
  _positionGcodePanel() {
    const simPanel = document.getElementById('simPanel');
    const gcodePanel = document.getElementById('gcodePanel');
    const timelineBar = document.getElementById('timelineBar');
    if (!simPanel || !gcodePanel) return;

    const simRect = simPanel.getBoundingClientRect();
    const topOffset = simRect.bottom + 6;
    gcodePanel.style.top = topOffset + 'px';

    // Calculate max height: from below simPanel to above timelineBar
    const timelineHeight = timelineBar ? timelineBar.getBoundingClientRect().height : 0;
    const available = window.innerHeight - topOffset - timelineHeight - 16;
    gcodePanel.style.maxHeight = Math.max(200, available) + 'px';
  }

  loadFile(text, filename) {
    this._currentFilename = filename;
    this._fullRawLines = text.split(/\r?\n/);

    // Parse into multi-job array
    this._jobs = parseAufFileMultiJob(text);
    this._currentJobIndex = 0;

    // Populate job selector dropdown
    this._populateJobSelector(this._jobs);

    // Load the first job
    this._loadJob(0, filename);
  }

  /** Populate the job selector dropdown. Shows/hides based on job count. */
  _populateJobSelector(jobs) {
    const row = document.getElementById('jobSelectorRow');
    const sel = document.getElementById('jobSelector');
    const countEl = document.getElementById('jobCount');

    if (!sel || !row) return;

    sel.innerHTML = '';

    if (jobs.length <= 1) {
      row.style.display = 'none';
      return;
    }

    row.style.display = 'flex';

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const m = job.metadata;
      const pos = m.position || (i + 1).toString();
      const prof = m.profnr || '?';
      const len = m.length ? m.length.toFixed(1) + 'mm' : '';
      const desc = m.prgDesc || m.jobDesc || '';
      let label = `${pos}: ${prof}`;
      if (len) label += ` \u2014 ${len}`;
      if (desc) label += ` (${desc})`;

      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = label;
      sel.appendChild(opt);
    }

    sel.value = 0;
    if (countEl) countEl.textContent = `${jobs.length} jobb`;
  }

  /** Switch to a specific job by index. */
  selectJob(index) {
    if (index < 0 || index >= this._jobs.length || index === this._currentJobIndex) return;

    // Stop playback
    this.playing = false;
    this.machine.setManualControlsEnabled(true);

    // Update dropdown
    const sel = document.getElementById('jobSelector');
    if (sel) sel.value = index;

    this._loadJob(index, this._currentFilename);
  }

  /**
   * Re-apply the current job's profile (cross-section + NPV position + fixtures).
   * Called after the databases finish (re)loading — e.g. the .auf was opened
   * before the EPD was ready, or the machine profile was switched — so a profile
   * that fell back to a plain box picks up its real cross-section.
   */
  reapplyCurrentProfile() {
    if (this._currentJobIndex == null || !this._jobs || !this._jobs[this._currentJobIndex]) return;
    const { metadata } = this._jobs[this._currentJobIndex];
    if (!metadata || !metadata.profnr || !this.machine.setProfile) return;
    this.machine.setProfile(metadata.profnr, metadata.length || 3000);
    const origin = this.engine && this.engine.getWorkpieceOrigin
      ? this.engine.getWorkpieceOrigin()
      : (this.engine ? this.engine.getOrigin() : null);
    if (origin && this.machine.setProfilePosition && (origin.y !== 0 || origin.z !== 0)) {
      this.machine.setProfilePosition(origin);
    }
    if (this.machine.setFixtures) this.machine.setFixtures(metadata.profnr);
    console.log(`Re-applied profile "${metadata.profnr}" after database (re)load`);
  }

  /** Load a specific job — core of loadFile, extracted for job switching. */
  _loadJob(index, filename) {
    this._currentJobIndex = index;
    const job = this._jobs[index];
    const { metadata, instructions } = job;

    this.engine = new SimulationEngine(instructions, metadata);
    this.engine.buildTimeline();

    // Slice raw lines for this job's G-code panel
    this._rawLines = this._fullRawLines.slice(job.rawLineOffset, job.rawLineOffset + job.rawLineCount);

    // Build lineNum <-> segment index mappings
    this._buildLineMappings();

    // Reset active tool tracking
    this._currentToolId = null;

    // Set profile from EPD cross-section data (or fallback to BoxGeometry)
    if (metadata.profnr && this.machine.setProfile) {
      this.machine.setProfile(metadata.profnr, metadata.length || 3000);
    } else if (metadata.length) {
      this.machine.setProfileLength(metadata.length);
    }

    // Position profile using the WORKPIECE NPV (zero point) from the .auf
    // header — the first non-zero L19/L18/L17, NOT the end-of-program reset
    // to 0 (which getOrigin() would return and leave the profile misplaced).
    const origin = this.engine.getWorkpieceOrigin
      ? this.engine.getWorkpieceOrigin()
      : this.engine.getOrigin();
    if (this.machine.setProfilePosition && (origin.y !== 0 || origin.z !== 0)) {
      this.machine.setProfilePosition(origin);
    }

    // Apply fixtures from EPO+EFD if profnr is available
    if (metadata.profnr && this.machine.setFixtures) {
      this.machine.setFixtures(metadata.profnr);
    }

    // Log tool table from .auf header and validate against NCT database
    if (metadata.tools) {
      console.log('.auf tool table:', metadata.tools);
    }
    // Validate tools against NCT — show warnings for mismatches
    const toolWarningsEl = document.getElementById('toolWarnings');
    if (toolWarningsEl) {
      toolWarningsEl.innerHTML = '';
      if (metadata.tools && this.machine.validateTools) {
        const warnings = this.machine.validateTools(metadata.tools);
        if (warnings.length > 0) {
          toolWarningsEl.innerHTML = warnings.map(w => {
            const color = w.level === 'red' ? '#ff4444' : '#ffaa00';
            const icon = w.level === 'red' ? '\u26D4' : '\u26A0\uFE0F';
            return `<div style="color:${color}">${icon} ${w.text}</div>`;
          }).join('');
        }
      }
    }

    // Update progress slider range
    const progressSlider = document.getElementById('simProgress');
    if (progressSlider) {
      progressSlider.max = SCRUBBER_RESOLUTION;
      progressSlider.value = 0;
    }

    // Reset to start
    this.engine.reset();
    this.playing = false;
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();

    // Status label — show job info for multi-job files
    const status = document.getElementById('simStatus');
    if (status) {
      if (this._jobs.length > 1) {
        const pos = metadata.position || (index + 1);
        status.textContent = `Jobb ${index + 1}/${this._jobs.length} (Pos ${pos}): ${filename} (${this.engine.totalSegments} steg)`;
      } else {
        status.textContent = `Laddad: ${filename} (${this.engine.totalSegments} steg)`;
      }
    }

    // Show the bottom timeline bar
    const timelineBar = document.getElementById('timelineBar');
    if (timelineBar) timelineBar.classList.add('visible');

    // Render and auto-show G-code panel below the sim panel
    const jobLabel = this._jobs.length > 1
      ? `${filename} [${index + 1}/${this._jobs.length}]`
      : filename;
    this._renderGcodePanel(jobLabel);
    this._gcodeVisible = true;
    const panel = document.getElementById('gcodePanel');
    if (panel) panel.classList.add('visible');
    // Defer positioning to allow DOM layout (double-rAF for reliability)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this._positionGcodePanel());
    });
  }

  _buildLineMappings() {
    this._lineNumToSegments = {};
    this._segToLineNum = [];

    if (!this.engine) return;

    for (let i = 0; i < this.engine.segments.length; i++) {
      const seg = this.engine.segments[i];
      const ln = seg.lineNum;
      this._segToLineNum[i] = ln;
      if (ln != null) {
        if (!this._lineNumToSegments[ln]) this._lineNumToSegments[ln] = [];
        this._lineNumToSegments[ln].push(i);
      }
    }
  }

  _renderGcodePanel(filename) {
    const body = document.getElementById('gcodeBody');
    const title = document.getElementById('gcodePanelTitle');
    if (!body) return;
    if (title) title.textContent = `G-KOD \u2014 ${filename}`;

    // Build set of line numbers that have segments (executable lines)
    const executableLines = new Set(Object.keys(this._lineNumToSegments).map(Number));

    // Build a map: raw file line index -> Nxxx line number
    this._rawLineToNLine = {};
    for (let i = 0; i < this._rawLines.length; i++) {
      const m = this._rawLines[i].match(/^N(\d+)/);
      if (m) this._rawLineToNLine[i] = parseInt(m[1]);
    }

    // Create DOM - use DocumentFragment for performance
    const frag = document.createDocumentFragment();
    this._lineElements = {};  // nLineNum -> DOM element

    for (let i = 0; i < this._rawLines.length; i++) {
      const raw = this._rawLines[i];
      const nLine = this._rawLineToNLine[i];
      const isExecutable = nLine != null && executableLines.has(nLine);

      const row = document.createElement('div');
      row.className = 'gcode-line';
      row.dataset.rawIdx = i;
      if (nLine != null) row.dataset.nline = nLine;

      // Line number column
      const numEl = document.createElement('span');
      numEl.className = 'gcode-linenum' + (isExecutable ? ' has-segment' : '');
      numEl.textContent = nLine != null ? `N${nLine}` : (i + 1).toString();

      // Code text column with syntax highlighting
      const textEl = document.createElement('span');
      textEl.className = 'gcode-text';
      textEl.innerHTML = this._highlightSyntax(raw);

      row.appendChild(numEl);
      row.appendChild(textEl);

      // Click to seek to this line's first segment (time-based for smoothness)
      if (isExecutable) {
        row.addEventListener('click', () => {
          const segs = this._lineNumToSegments[nLine];
          if (segs && segs.length > 0 && this.engine) {
            this.playing = false;
            const segIdx = segs[0];
            const segStartTime = segIdx > 0 ? this.engine._cumulTime[segIdx - 1] : 0;
            this.engine.seekToTime(segStartTime);
            this.applyPosition();
            this.updateInfoPanel();
            this.updatePlayButton();
          }
        });
      }

      frag.appendChild(row);

      if (nLine != null) {
        this._lineElements[nLine] = row;
      }
    }

    body.innerHTML = '';
    body.appendChild(frag);
  }

  _highlightSyntax(line) {
    let s = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/(\([^)]*\))/g, '<span class="gcode-comment">$1</span>');
    s = s.replace(/(\$\([^)]*\))/g, '<span class="gcode-comment">$1</span>');
    s = s.replace(/\b(G\d{1,3}|M\d{1,3})\b/g, '<span class="gcode-gm">$1</span>');
    s = s.replace(/(?<![A-Z])([XYZACFRS])(-?\d+\.?\d*)/g, '<span class="gcode-axis">$1$2</span>');
    s = s.replace(/\b(E[UVWABC]?-?\d+\.?\d*)/g, '<span class="gcode-register">$1</span>');
    s = s.replace(/\b(L\d+)/g, '<span class="gcode-register">$1</span>');
    return s;
  }

  _highlightCurrentLine() {
    if (!this.engine || !this._lineElements) return;

    const lineNum = this.engine.getCurrentLineNum();
    if (lineNum === this._lastHighlightedLine) return;
    this._lastHighlightedLine = lineNum;

    // Remove previous highlight
    if (this._activeLineEl) {
      this._activeLineEl.classList.remove('active');
      this._activeLineEl = null;
    }

    if (lineNum == null) return;

    const el = this._lineElements[lineNum];
    if (!el) return;

    el.classList.add('active');
    this._activeLineEl = el;

    // Scroll into view (smooth, centered)
    if (this._gcodeVisible) {
      const body = document.getElementById('gcodeBody');
      if (body) {
        const bodyRect = body.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.top < bodyRect.top + 40 || elRect.bottom > bodyRect.bottom - 40) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    // Update line info in header
    const info = document.getElementById('gcodeLineInfo');
    if (info) {
      const desc = this.engine.getCurrentDescription();
      info.textContent = `N${lineNum}: ${desc}`;
    }
  }

  _filterGcodeLines(query) {
    const body = document.getElementById('gcodeBody');
    if (!body) return;
    const lines = body.querySelectorAll('.gcode-line');
    const q = query.trim().toLowerCase();

    if (!q) {
      lines.forEach(el => { el.style.display = ''; el.classList.remove('highlight'); });
      return;
    }

    let firstMatch = null;
    lines.forEach(el => {
      const idx = parseInt(el.dataset.rawIdx);
      const raw = this._rawLines[idx] || '';
      if (raw.toLowerCase().includes(q)) {
        el.style.display = '';
        el.classList.add('highlight');
        if (!firstMatch) firstMatch = el;
      } else {
        el.style.display = 'none';
        el.classList.remove('highlight');
      }
    });

    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  togglePlay() {
    if (!this.engine) return;
    if (this.engine.paused) {
      this.engine.resume();
      this.playing = true;
    } else {
      this.playing = !this.playing;
    }
    if (this.playing) {
      this.lastTimestamp = performance.now();
      this.machine.setManualControlsEnabled(false);
    } else {
      this.machine.setManualControlsEnabled(true);
    }
    this.updatePlayButton();
  }

  reset() {
    if (!this.engine) return;
    this.engine.reset();
    this.playing = false;
    this._currentToolId = null; // Reset tool tracking
    this.machine.setManualControlsEnabled(true);
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();
  }

  stepForward() {
    if (!this.engine) return;
    this.playing = false;
    this.engine.stepForward();
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();
  }

  stepBack() {
    if (!this.engine) return;
    this.playing = false;
    this.engine.stepBack();
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();
  }

  goToEnd() {
    if (!this.engine) return;
    this.playing = false;
    this.engine.seekTo(this.engine.totalSegments - 1);
    this.applyPosition();
    this.updateInfoPanel();
    this.updatePlayButton();
  }

  /**
   * Called every frame from animate() loop.
   */
  tick(timestamp) {
    if (!this.playing || !this.engine) return;

    const dt = (timestamp - this.lastTimestamp) / 1000 * this.speedMultiplier;
    this.lastTimestamp = timestamp;

    const clampedDt = Math.min(dt, 0.5);
    this.engine.advance(clampedDt);
    this.applyPosition();
    this.updateInfoPanel();

    if (this.engine.paused || this.engine.isFinished()) {
      this.playing = false;
      this.machine.setManualControlsEnabled(true);
      this.updatePlayButton();
    }
  }

  applyPosition() {
    if (!this.engine) return;
    const pos = this.engine.getPosition();
    // Pass A/C angles to setHeadPosition for full inverse kinematics
    this.machine.setHeadPosition(pos.x, pos.y, pos.z, pos.a, pos.c);
    if (pos.clamps) {
      for (let i = 0; i < pos.clamps.length; i++) {
        this.machine.setClampPosition(i, pos.clamps[i]);
      }
    }

    // Apply tool changes — uses snapshot cache for accurate tool at any seek position
    const activeTool = this.engine.getActiveTool();
    if (activeTool && activeTool.tool !== this._currentToolId) {
      this._currentToolId = activeTool.tool;
      if (this.machine.setTool) {
        this.machine.setTool(activeTool);
      }
    }
  }

  updateInfoPanel() {
    if (!this.engine) return;

    const progressSlider = document.getElementById('simProgress');
    const progressVal = document.getElementById('simProgressVal');
    const currentOp = document.getElementById('simCurrentOp');
    const coords = document.getElementById('simCoords');
    const coordsTl = document.getElementById('simCoordsTl');
    const status = document.getElementById('simStatus');
    const segLabel = document.getElementById('simSegLabel');
    const timeLabel = document.getElementById('simTimeLabel');

    const idx = this.engine.currentIndex;
    const total = this.engine.totalSegments;
    const elapsed = this.engine.getElapsedTime();
    const totalTime = this.engine.totalDuration;

    // Smooth time-based progress slider update (skip if user is dragging)
    if (!this._scrubbing && progressSlider) {
      const pct = totalTime > 0 ? elapsed / totalTime : 0;
      progressSlider.value = Math.round(pct * SCRUBBER_RESOLUTION);
    }

    // NC line number
    const lineNum = this.engine.getCurrentLineNum();
    if (progressVal) {
      progressVal.textContent = lineNum ? `N${lineNum}` : '---';
    }

    // Segment counter
    if (segLabel) {
      segLabel.textContent = `Steg ${idx + 1} / ${total}`;
    }

    // Time display
    if (timeLabel) {
      timeLabel.textContent = `${this._fmtTimePrecise(elapsed)} / ${this._fmtTimePrecise(totalTime)}`;
    }

    if (currentOp) {
      const desc = this.engine.getCurrentDescription();
      currentOp.textContent = lineNum ? `N${lineNum}: ${desc}` : desc;
    }

    // Coordinates — update both the sim panel coords and the timeline coords
    const pos = this.engine.getPosition();
    const coordStr = `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)} A:${pos.a.toFixed(1)}\u00B0 C:${pos.c.toFixed(1)}\u00B0`;
    if (coords) coords.textContent = coordStr;
    if (coordsTl) coordsTl.textContent = coordStr;

    if (status) {
      if (this.engine.isFinished()) {
        status.textContent = 'Klar';
      } else if (this.engine.paused) {
        status.textContent = 'Pausad';
      } else if (this.playing) {
        status.textContent = 'Spelar...';
      } else {
        status.textContent = 'Stoppad';
      }
    }

    // Update G-code highlight
    this._highlightCurrentLine();
  }

  _fmtTimePrecise(seconds) {
    if (!seconds || seconds < 0) return '0:00.0';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  updatePlayButton() {
    const btn = document.getElementById('simPlay');
    if (!btn) return;
    btn.textContent = this.playing ? '\u23F8' : '\u25B6';
    btn.classList.toggle('active', this.playing);
  }

  /**
   * Public API: Load .auf code from text string.
   * Used by postMessage embedding and programmatic loading.
   */
  loadFromText(text, filename = 'embedded.auf') {
    this.loadFile(text, filename);
  }

  /**
   * Enable postMessage API for embedding in iframes.
   * Parent window can send messages to control the simulator:
   *
   * Simulation control:
   *   { type: 'LOAD_AUF', code: '...auf text...', filename: 'name.auf' }
   *   { type: 'PLAY' }
   *   { type: 'PAUSE' }
   *   { type: 'RESET' }
   *   { type: 'SEEK', progress: 0.5 }  // 0-1
   *
   * Profile offset (workpiece position relative to clamp zero):
   *   { type: 'SET_PROFILE_OFFSET', y: -51.6, z: 0 }
   *     y = PY depth into machine (mm), z = PZ height above clamp zero (mm)
   *     Default y=-51.6 (standard elumatec clamp offset). Applies immediately.
   *     → replies: { type: 'PROFILE_OFFSET_SET', profileOffset: {y,z} }
   *
   * Clamp / fixture control:
   *   { type: 'GET_CLAMP_TYPES' }
   *     → replies: { type: 'CLAMP_TYPES', types: ['C_151_Mes_U',...], active, profileOffset: {y,z} }
   *   { type: 'SET_CLAMP_TYPE', geoIdent: 'C_151_Mes_U' }
   *     → replies: { type: 'CLAMP_TYPE_SET', geoIdent, profileOffset: {y,z} }
   *   { type: 'SET_CLAMP_POSITION', index: 0-7, x: mm }
   *   { type: 'SET_FIXTURES', profnr: '...' }
   *     → replies: { type: 'FIXTURES_SET', profnr, profileOffset: {y,z} }
   *
   * profileOffset: { y: mm, z: mm } — EPO-derived offsets (PY, PZ) from clamp zero
   *   to profile/workpiece origin. Use these to position external meshes correctly.
   *
   * External meshes (3D parts from parent application):
   *   { type: 'ADD_MESH', id, vertices, indices?, normals?, uvs?, colors?, material?, transform?, name? }
   *   { type: 'ADD_GLTF', id, url, transform?, name? }
   *   { type: 'REMOVE_MESH', id }
   *   { type: 'CLEAR_MESHES' }
   *   { type: 'UPDATE_MESH_TRANSFORM', id, transform: { position?, rotation?, scale? } }
   *   { type: 'GET_MESH_IDS' }
   *
   * Simulator startup:
   *   parent receives: { type: 'READY', clampTypes: [...], activeClampType, profileOffset: {y,z} }
   */
  enablePostMessageAPI() {
    window.addEventListener('message', (e) => {
      if (!e.data || !e.data.type) return;
      switch (e.data.type) {
        case 'LOAD_AUF':
          if (e.data.code) {
            this.loadFromText(e.data.code, e.data.filename || 'embedded.auf');
            // Notify parent that file was loaded
            this._postToParent({ type: 'LOADED', segments: this.engine ? this.engine.totalSegments : 0 });
          }
          break;
        case 'PLAY':
          if (this.engine && !this.playing) {
            this.playing = true;
            this.updatePlayButton();
          }
          break;
        case 'PAUSE':
          this.playing = false;
          this.updatePlayButton();
          break;
        case 'RESET':
          if (this.engine) {
            this.engine.reset();
            this.playing = false;
            this.applyPosition();
            this.updateInfoPanel();
            this.updatePlayButton();
          }
          break;
        case 'SEEK':
          if (this.engine && typeof e.data.progress === 'number') {
            const t = e.data.progress * this.engine.totalDuration;
            this.engine.seekToTime(t);
            this.applyPosition();
            this.updateInfoPanel();
          }
          break;

        // ---- External mesh management ----
        case 'ADD_MESH':
          if (this.machine.addExternalMesh) {
            this.machine.addExternalMesh(e.data);
            this._postToParent({ type: 'MESH_ADDED', id: e.data.id });
          }
          break;
        case 'ADD_GLTF':
          if (this.machine.addExternalGLTF) {
            this.machine.addExternalGLTF(e.data).then(() => {
              this._postToParent({ type: 'MESH_ADDED', id: e.data.id });
            }).catch(err => {
              this._postToParent({ type: 'MESH_ERROR', id: e.data.id, error: err.message });
            });
          }
          break;
        case 'REMOVE_MESH':
          if (this.machine.removeExternalMesh) {
            this.machine.removeExternalMesh(e.data.id);
            this._postToParent({ type: 'MESH_REMOVED', id: e.data.id });
          }
          break;
        case 'CLEAR_MESHES':
          if (this.machine.clearExternalMeshes) {
            this.machine.clearExternalMeshes();
            this._postToParent({ type: 'MESHES_CLEARED' });
          }
          break;
        case 'UPDATE_MESH_TRANSFORM':
          if (this.machine.updateExternalMeshTransform) {
            this.machine.updateExternalMeshTransform(e.data.id, e.data.transform);
          }
          break;
        case 'GET_MESH_IDS':
          if (this.machine.getExternalMeshIds) {
            this._postToParent({ type: 'MESH_IDS', ids: this.machine.getExternalMeshIds() });
          }
          break;

        // ---- Profile offset (workpiece position relative to clamp zero) ----
        case 'SET_PROFILE_OFFSET':
          // { type: 'SET_PROFILE_OFFSET', y: -51.6, z: 0 }
          // y = PY depth into machine from clamp zero, z = PZ height above clamp zero
          if (this.machine.setProfileOffset) {
            this.machine.setProfileOffset({ y: e.data.y, z: e.data.z });
            const off = this.machine.getProfileOffset ? this.machine.getProfileOffset() : { y: 0, z: 0 };
            this._postToParent({ type: 'PROFILE_OFFSET_SET', profileOffset: off });
          }
          break;

        // ---- Clamp / fixture control ----
        case 'SET_CLAMP_TYPE':
          if (e.data.geoIdent && this.machine.setClampType) {
            this.machine.setClampType(e.data.geoIdent);
            // Reply with new profile offset so parent can reposition workpiece
            const off = this.machine.getProfileOffset ? this.machine.getProfileOffset() : { y: 0, z: 0 };
            this._postToParent({ type: 'CLAMP_TYPE_SET', geoIdent: e.data.geoIdent, profileOffset: off });
          }
          break;
        case 'GET_CLAMP_TYPES':
          if (this.machine.getClampTypes) {
            this._postToParent({
              type: 'CLAMP_TYPES',
              types: this.machine.getClampTypes(),
              active: this.machine.getActiveClampType ? this.machine.getActiveClampType() : null,
              profileOffset: this.machine.getProfileOffset ? this.machine.getProfileOffset() : { y: 0, z: 0 },
            });
          }
          break;
        case 'SET_CLAMP_POSITION':
          // Set a single clamp's X position: { index: 0-7, x: mm }
          if (e.data.index !== undefined && e.data.x !== undefined && this.machine.setClampPosition) {
            this.machine.setClampPosition(e.data.index, e.data.x);
          }
          break;
        case 'SET_FIXTURES':
          // Manually trigger fixture load for a profile number: { profnr: '...' }
          if (e.data.profnr && this.machine.setFixtures) {
            this.machine.setFixtures(e.data.profnr);
            const off2 = this.machine.getProfileOffset ? this.machine.getProfileOffset() : { y: 0, z: 0 };
            this._postToParent({ type: 'FIXTURES_SET', profnr: e.data.profnr, profileOffset: off2 });
          }
          break;

        // ---- STEP profile import + transform ----
        case 'LOAD_STEP_PROFILE':
          this._handleStepProfileMessage(e.data);
          break;
        case 'SET_STEP_TRANSFORM':
          if (this.machine.setStepTransform) {
            this.machine.setStepTransform(e.data.transform || e.data);
          }
          break;
        case 'GET_STEP_TRANSFORM':
          if (this.machine.getStepTransform) {
            this._postToParent({ type: 'STEP_TRANSFORM', ...this.machine.getStepTransform() });
          }
          break;
      }
    });

    // Periodically send position updates to parent (when playing)
    this._parentUpdateInterval = setInterval(() => {
      if (!this.engine || !this.playing) return;
      const pos = this.engine.getPosition();
      this._postToParent({
        type: 'POSITION',
        x: pos.x, y: pos.y, z: pos.z, a: pos.a, c: pos.c,
        progress: this.engine.totalDuration > 0 ? this.engine.getElapsedTime() / this.engine.totalDuration : 0,
        finished: this.engine.isFinished()
      });
    }, 100);
  }

  /**
   * Handle LOAD_STEP_PROFILE postMessage.
   * Accepts ArrayBuffer directly or base64-encoded string as fallback.
   */
  async _handleStepProfileMessage(data) {
    try {
      let buffer;
      if (data.buffer instanceof ArrayBuffer) {
        buffer = data.buffer;
      } else if (data.arrayBase64) {
        // Decode base64 → ArrayBuffer (fallback for cross-origin)
        const binary = atob(data.arrayBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        buffer = bytes.buffer;
      } else {
        throw new Error('No STEP data provided (need buffer or arrayBase64)');
      }

      const { loadStepFile } = await import('./stepLoader.js');
      const result = await loadStepFile(buffer);

      if (this.machine.setStepProfile) {
        this.machine.setStepProfile(result.group, result.boundingBox, {
          name: data.name || 'embedded.step'
        });
      }

      this._postToParent({
        type: 'STEP_PROFILE_LOADED',
        name: data.name,
        meshCount: result.meshCount,
        vertexCount: result.vertexCount
      });
    } catch (err) {
      console.error('[STEP postMessage] Failed:', err);
      this._postToParent({
        type: 'STEP_PROFILE_ERROR',
        error: err.message
      });
    }
  }

  _postToParent(msg) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  }
}
