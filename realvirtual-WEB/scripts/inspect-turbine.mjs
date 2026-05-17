import { readFileSync } from 'fs';

const buf = readFileSync('public/models/animated_wind_turbine.glb');
const jsonLength = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'));

const nodes = (json.nodes || []);

function walk(idx, depth = 0) {
  const n = nodes[idx];
  if (!n) return;
  const rot = n.rotation ? (' rot=' + JSON.stringify(n.rotation.map(v => +v.toFixed(4)))) : '';
  const tr  = n.translation ? (' pos=' + JSON.stringify(n.translation.map(v => +v.toFixed(2)))) : '';
  console.log(' '.repeat(depth * 2) + `[${idx}] "${n.name}"` + tr + rot);
  for (const child of (n.children || [])) walk(child, depth + 1);
}

console.log('=== animated_wind_turbine.glb — node hierarchy ===');
const sceneNodes = json.scenes?.[0]?.nodes || [];
for (const root of sceneNodes) walk(root);

console.log(`\nTotal nodes: ${nodes.length}`);

// Also list animations
if (json.animations?.length) {
  console.log('\n=== Animations ===');
  for (const anim of json.animations) {
    console.log(' -', anim.name, '| channels:', anim.channels?.length);
    for (const ch of (anim.channels || [])) {
      const target = ch.target;
      const nodeName = nodes[target.node]?.name ?? '?';
      console.log('    node:', nodeName, '| path:', target.path);
    }
  }
}
