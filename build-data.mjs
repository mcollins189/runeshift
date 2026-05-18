// Bundles the nuzlocke data sets (routes/leagues/patches/encounter-tables) into
// a single data.bundle.js that exposes window.NUZ_DATA. Run with:
//   node build-data.mjs
// from the repo root after opening a fresh PowerShell session (so the Node
// install is on PATH).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Repo-root layout: build-data.mjs sits next to log.html, data.bundle.js, and
// the "nuzlocke data sets for unique cases" folder.
const DATA_ROOT = join(SCRIPT_DIR, 'nuzlocke data sets for unique cases');
const OUT_PATH = join(SCRIPT_DIR, 'data.bundle.js');

const stripBom = s => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
const norm = s => stripBom(s).replace(/\r\n/g, '\n');
const gameKey = filename => basename(filename, '.txt');

function readDir(sub) {
  const dir = join(DATA_ROOT, sub);
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.txt')) continue;
    out[gameKey(name)] = norm(readFileSync(join(dir, name), 'utf8'));
  }
  return out;
}

// Routes: lines fall into three buckets.
//   "Location|species,species,..."          → encounter line
//   "Location"                              → empty location (no encounters)
//   "--Location|key|battleType|TrainerName" → trainer marker referencing a leagues entry
// Lines starting with "#" are comments / region headers; "# --..." is a disabled marker.
function parseRoutes(raw) {
  const locations = [];
  const byName = new Map();
  const regions = [];
  let currentRegion = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      // Pull out "## Foo Region" as a region marker; ignore "# --" disabled lines.
      const headingMatch = line.match(/^#{1,6}\s*(.+?)\s*$/);
      if (headingMatch && !headingMatch[1].startsWith('--')) {
        currentRegion = headingMatch[1];
        if (!regions.includes(currentRegion)) regions.push(currentRegion);
      }
      continue;
    }

    if (line.startsWith('--')) {
      // Trainer marker: --Location|key|battleType|Name
      const stripped = line.slice(2);
      const parts = stripped.split('|').map(s => s.trim());
      const [locName, key, battleType, trainerName] = parts;
      if (!locName || !key) continue;
      const loc = ensureLoc(locations, byName, locName, currentRegion);
      loc.trainers.push({
        key, battleType: battleType || null, name: trainerName || null
      });
      continue;
    }

    // Plain location line — either with species or bare
    const parts = line.split('|');
    const locName = parts[0].trim();
    if (!locName) continue;
    const loc = ensureLoc(locations, byName, locName, currentRegion);
    if (parts.length > 1) {
      const species = parts[1].split(',').map(s => s.trim()).filter(Boolean);
      // If a location appears twice with species, merge (some files repeat).
      for (const sp of species) if (!loc.species.includes(sp)) loc.species.push(sp);
    }
  }

  return { locations, regions };
}

function ensureLoc(locations, byName, name, region) {
  let loc = byName.get(name);
  if (!loc) {
    loc = { name, region: region || null, species: [], trainers: [] };
    locations.push(loc);
    byName.set(name, loc);
  }
  return loc;
}

