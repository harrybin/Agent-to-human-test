/**
 * Q*Bert — canvas-based web game
 *
 * Controls (four diagonal directions):
 *   Q  / ArrowLeft  → upper-left   (row-1, col-1)
 *   E  / ArrowUp    → upper-right  (row-1, col  )
 *   Z  / ArrowDown  → lower-left   (row+1, col  )
 *   C  / ArrowRight → lower-right  (row+1, col+1)
 */
(function () {
  'use strict';

  /* ============================================================
     Canvas setup
  ============================================================ */
  const canvas = document.getElementById('gameCanvas');
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;   // 600
  const H      = canvas.height;  // 560

  /* ============================================================
     Pyramid geometry
     Row 0 is the apex (1 cube); row ROWS-1 is the base (ROWS cubes).
     For cube (row, col):
       cx = PYR_X + (2*col - row) * DX
       cy = PYR_Y + row * VSTEP
     Tiles fit seamlessly when SIDE_H === DY.
  ============================================================ */
  const ROWS   = 7;
  const TILE_W = 56;        // full horizontal extent of the top diamond
  const DX     = TILE_W / 2; // 28 — horizontal half-step between adjacent rows
  const DY     = 14;          // half the vertical extent of the top diamond face
  const SIDE_H = DY;          // height of the visible left/right faces (= DY → seamless)
  const VSTEP  = DY + SIDE_H; // 28 — vertical step between row centres

  const PYR_X = W / 2; // screen x of the apex tile centre
  const PYR_Y = 80;    // screen y of the apex tile centre

  /** Screen centre of a tile's top face. */
  function tilePos(row, col) {
    return {
      x: PYR_X + (2 * col - row) * DX,
      y: PYR_Y + row * VSTEP,
    };
  }

  /** True when (row, col) is a valid pyramid position. */
  function isValidTile(row, col) {
    return row >= 0 && row < ROWS && col >= 0 && col <= row;
  }

  /* ============================================================
     Flying-disc geometry
     A left  disc at logical row r is reachable by jumping
       upper-left from tile (r+1, 0)  →  ghost position (r, -1).
     A right disc at logical row r is reachable by jumping
       upper-right from tile (r+1, r+1) →  ghost position (r, r+1).
     Their screen coordinates follow the same tilePos formula.
  ============================================================ */
  function discScreenPos(disc) {
    if (disc.side === 'left') {
      // grid (disc.row, -1)
      return {
        x: PYR_X + (2 * (-1) - disc.row) * DX,
        y: PYR_Y + disc.row * VSTEP,
      };
    } else {
      // grid (disc.row, disc.row + 1)
      return {
        x: PYR_X + (2 * (disc.row + 1) - disc.row) * DX,
        y: PYR_Y + disc.row * VSTEP,
      };
    }
  }

  /* ============================================================
     Level colour palettes
     Each palette is an ordered array of tile states from default
     to target. The last entry is the "completed" colour.
  ============================================================ */
  const PALETTES = [
    // Level 1–2 : blue → yellow
    [
      { top: '#2255cc', left: '#1440aa', right: '#0a2880' },
      { top: '#e8c840', left: '#c09820', right: '#886010' },
    ],
    // Level 3–4 : dark-red → lime
    [
      { top: '#882222', left: '#661111', right: '#440808' },
      { top: '#44cc44', left: '#228822', right: '#116611' },
    ],
    // Level 5–6 : dark-purple → magenta
    [
      { top: '#552288', left: '#3a1166', right: '#220044' },
      { top: '#ee44cc', left: '#cc22aa', right: '#aa0088' },
    ],
    // Level 7–8 : two-step  (default → mid → target)
    [
      { top: '#115544', left: '#0a3a2a', right: '#052015' },
      { top: '#cc4422', left: '#aa2200', right: '#881100' },
      { top: '#e8c840', left: '#c09820', right: '#886010' },
    ],
  ];

  /* ============================================================
     Web Audio — simple chiptune sound effects
  ============================================================ */
  let _ac = null;
  function ac() {
    if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
    return _ac;
  }
  function beep(freq, dur, type = 'square', vol = 0.25) {
    try {
      const a  = ac();
      const osc = a.createOscillator();
      const g   = a.createGain();
      osc.connect(g);
      g.connect(a.destination);
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      osc.start(a.currentTime);
      osc.stop(a.currentTime + dur);
    } catch (_) {}
  }

  function sfxJump()  { beep(420, 0.04); setTimeout(() => beep(620, 0.04), 45); }
  function sfxColor() { beep(880, 0.07, 'sine'); }
  function sfxDeath() {
    beep(320, 0.09); setTimeout(() => beep(210, 0.09), 100);
    setTimeout(() => beep(110, 0.18), 210);
  }
  function sfxLevel() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'sine'), i * 130));
  }
  function sfxDisc()  {
    beep(1000, 0.05, 'sine');
    setTimeout(() => beep(1300, 0.05, 'sine'), 55);
    setTimeout(() => beep(1600, 0.08, 'sine'), 110);
  }

  /* ============================================================
     Game state
  ============================================================ */
  let G; // the single mutable game object

  function newGame() {
    G = {
      level:    1,
      lives:    3,
      score:    0,
      hiScore:  +(localStorage.getItem('qbert_hi') || 0),

      tiles:       null, // G.tiles[row][col] = state index (0…targetState)
      palette:     PALETTES[0],
      targetState: 1,

      player: makePlayer(),
      enemies: [],
      discs:   [],

      // 'title' | 'playing' | 'dying' | 'discRide' | 'levelComplete' | 'gameOver'
      phase:      'title',
      phaseTimer: 0,

      enemySpawnTimer:    90,
      enemyMoveTimer:     0,
      enemyMoveInterval:  40,

      frameCount: 0,
    };
  }

  function makePlayer() {
    const p = tilePos(0, 0);
    return {
      row: 0, col: 0,
      jumping: false,
      jumpT:   0,          // 0..1 — animation progress
      fromX: p.x, fromY: p.y - DY,
      toX:   p.x, toY:   p.y - DY,
      nr: 0, nc: 0,        // destination during a jump
      dead: false,
      deadTimer: 0,
    };
  }

  function makeTiles() {
    const t = [];
    for (let r = 0; r < ROWS; r++) {
      t[r] = [];
      for (let c = 0; c <= r; c++) t[r][c] = 0;
    }
    return t;
  }

  function makeDiscs() {
    // 4 discs: 2 per side at staggered rows
    return [
      { side: 'left',  row: 1, active: true },
      { side: 'left',  row: 4, active: true },
      { side: 'right', row: 2, active: true },
      { side: 'right', row: 5, active: true },
    ];
  }

  /* ============================================================
     Level init / respawn
  ============================================================ */
  function startLevel(lvl) {
    G.level   = lvl;
    G.tiles   = makeTiles();
    G.discs   = makeDiscs();
    G.enemies = [];

    const palIdx = Math.min(Math.floor((lvl - 1) / 2), PALETTES.length - 1);
    G.palette     = PALETTES[palIdx];
    G.targetState = G.palette.length - 1;

    G.enemyMoveInterval = Math.max(12, 42 - (lvl - 1) * 4);
    G.enemySpawnTimer   = 80;
    G.enemyMoveTimer    = 0;

    // Colour the apex tile immediately (player starts there)
    G.tiles[0][0] = Math.min(1, G.targetState);

    respawnPlayer(/*sound*/false);
    G.phase = 'playing';
  }

  function respawnPlayer(playSound = false) {
    G.player = makePlayer();
    G.enemies = [];
    G.enemySpawnTimer = 90;
    if (playSound) sfxJump();
  }

  /* ============================================================
     Helpers — tile queries
  ============================================================ */
  function allTilesTarget() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c <= r; c++)
        if (G.tiles[r][c] < G.targetState) return false;
    return true;
  }

  /* ============================================================
     Player movement
  ============================================================ */
  const JUMP_FRAMES = 14;
  const JUMP_HEIGHT = 22; // pixels of arc

  function tryMove(dr, dc) {
    if (G.player.jumping || G.player.dead) return;
    if (G.phase !== 'playing') return;

    const nr = G.player.row + dr;
    const nc = G.player.col + dc;

    const from = tilePos(G.player.row, G.player.col);
    G.player.fromX = from.x;
    G.player.fromY = from.y - DY;

    // Check for disc before checking validity
    const disc = findDisc(G.player.row, G.player.col, dr, dc);
    if (!isValidTile(nr, nc) && disc) {
      catchDisc(disc);
      return;
    }

    if (isValidTile(nr, nc)) {
      const to = tilePos(nr, nc);
      G.player.toX = to.x;
      G.player.toY = to.y - DY;
    } else {
      // Jumping off the pyramid — fall off screen
      G.player.toX = from.x + dc * DX * 3;
      G.player.toY = H + 60;
    }

    G.player.nr = nr;
    G.player.nc = nc;
    G.player.jumping = true;
    G.player.jumpT   = 0;
    sfxJump();
  }

  /* ============================================================
     Flying-disc logic
     Left  disc at row r is at ghost grid (r, -1):
       reachable by upper-left (dr=-1, dc=-1) from tile (r+1, 0).
     Right disc at row r is at ghost grid (r, r+1):
       reachable by upper-right (dr=-1, dc=0) from tile (r+1, r+1).
  ============================================================ */
  function findDisc(row, col, dr, dc) {
    if (dr === -1 && dc === -1 && col === 0) {
      // upper-left off left edge → look for left disc at row-1
      return G.discs.find(d => d.active && d.side === 'left' && d.row === row - 1) || null;
    }
    if (dr === -1 && dc === 0 && col === row) {
      // upper-right off right edge → look for right disc at row-1
      return G.discs.find(d => d.active && d.side === 'right' && d.row === row - 1) || null;
    }
    return null;
  }

  function catchDisc(disc) {
    disc.active = false;
    sfxDisc();

    const dp   = discScreenPos(disc);
    const from = tilePos(G.player.row, G.player.col);

    // Animate player flying to disc position then back to apex
    G.player.fromX   = from.x;
    G.player.fromY   = from.y - DY;
    G.player.toX     = dp.x;
    G.player.toY     = dp.y;
    G.player.jumping = true;
    G.player.jumpT   = 0;
    G.player.nr      = -99; // special sentinel: disc ride
    G.player.nc      = -99;

    G.phase      = 'discRide';
    G.phaseTimer = 0;
  }

  /* ============================================================
     Enemy system
  ============================================================ */
  function maxEnemies() {
    return 1 + Math.floor((G.level - 1) / 2);
  }

  function spawnEnemy() {
    if (G.enemies.length >= maxEnemies()) return;
    const p = tilePos(0, 0);
    G.enemies.push({
      row: 0, col: 0,
      jumping: false,
      jumpT:   0,
      fromX: p.x, fromY: p.y - DY,
      toX:   p.x, toY:   p.y - DY,
      nr: 0, nc: 0,
    });
  }

  /**
   * Move all non-animating enemies one step toward the player.
   * At the apex the enemy randomly picks left or right before chasing.
   */
  function moveEnemies() {
    const pr = G.player.row;
    const pc = G.player.col;

    for (const e of G.enemies) {
      if (e.jumping) continue;

      // Build candidate moves ordered by how much they reduce grid distance
      const candidates = [
        { dr: -1, dc: -1 }, { dr: -1, dc: 0 },
        { dr:  1, dc:  0 }, { dr:  1, dc: 1 },
      ].filter(m => isValidTile(e.row + m.dr, e.col + m.dc))
       .sort((a, b) => {
         const distA = Math.abs((e.row + a.dr) - pr) + Math.abs((e.col + a.dc) - pc);
         const distB = Math.abs((e.row + b.dr) - pr) + Math.abs((e.col + b.dc) - pc);
         return distA - distB;
       });

      let chosen;
      if (candidates.length === 0) {
        // No valid move — enemy falls off
        e.toX = e.fromX + (Math.random() < 0.5 ? -1 : 1) * DX * 3;
        e.toY = H + 60;
        e.jumping = true;
        e.jumpT   = 0;
        e.nr = -1; e.nc = -1;
        continue;
      }

      // 70 % pick the best move; 30 % pick randomly (prevents getting stuck)
      chosen = (Math.random() < 0.70 && candidates.length > 0)
        ? candidates[0]
        : candidates[Math.floor(Math.random() * candidates.length)];

      const from = tilePos(e.row, e.col);
      const to   = tilePos(e.row + chosen.dr, e.col + chosen.dc);
      e.fromX = from.x; e.fromY = from.y - DY;
      e.toX   = to.x;   e.toY   = to.y   - DY;
      e.nr    = e.row + chosen.dr;
      e.nc    = e.col + chosen.dc;
      e.jumping = true;
      e.jumpT   = 0;
    }
  }

  /* ============================================================
     Collision detection
  ============================================================ */
  function checkCollisions() {
    if (G.player.dead || G.phase !== 'playing') return;
    for (const e of G.enemies) {
      if (e.row === G.player.row && e.col === G.player.col) {
        killPlayer();
        return;
      }
    }
  }

  function killPlayer() {
    if (G.player.dead) return;
    G.player.dead = true;
    G.player.deadTimer = 0;
    G.phase      = 'dying';
    G.phaseTimer = 0;
    G.lives--;
    sfxDeath();
  }

  /* ============================================================
     Update (called every frame)
  ============================================================ */
  const PLAYER_ANIM_SPEED = 1 / JUMP_FRAMES;
  const ENEMY_ANIM_SPEED  = 1 / (JUMP_FRAMES * 1.2);

  function update() {
    G.frameCount++;

    switch (G.phase) {
      case 'title':
      case 'gameOver':
        return;

      case 'levelComplete':
        G.phaseTimer++;
        if (G.phaseTimer > 100) startLevel(G.level + 1);
        return;

      case 'dying':
        G.phaseTimer++;
        // Continue animating the fall
        if (G.player.jumping) {
          G.player.jumpT = Math.min(1, G.player.jumpT + PLAYER_ANIM_SPEED);
        }
        if (G.phaseTimer > 90) {
          if (G.lives <= 0) {
            if (G.score > G.hiScore) {
              G.hiScore = G.score;
              localStorage.setItem('qbert_hi', String(G.hiScore));
            }
            G.phase = 'gameOver';
          } else {
            respawnPlayer(true);
            G.phase = 'playing';
          }
        }
        return;

      case 'discRide':
        G.phaseTimer++;
        // Advance jump toward the disc
        if (G.player.jumping) {
          G.player.jumpT = Math.min(1, G.player.jumpT + PLAYER_ANIM_SPEED);
        }
        if (G.phaseTimer > 50) {
          // Teleport back to apex
          const p = tilePos(0, 0);
          G.player.row     = 0;
          G.player.col     = 0;
          G.player.jumping = false;
          G.player.jumpT   = 0;
          G.player.fromX = G.player.toX = p.x;
          G.player.fromY = G.player.toY = p.y - DY;
          G.phase = 'playing';
        }
        return;
    }

    // ---- phase === 'playing' ----

    // Animate player
    if (G.player.jumping) {
      G.player.jumpT = Math.min(1, G.player.jumpT + PLAYER_ANIM_SPEED);
      if (G.player.jumpT >= 1) {
        G.player.jumping = false;
        const { nr, nc } = G.player;
        if (isValidTile(nr, nc)) {
          G.player.row = nr;
          G.player.col = nc;
          landPlayer(nr, nc);
        } else {
          // Fell off — only kill if not already dying
          killPlayer();
        }
      }
    }

    // Animate enemies
    for (const e of G.enemies) {
      if (!e.jumping) continue;
      e.jumpT = Math.min(1, e.jumpT + ENEMY_ANIM_SPEED);
      if (e.jumpT >= 1) {
        e.jumping = false;
        if (isValidTile(e.nr, e.nc)) {
          e.row = e.nr;
          e.col = e.nc;
        } else {
          e.row = -1; // mark for removal
        }
      }
    }
    G.enemies = G.enemies.filter(e => e.row >= 0);

    // Check collisions after animations settle
    checkCollisions();

    // Move enemies on timer
    G.enemyMoveTimer++;
    if (G.enemyMoveTimer >= G.enemyMoveInterval) {
      G.enemyMoveTimer = 0;
      moveEnemies();
      checkCollisions();
    }

    // Spawn new enemies on timer
    G.enemySpawnTimer--;
    if (G.enemySpawnTimer <= 0) {
      spawnEnemy();
      G.enemySpawnTimer = 100 + Math.floor(Math.random() * 60);
    }
  }

  /** Called when Q*Bert successfully lands on a tile. */
  function landPlayer(row, col) {
    const cur = G.tiles[row][col];
    if (cur < G.targetState) {
      G.tiles[row][col] = cur + 1;
      G.score += 25;
      sfxColor();
    }

    if (allTilesTarget()) {
      G.score += 500 + G.lives * 100;
      if (G.score > G.hiScore) {
        G.hiScore = G.score;
        localStorage.setItem('qbert_hi', String(G.hiScore));
      }
      G.phase      = 'levelComplete';
      G.phaseTimer = 0;
      sfxLevel();
      return;
    }

    checkCollisions();
  }

  /* ============================================================
     Interpolated screen position for animated entities
  ============================================================ */
  function entityScreenPos(e, arcHeight) {
    if (e.jumping) {
      const t  = e.jumpT;
      const px = e.fromX + (e.toX - e.fromX) * t;
      const py = e.fromY + (e.toY - e.fromY) * t - Math.sin(t * Math.PI) * arcHeight;
      return { x: px, y: py };
    }
    if (isValidTile(e.row, e.col)) {
      const p = tilePos(e.row, e.col);
      return { x: p.x, y: p.y - DY };
    }
    return { x: e.fromX, y: e.fromY };
  }

  /* ============================================================
     Drawing helpers
  ============================================================ */

  /** Draw one isometric cube centred at (cx, cy). */
  function drawCube(cx, cy, topCol, leftCol, rightCol) {
    // Top face (diamond)
    ctx.beginPath();
    ctx.moveTo(cx,      cy - DY);
    ctx.lineTo(cx + DX, cy);
    ctx.lineTo(cx,      cy + DY);
    ctx.lineTo(cx - DX, cy);
    ctx.closePath();
    ctx.fillStyle = topCol;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Left face
    ctx.beginPath();
    ctx.moveTo(cx - DX, cy);
    ctx.lineTo(cx,      cy + DY);
    ctx.lineTo(cx,      cy + DY + SIDE_H);
    ctx.lineTo(cx - DX, cy + SIDE_H);
    ctx.closePath();
    ctx.fillStyle = leftCol;
    ctx.fill();
    ctx.stroke();

    // Right face
    ctx.beginPath();
    ctx.moveTo(cx + DX, cy);
    ctx.lineTo(cx,      cy + DY);
    ctx.lineTo(cx,      cy + DY + SIDE_H);
    ctx.lineTo(cx + DX, cy + SIDE_H);
    ctx.closePath();
    ctx.fillStyle = rightCol;
    ctx.fill();
    ctx.stroke();
  }

  /** Draw the entire pyramid, back-to-front for correct overlap. */
  function drawPyramid() {
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = r; c >= 0; c--) {
        const { x, y }  = tilePos(r, c);
        const state     = G.tiles[r][c];
        const cols      = G.palette[Math.min(state, G.palette.length - 1)];
        let topCol = cols.top;

        // Flash all tiles white during level-complete
        if (G.phase === 'levelComplete' && Math.floor(G.phaseTimer / 5) % 2 === 0) {
          topCol = '#ffffff';
        }

        drawCube(x, y, topCol, cols.left, cols.right);
      }
    }
  }

  /** Draw the flying discs. */
  function drawDiscs() {
    for (const disc of G.discs) {
      if (!disc.active) continue;
      const { x, y } = discScreenPos(disc);

      ctx.save();
      ctx.translate(x, y);

      // Disc base ellipse
      ctx.beginPath();
      ctx.ellipse(0, 2, 17, 7, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#00ddaa';
      ctx.fill();
      ctx.strokeStyle = '#006644';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Bubble top
      ctx.beginPath();
      ctx.ellipse(0, -3, 10, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#66ffdd';
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }
  }

  /** Draw Q*Bert at screen (x, y). */
  function drawQbert(x, y, flash) {
    const r = 12;
    // Body
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = flash ? '#ffdd88' : '#ff6600';
    ctx.fill();
    ctx.strokeStyle = '#cc3300';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Trunk / nose (curved downward-right)
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 2);
    ctx.quadraticCurveTo(x + 13, y + 5, x + 9, y + 13);
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth   = 3;
    ctx.stroke();

    // Eyes (white)
    [[-5, -5], [4, -6]].forEach(([ex, ey]) => {
      ctx.beginPath();
      ctx.arc(x + ex, y + ey, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      // Pupil
      ctx.beginPath();
      ctx.arc(x + ex + 0.8, y + ey + 0.5, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = '#222';
      ctx.fill();
    });

    // Feet
    ctx.strokeStyle = '#cc3300';
    ctx.lineWidth   = 2;
    [[-6, r], [6, r]].forEach(([fx, fy]) => {
      ctx.beginPath();
      ctx.moveTo(x + fx, y + fy);
      ctx.lineTo(x + fx - 3, y + fy + 6);
      ctx.stroke();
    });
  }

  /** Draw Coily (snake enemy) at screen (x, y). */
  function drawCoily(x, y) {
    const r = 10;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#aa2288';
    ctx.fill();
    ctx.strokeStyle = '#771166';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Red eyes
    [[-3, -3], [3, -3]].forEach(([ex, ey]) => {
      ctx.beginPath();
      ctx.arc(x + ex, y + ey, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff2222';
      ctx.fill();
    });

    // Forked tongue
    ctx.strokeStyle = '#ff2222';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + r - 1);
    ctx.lineTo(x - 1, y + r + 4);
    ctx.moveTo(x, y + r - 1);
    ctx.lineTo(x + 4, y + r + 5);
    ctx.stroke();
  }

  /** HUD — score, high score, level, lives. */
  function drawHUD() {
    ctx.font      = 'bold 14px Courier New';
    ctx.fillStyle = '#ffffff';

    ctx.textAlign = 'left';
    ctx.fillText(`SCORE: ${G.score}`, 12, 20);

    ctx.textAlign = 'right';
    ctx.fillText(`BEST: ${G.hiScore}`, W - 12, 20);

    ctx.textAlign = 'center';
    ctx.fillText(`LEVEL ${G.level}`, W / 2, 20);

    // Life hearts
    ctx.textAlign = 'left';
    ctx.font = '13px Courier New';
    ctx.fillStyle = '#ff6600';
    ctx.fillText('♥ '.repeat(G.lives).trim(), 12, 38);
  }

  /** Title / attract screen. */
  function drawTitle() {
    ctx.fillStyle = '#000033';
    ctx.fillRect(0, 0, W, H);

    // Flicker title colour
    const hue = (Date.now() / 20) % 360;
    ctx.fillStyle = `hsl(${hue},100%,60%)`;
    ctx.font      = 'bold 64px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('Q*BERT', W / 2, H / 2 - 80);

    ctx.fillStyle = '#ffcc00';
    ctx.font      = '18px Courier New';
    ctx.fillText('Classic Arcade Game', W / 2, H / 2 - 30);

    ctx.fillStyle = '#ffffff';
    ctx.font      = '16px Courier New';
    ctx.fillText('Press  SPACE  or  ENTER  to start', W / 2, H / 2 + 20);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font      = '13px Courier New';
    ctx.fillText('Q ↖   E ↗   Z ↙   C ↘', W / 2, H / 2 + 55);
    ctx.fillText('(or  ←  ↑  ↓  →  arrow keys)', W / 2, H / 2 + 74);

    if (G.hiScore > 0) {
      ctx.fillStyle = '#ffcc00';
      ctx.font      = '14px Courier New';
      ctx.fillText(`High Score: ${G.hiScore}`, W / 2, H / 2 + 108);
    }

    // Bouncing Q*Bert on title
    const bounce = Math.abs(Math.sin(Date.now() / 400)) * 12;
    drawQbert(W / 2, H / 2 - 130 + bounce, false);
  }

  /** Game-over overlay. */
  function drawGameOver() {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#ff2222';
    ctx.font      = 'bold 52px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', W / 2, H / 2 - 30);

    ctx.fillStyle = '#ffffff';
    ctx.font      = '20px Courier New';
    ctx.fillText(`Score: ${G.score}`, W / 2, H / 2 + 18);

    if (G.score > 0 && G.score >= G.hiScore) {
      ctx.fillStyle = '#ffcc00';
      ctx.font      = '15px Courier New';
      ctx.fillText('★  NEW HIGH SCORE  ★', W / 2, H / 2 + 48);
    }

    ctx.fillStyle = '#ccc';
    ctx.font      = '15px Courier New';
    ctx.fillText('Press SPACE or ENTER to play again', W / 2, H / 2 + 84);
  }

  /** Level-complete overlay. */
  function drawLevelComplete() {
    ctx.fillStyle = 'rgba(0,0,30,0.55)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#ffcc00';
    ctx.font      = 'bold 38px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('LEVEL COMPLETE!', W / 2, H / 2 - 10);

    ctx.fillStyle = '#ffffff';
    ctx.font      = '18px Courier New';
    ctx.fillText(`Bonus  +${G.lives * 100}`, W / 2, H / 2 + 34);
  }

  /* ============================================================
     Render
  ============================================================ */
  function render() {
    ctx.fillStyle = '#000820';
    ctx.fillRect(0, 0, W, H);

    if (G.phase === 'title') {
      drawTitle();
      return;
    }

    drawPyramid();
    drawDiscs();

    // Enemies
    for (const e of G.enemies) {
      const { x, y } = entityScreenPos(e, JUMP_HEIGHT * 0.8);
      drawCoily(x, y);
    }

    // Player
    if (!G.player.dead || G.phaseTimer < 55) {
      const { x, y } = entityScreenPos(G.player, JUMP_HEIGHT);
      const flash = G.phase === 'dying' && Math.floor(G.phaseTimer / 5) % 2 === 0;
      drawQbert(x, y, flash);
    }

    drawHUD();

    if (G.phase === 'levelComplete') drawLevelComplete();
    if (G.phase === 'gameOver')      drawGameOver();
  }

  /* ============================================================
     Input
  ============================================================ */
  document.addEventListener('keydown', e => {
    if (G.phase === 'title' || G.phase === 'gameOver') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        newGame();
        startLevel(1);
      }
      return;
    }

    if (G.phase !== 'playing') return;

    switch (e.key) {
      case 'q': case 'Q': case 'ArrowLeft':
        e.preventDefault(); tryMove(-1, -1); break;  // upper-left
      case 'e': case 'E': case 'ArrowUp':
        e.preventDefault(); tryMove(-1,  0); break;  // upper-right
      case 'z': case 'Z': case 'ArrowDown':
        e.preventDefault(); tryMove( 1,  0); break;  // lower-left
      case 'c': case 'C': case 'ArrowRight':
        e.preventDefault(); tryMove( 1,  1); break;  // lower-right
    }
  });

  /* ============================================================
     Game loop
  ============================================================ */
  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  newGame();
  requestAnimationFrame(loop);
})();
