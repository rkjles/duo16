// Rebuilds the demo ROM (dev/demo.asm) and embeds it in the app
const fs = require('fs'); const path = require('path');
const { buildDemo } = require('./build_demo');
const b64 = Buffer.from(buildDemo()).toString('base64');
fs.writeFileSync(path.join(__dirname, '..', 'app', 'renderer', 'demo-rom.js'), `// "Paddle Duel": built-in two-player demo (source: dev/demo.asm)\nconst DEMO_ROM_B64 = '${b64}';\n`);
console.log('demo embedded');