// Leagues: blocks separated by lines beginning with "--key|...".
// Inside a block: "==key:value" are battle modifiers; species lines are pipe-separated
// with positional fields: species|level|moves|ability|item|matchup|...|nature.
// Lines starting with "#" or "===" are section / cosmetic dividers — ignored.
function parseLeagues(raw) {
  const trainers = {};
  let cur = null;
  let section = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      // Strip leading "#" chars and possible decorative whitespace
      const cleaned = line.replace(/^#+/, '').replace(/#+$/, '').trim();
      if (cleaned && !/^-+$/.test(cleaned)) section = cleaned;
      continue;
    }
    if (/^=+$/.test(line)) continue;

    if (line.startsWith('--')) {
      const parts = line.slice(2).split('|');
      const [key, name, theme, iconAndLoc] = parts;
      let icon = null, location = null;
      if (iconAndLoc) {
        const hashIdx = iconAndLoc.indexOf('#');
        if (hashIdx >= 0) {
          icon = iconAndLoc.slice(0, hashIdx).trim() || null;
          location = iconAndLoc.slice(hashIdx + 1).trim() || null;
        } else {
          icon = iconAndLoc.trim() || null;
        }
      }
      cur = {
        key: key.trim(),
        name: (name || '').trim() || null,
        theme: (theme || '').trim() || null,
        icon, location,
        section,
        modifiers: {},
        team: []
      };
      trainers[cur.key] = cur;
      continue;
    }

    if (!cur) continue;

    if (line.startsWith('==')) {
      // ==key:value (e.g. ==items:full-restore,full-restore or ==double:true)
      const eq = line.slice(2);
      const colon = eq.indexOf(':');
      if (colon > 0) {
        const k = eq.slice(0, colon).trim();
        const v = eq.slice(colon + 1).trim();
        cur.modifiers[k] = v;
      }
      continue;
    }

    // Species line — split on | and read positional fields.
    const parts = line.split('|').map(s => s.trim());
    const [species, levelStr, movesStr, ability, item, matchup, ...rest] = parts;
    if (!species) continue;
    const member = {
      species,
      level: levelStr ? Number(levelStr) || null : null,
      moves: movesStr ? movesStr.split(',').map(m => m.trim()).filter(Boolean) : [],
      ability: ability || null,
      item: item || null,
      matchup: matchup || null,
      extra: rest.filter(Boolean) // captures nature / other trailing fields per file
    };
    cur.team.push(member);
  }

  return { trainers };
}

// Patches: organised by "--section" markers. Each section has its own positional schema;
// we tag known ones and store the rest as raw field arrays so nothing is lost.
function parsePatches(raw) {
  const sections = {};
  let curSection = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('--')) {
      curSection = line.slice(2).trim();
      if (!sections[curSection]) sections[curSection] = [];
      continue;
    }
    if (!curSection) continue;

    const fields = line.split('|').map(s => s.trim());
    const entry = decodePatchRow(curSection, fields);
    sections[curSection].push(entry);
  }

  return sections;
}

function decodePatchRow(section, fields) {
  const raw = fields;
  switch (section) {
    case 'item':
      // key|replaces|description
      return { key: raw[0] || null, replaces: raw[1] || null, description: raw[2] || null, raw };
    case 'move':
      // Two known shapes:
      //   name||power                                          (blazevolt)
      //   name|type|power|description|category|displayName     (unbound, glazed)
      return {
        name: raw[0] || null,
        type: raw[1] || null,
        power: raw[2] ? Number(raw[2]) || null : null,
        description: raw[3] || null,
        category: raw[4] || null,
        displayName: raw[5] || null,
        raw
      };
    case 'ability':
      return { name: raw[0] || null, description: raw[1] || null, raw };
    case 'pokemon':
      // Two distinct shapes coexist under "--pokemon":
      //   (A) Glazed-style form linkage:
      //         |charizard||charmander>charizard-mega-x,charizard-mega-y
      //         fields → ['', 'charizard', '', 'charmander>forms']
      //   (B) Blazevolt-style stat overrides:
      //         ,,,95,,90|butterfree
      //         fields → [',,,95,,90', 'butterfree']  (leading field is a
      //         6-position hp,atk,def,spa,spd,spe CSV; blanks = no change)
      // Discriminator: if the leading field is non-empty and parses entirely
      // as numeric-or-empty CSV, treat as a stat override.
      {
        const isStatOverride = raw[0] && /^[\d,\s]*$/.test(raw[0]) && raw[0].includes(',');
        if (isStatOverride) {
          const parts = raw[0].split(',').map(s => s.trim());
          const stats = parts.map(p => p === '' ? null : (Number(p) || null));
          return { kind: 'stat-override', species: raw[1] || null, stats, raw };
        }
        const species = raw[0] || raw[1] || null;
        const linkage = raw[3] || raw[2] || '';
        let from = null, forms = [];
        if (linkage) {
          const gt = linkage.indexOf('>');
          if (gt >= 0) {
            from = linkage.slice(0, gt).trim() || null;
            forms = linkage.slice(gt + 1).split(',').map(s => s.trim()).filter(Boolean);
          } else {
            from = linkage.trim() || null;
          }
        }
        return { kind: 'form-linkage', species, from, forms, raw };
      }
    case 'fakemon':
      // stats|displayName|key|types|spriteSource|baseForm
      return {
        stats: raw[0] ? raw[0].split(',').map(n => Number(n) || null) : [],
        displayName: raw[1] || null,
        key: raw[2] || null,
        types: raw[3] ? raw[3].split(',').map(s => s.trim()).filter(Boolean) : [],
        spriteSource: raw[4] || null,
        baseForm: raw[5] || null,
        raw
      };
    default:
      return { raw };
  }
}

