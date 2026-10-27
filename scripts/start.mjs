import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env };
// Some Electron-based terminals export this for their own Node subprocesses.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
