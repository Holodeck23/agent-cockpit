// Synthetic, bounded hook and descendant; never touches user hook state.
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const [output, mode] = process.argv.slice(2);
const log = event => fs.appendFileSync(output, JSON.stringify({...event,time:Date.now(),pid:process.pid})+'\n');
if (mode === 'child') {
  log({kind:'descendant-start'});
  setTimeout(() => log({kind:'descendant-late'}),3500);
} else {
  log({kind:'hook-start'});
  const child = spawn(process.execPath,[__filename,output,'child'],{
    detached:mode === 'detached',stdio:'ignore',
  });
  child.on('error',error => log({kind:'spawn-error',error:error.message}));
  log({kind:'descendant-spawn',childPid:child.pid,detached:mode === 'detached'});
  process.stdin.resume();
  setTimeout(() => {
    log({kind:'hook-late'});
    console.log('SYNTHETIC_LATE_HOOK_OUTPUT');
  },4500);
}