// Encounter tables (USUM and any future ROM-dump encounter blocks). Format:
//   "Map: <id> - <Name> [(<SubArea>)] [/ <id> - <Name> ...]"  → header; sub-area
//      in parens is added as its own alias, and multi-map segments share the block.
//   "Table N (Day|Night):"                                    → which time slot follows
//   "Encounters (Levels A-B): Sp1 (X%), Sp2 (Y%), ..."        → the wild slots we keep
//   Everything else (SOS Slot N, Additional SOS, "(None) (0%)") is ignored.
// "X (Forme 1)" is mapped to the Alolan variant ("Alolan X") for the known set of
// Gen 1 species that received Alolan formes; non-Alolan formes have their suffix
// stripped because the rest of the app doesn't distinguish them.
function parseEncounterTables(raw) {
  const ALOLAN_FORME_1 = new Set([
    'Rattata','Raticate','Raichu','Sandshrew','Sandslash','Vulpix','Ninetales',
    'Diglett','Dugtrio','Meowth','Persian','Geodude','Graveler','Golem',
    'Grimer','Muk','Exeggutor','Marowak'
  ]);
  // byName[loc].pools is an array of { mapId, tableN, lvMin, lvMax, day:[], night:[] }.
  // Preserving per-table identity lets the renderer group by level-range so each
  // pool sums to ~100% instead of merging walking + surf + fish into one >100% list.
  const byName = {};
  const ensureLoc = (name) => {
    if (!byName[name]) byName[name] = { pools: [] };
    return byName[name];
  };
  // Current pool key: per Map block + Table number, shared across Day/Night entries
  // of the same Table within the same block.
  let curPoolKey = null;
  const poolsByKeyByLoc = {};
  const getOrCreatePool = (name, mapId, tableN, lvMin, lvMax) => {
    const loc = ensureLoc(name);
    const idx = poolsByKeyByLoc[name] = poolsByKeyByLoc[name] || {};
    const key = `${mapId}#${tableN}`;
    if (idx[key]) return idx[key];
    const pool = { mapId, tableN, lvMin, lvMax, day: [], night: [] };
    loc.pools.push(pool);
    idx[key] = pool;
    return pool;
  };
  const addEnc = (pool, tk, species, chance) => {
    const bucket = pool[tk];
    const existing = bucket.find(e => e.species === species);
    if (existing) {
      existing.chance = Math.max(existing.chance, chance);
    } else {
      bucket.push({ species, chance });
    }
  };
  const normSpecies = (s) => {
    if (!s || s === '(None)') return null;
    const m = s.match(/^(.+?)\s+\(Forme\s+\d+\)$/);
    if (m) {
      const base = m[1].trim();
      if (ALOLAN_FORME_1.has(base)) return 'Alolan ' + base;
      return base;
    }
    return s;
  };

  let currentNames = [];
  let currentMapId = null;
  let currentTableN = null;
  let currentTime = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('Map: ')) {
      currentNames = [];
      const segs = line.slice(5).split(' / ');
      currentMapId = null;
      for (const seg of segs) {
        const m = seg.match(/^(\d+)\s*-\s*(.+)$/);
        if (!m) continue;
        if (currentMapId == null) currentMapId = m[1]; // primary id for pool keys
        const full = m[2].trim();
        const par = full.match(/^(.+?)\s*\((.+?)\)\s*$/);
        if (par) {
          currentNames.push(par[1].trim());
          currentNames.push(par[2].trim());
        } else {
          currentNames.push(full);
        }
      }
      currentNames = [...new Set(currentNames)];
      currentTableN = null;
      currentTime = null;
      continue;
    }

    if (line.startsWith('Table ')) {
      const tn = line.match(/^Table\s+(\d+)/);
      const tm = line.match(/\((Day|Night)\)/);
      currentTableN = tn ? +tn[1] : null;
      currentTime = tm ? tm[1].toLowerCase() : null;
      continue;
    }

    if (line.startsWith('Encounters (')) {
      if (!currentTime || !currentNames.length || currentMapId == null || currentTableN == null) continue;
      const lv = line.match(/Levels?\s+(\d+)\s*-\s*(\d+)/);
      if (!lv) continue;
      const lvMin = +lv[1], lvMax = +lv[2];
      const after = line.slice(line.indexOf(':') + 1);
      // Lazy match: "<name> (NN%)" pairs separated by ", ". Lazy quantifier lets the
      // inner "(Forme N)" parens be absorbed into the name part before the final (NN%).
      const re = /([^,]+?)\s*\((\d+)%\)\s*(?:,|$)/g;
      const slots = [];
      let m;
      while ((m = re.exec(after)) !== null) {
        const speciesRaw = m[1].trim();
        const chance = +m[2];
        if (!chance) continue;
        const species = normSpecies(speciesRaw);
        if (!species) continue;
        slots.push({ species, chance });
      }
      if (!slots.length) continue;
      for (const name of currentNames) {
        const pool = getOrCreatePool(name, currentMapId, currentTableN, lvMin, lvMax);
        // Update lv range in case Day and Night entries differ (Day usually equals Night for level).
        pool.lvMin = Math.min(pool.lvMin, lvMin);
        pool.lvMax = Math.max(pool.lvMax, lvMax);
        for (const s of slots) addEnc(pool, currentTime, s.species, s.chance);
      }
    }
  }

  return { byName };
}

