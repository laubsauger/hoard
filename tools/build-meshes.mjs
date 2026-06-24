// Rigged-mesh asset pipeline (T123). The source zips in src/assets/meshes ship a Meshy "Merged_Animations" GLB
// per character = ONE self-contained skinned mesh + skeleton + ALL animation clips (named: Idle_3, Walking,
// Running, push_up, …). This tool just EXTRACTS that merged GLB from each ` 2.zip` into public/meshes/<name>.glb
// — the runtime asset the player loads (AnimationMixer) and the VAT bake (zombies) consumes. No merge needed
// (Meshy already merged); we only unpack + rename to a stable, servable path.
//
// Run: node tools/build-meshes.mjs   (idempotent; re-run if the source zips change.)

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src/assets/meshes');
const OUT = join(ROOT, 'public/meshes');
const TMP = join(ROOT, 'node_modules/.cache/hbn-meshes');

// Merged source zip (in src/assets/meshes) → stable runtime GLB name. Mapped by the USER's filename intent:
// `Standard` → standard archetype, etc. (the internal Meshy model name is irrelevant to gameplay).
const TARGETS = [
  { zip: 'Meshy_AI_Character_Ranger_biped.zip', out: 'ranger.glb' },
  { zip: 'Meshy_AI_Standard_Zombie_biped.zip', out: 'zombie-standard.glb' },
  { zip: 'Meshy_AI_Bloated_Zombie_biped.zip', out: 'zombie-bloated.glb' },
  { zip: 'Meshy_AI_Runner_Zombie_biped.zip', out: 'zombie-runner.glb' },
];

function extractOne(zip, outName) {
  const work = join(TMP, outName.replace(/\.glb$/, ''));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Pull ONLY the merged-animations GLB (mesh + every clip); -j flattens the in-zip subdirectory.
  execSync(`unzip -o -j "${join(SRC, zip)}" "*Merged_Animations.glb" -d "${work}"`, { stdio: 'ignore' });
  const glb = readdirSync(work).find((f) => f.endsWith('.glb'));
  if (!glb) throw new Error(`${zip}: no *Merged_Animations.glb inside`);
  mkdirSync(OUT, { recursive: true });
  copyFileSync(join(work, glb), join(OUT, outName));
  console.log(`✓ ${outName}  ← ${zip}`);
}

if (!existsSync(SRC)) throw new Error(`source meshes dir not found: ${SRC}`);
let built = 0;
for (const t of TARGETS) {
  if (!existsSync(join(SRC, t.zip))) {
    console.warn(`skip ${t.out}: missing "${t.zip}"`);
    continue;
  }
  extractOne(t.zip, t.out);
  built++;
}
console.log(`\n${built} merged GLB(s) written to public/meshes/`);
