import { readFileSync } from 'fs';

const buf = readFileSync('public/models/WindFarmLab.glb');
const jsonLength = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'));

const nodes = (json.nodes || []);

function walk(idx, depth = 0) {
  const n = nodes[idx];
  if (!n) return;
  console.log(' '.repeat(depth * 2) + `[${idx}] "${n.name}"`);
  for (const child of (n.children || [])) walk(child, depth + 1);
}

console.log('=== Full node hierarchy ===');
const sceneNodes = json.scenes?.[0]?.nodes || [];
for (const root of sceneNodes) walk(root);

console.log(`\nTotal nodes: ${nodes.length}`);