function buildBundle() {
  console.log(`[build-data] reading from ${DATA_ROOT}`);
  const routesRaw = readDir('routes');
  const leaguesRaw = readDir('leagues');
  const patchesRaw = readDir('patches');
  const encTablesRaw = readDir('encounter-tables');

  const routes = {};
  for (const [k, v] of Object.entries(routesRaw)) routes[k] = parseRoutes(v);
  const leagues = {};
  for (const [k, v] of Object.entries(leaguesRaw)) leagues[k] = parseLeagues(v);
  const patches = {};
  for (const [k, v] of Object.entries(patchesRaw)) patches[k] = parsePatches(v);
  const encounterTables = {};
  for (const [k, v] of Object.entries(encTablesRaw)) encounterTables[k] = parseEncounterTables(v);

  // Cross-reference: for each routes file, attempt to resolve each trainer marker
  // to a matching league entry by key. Records the source game's leagues file as
  // a hint (only the same-named file is auto-linked; cross-game references are left null).
  for (const [game, data] of Object.entries(routes)) {
    const leagueData = leagues[game];
    for (const loc of data.locations) {
      for (const t of loc.trainers) {
        t.resolved = leagueData?.trainers?.[t.key] ? true : false;
      }
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    routeFiles: Object.keys(routes).sort(),
    leagueFiles: Object.keys(leagues).sort(),
    patchFiles: Object.keys(patches).sort(),
    encounterTableFiles: Object.keys(encounterTables).sort()
  };

  const payload = { meta, routes, leagues, patches, encounterTables };
  const js = `// Auto-generated by build-data.mjs — DO NOT EDIT BY HAND.\n`
    + `// Generated: ${meta.generatedAt}\n`
    + `window.NUZ_DATA = ${JSON.stringify(payload)};\n`;
  writeFileSync(OUT_PATH, js, 'utf8');

  const sizeKb = (Buffer.byteLength(js, 'utf8') / 1024).toFixed(1);
  console.log(`[build-data] wrote ${OUT_PATH} (${sizeKb} KB)`);
  console.log(`[build-data] route files: ${meta.routeFiles.length}, league files: ${meta.leagueFiles.length}, patch files: ${meta.patchFiles.length}, encounter-table files: ${meta.encounterTableFiles.length}`);
}

buildBundle();
