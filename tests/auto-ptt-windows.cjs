'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { AutoPttService, WindowsPttDriver } = require('../runtime/auto-ptt.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  if (process.platform !== 'win32') { console.log('SKIP Windows PTT input checks.'); return; }
  const rootArgument = process.argv.indexOf('--app-root');
  const appRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : root;
  if (rootArgument < 0) require('../scripts/prepare-auto-ptt.cjs');
  const output = path.join(root, 'output/auto-ptt-windows'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  const name = `FreqxPttReceiver${process.pid}.exe`, executable = path.join(directory, name);
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo','/target:exe','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/out:'+executable,path.join(__dirname,'helpers/auto-ptt-receiver.cs')], { windowsHide: true });
  const receiver = spawn(executable, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const messages = [], checks = []; let buffer = '', stderr = '';
  receiver.stdout.setEncoding('utf8'); receiver.stdout.on('data', chunk => {
    buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0,end))); buffer=buffer.slice(end+1); }
  }); receiver.stderr.on('data', chunk => { stderr += chunk; });
  const command = value => receiver.stdin.write(value+'\n');
  const count = (type,down) => messages.filter(item=>item.type===type && item.down===down).length;
  async function until(predicate, name, timeout=5000) {
    const deadline=Date.now()+timeout;
    while(!predicate()) { if(receiver.exitCode!==null) throw new Error('Receiver stopped: '+stderr); if(Date.now()>deadline) throw new Error('Timeout: '+name); await pause(20); }
  }
  function check(name, condition) { assert.ok(condition,name); checks.push(name); console.log('PASS '+name); }
  async function focus() { const start=messages.length; command('focus'); await until(()=>messages.slice(start).some(item=>item.type==='focus' && item.focused),'controlled receiver focus'); }
  const driver = new WindowsPttDriver(appRoot);
  const owner={isDestroyed:()=>false,send() {}};
  const service = new AutoPttService({appRoot,driver,tuning:{leadMs:30,tailMs:40,leaseTimeoutMs:3000}});
  let watchdog;
  const settings={enabled:true,key:'F24',targetProcess:name};
  try {
    await until(()=>messages.some(item=>item.type==='ready'),'receiver startup');
    const apps = (await service.listApps()).apps;
    check('running-app discovery includes the controlled input receiver',apps.some(item=>item.processName.toLowerCase()===name.toLowerCase()) || (()=>{console.log('Fixture app:',JSON.stringify(apps.filter(item=>item.title.includes('Freqx automatic') || item.processName.startsWith('FreqxPtt'))));return false;})());
    await focus(); assert.equal((await service.configure(owner,settings)).ok,true);
    check('real Windows PTT key is pressed before playback begins',(await service.begin(owner,{id:'first',durationMs:1000})).holding);
    await until(()=>count('key',true)===1,'first keydown');
    await service.begin(owner,{id:'overlap',durationMs:1000}); await service.end(owner,'first'); await pause(100);
    check('overlapping playback keeps one keydown and does not release early',count('key',true)===1 && count('key',false)===0);
    await service.end(owner,'overlap'); await until(()=>count('key',false)===1,'final keyup');
    check('final clip end releases the real Windows key',true);
    await service.begin(owner,{id:'focus',durationMs:1000}); await until(()=>count('key',true)===2,'focus test keydown');
    command('hide'); await until(()=>service.state.status==='waiting','focus loss release');
    await focus(); command('state'); await until(()=>messages.at(-1)?.type==='state','post-focus state');
    check('focus loss releases the key and returning does not re-press',messages.at(-1).down===false && service.leases.size===0);
    await service.begin(owner,{id:'stop',durationMs:1000}); await until(()=>count('key',true)===3,'stop keydown');
    await service.releaseAll(owner); await until(()=>count('key',false)>=2,'stop keyup');
    command('down'); await until(()=>count('key',true)===4,'externally held key');
    await service.begin(owner,{id:'borrowed',durationMs:1000}); await service.end(owner,'borrowed'); await pause(150);
    const start=messages.length; command('state'); await until(()=>messages.slice(start).some(item=>item.type==='state'),'borrowed key state');
    check('an already-held key is never released by Freqx',messages.at(-1).down===true);
    command('up'); await pause(80);
    await service.configure(owner,{...settings,key:'Mouse4'}); await focus();
    command('pointer'); await until(()=>messages.at(-1)?.type==='pointer','pointer inside controlled window');
    const mouseResult=await service.begin(owner,{id:'mouse',durationMs:1000});
    if(!mouseResult.holding) console.log('Mouse PTT result:',JSON.stringify({mouseResult,state:service.state}));
    check('mouse side-button PTT is supported',mouseResult.holding);
    await until(()=>count('mouse',true)===1,'mouse down'); await service.releaseAll(owner); await until(()=>count('mouse',false)===1,'mouse up');
    check('mouse PTT release is balanced',true);
    await service.configure(owner,settings); await focus();
    const before=count('key',false);
    await service.begin(owner,{id:'eof',durationMs:1000}); service.stop();
    await until(()=>count('key',false)>before,'helper EOF releases key');
    check('helper pipe closure releases its key without renderer cleanup',true);
    command('state'); await until(()=>messages.at(-1)?.type==='state','EOF released state');
    assert.equal(messages.at(-1).down,false,'EOF must clear async key state');
    watchdog=new WindowsPttDriver(appRoot); await focus();
    watchdog.on('state',state=>console.log('Native watchdog:',state.status,state.message));
    const lost=count('key',false); const held=await watchdog.hold(settings);
    assert.equal(held.holding,true,'watchdog test must acquire a real key');
    await until(()=>count('key',false)>lost,'native heartbeat expiry',5000); watchdog.close();
    check('native watchdog releases input if the parent stops responding',true);
    fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({passed:true,checks},null,2));
    console.log(`Passed ${checks.length} Windows PTT checks.`);
  } catch(error) {
    fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({passed:false,checks,messages,stderr,error:error.stack},null,2)); throw error;
  } finally { watchdog?.close(); service.stop(); if(receiver.stdin.writable)command('close'); await pause(150); if(receiver.exitCode===null)receiver.kill(); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
