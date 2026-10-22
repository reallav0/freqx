/* Runs production Replay UI, Recorder/Editor and audio worklets in the silent mic fixture. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
if (require.main === module) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mic-isolation.cjs'), '--replay', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

exports.install = (stats, output) => {
  const { pathToFileURL } = require('node:url');
  const state = stats.replay = { lists: 0, starts: [], stops: [], canceled: 0, acks: [], saves: [], exports: [], streams: [], files: [], catalog: 0, handlers: new Set(), sessions: new Map() };
  const bridge = window.soundmuncher, listFiles = bridge.listImportedFiles;
  bridge.listImportedFiles = async () => [...await listFiles(), ...state.files];
  bridge.getPublicLibrary = async () => { state.catalog++; return { sounds: [], source: 'bundled', sourceLabel: 'Fixture library' }; };
  bridge.listReplaySources = async () => {
    state.lists++;
    return { ok: true, processCaptureSupported: !state.unsupported, sources: [
      ...state.unsupported ? [] : [{ kind: 'desktop', id: 'desktop', label: 'Desktop audio' }, { kind: 'application', id: '42', label: 'Fixture game' }],
      { kind: 'device', id: 'fixture-headphones', label: 'Fixture headphones' },
    ] };
  };
  bridge.onReplayCaptureData = handler => { state.handlers.add(handler); return () => state.handlers.delete(handler); };
  bridge.startReplayCapture = async input => {
    const id = `replay-fixture-${state.starts.length + 1}`; state.starts.push({ ...input, id });
    if (state.defer) await new Promise(resolve => { state.finish = resolve; });
    if (state.fail) return { ok: false, error: 'Fixture capture unavailable.' };
    let sequence = 0;
    const timer = setInterval(() => {
      const samples = new Float32Array(4800 * 2);
      for (let frame = 0; frame < 4800; frame++) {
        const value = .12 * Math.sin(2 * Math.PI * 330 * (sequence * 4800 + frame) / 48000);
        samples[frame * 2] = value; samples[frame * 2 + 1] = value * .6;
      }
      const packet = { id, type: 'pcm', sequence: ++sequence, samples };
      for (const handler of state.handlers) handler(packet);
    }, 100);
    state.sessions.set(id, timer); return { ok: true, id, sampleRate: 48000, channels: 2 };
  };
  bridge.ackReplayCapture = (id, sequence) => state.acks.push({ id, sequence });
  bridge.stopReplayCapture = async id => { state.stops.push(id); clearInterval(state.sessions.get(id)); state.sessions.delete(id); return { ok: true }; };
  bridge.cancelReplayCapture = async () => { state.canceled++; return { ok: true }; };
  bridge.saveReplayClip = async input => {
    state.saves.push({ ...input, bytes: input.bytes.slice() });
    if (state.deferSave) await new Promise(resolve => { state.finishSave = resolve; });
    const file = path.join(output, `replay-saved-${state.saves.length}.wav`); fs.writeFileSync(file, input.bytes);
    const item = { path: `fixture:replay-${state.saves.length}`, name: input.name, board: 'Main', sizeBytes: input.bytes.length, fileUrl: pathToFileURL(file).href };
    state.files.push(item); return { ok: true, imported: [item] };
  };
  bridge.exportReplayClip = async input => { state.exports.push({ ...input, bytes: input.bytes.slice() }); return state.cancelExport ? { ok: false, canceled: true } : { ok: true, filePath: 'fixture.wav' }; };
};

exports.run = async ({ evaluate, until, assert, pause, getWindow, output }) => {
  const click = id => evaluate(`document.getElementById('${id}').click()`);
  const value = (id, next, event = 'change') => evaluate(`(()=>{const element=document.getElementById('${id}');element.value=${JSON.stringify(String(next))};element.dispatchEvent(new Event('${event}',{bubbles:true}));})()`);
  const buffered = async () => until(`document.getElementById('replayCapture').disabled===false`, 'rolling replay audio');
  const start = async source => { await value('replaySource', source); await click('replayStart'); await buffered(); };
  const stop = async () => { await click('replayStart'); await until(`document.getElementById('replayRecordState').textContent.includes('Buffer off')`, 'buffer stop'); await pause(50); };
  const duration = () => evaluate(`Number.parseFloat(document.getElementById('replayClipDuration').textContent)`);
  assert('Replay is idle on launch without source listing, native capture or new microphone access', await evaluate('__micTest.replay.lists===0 && __micTest.replay.starts.length===0 && __micTest.captures.length===1 && document.getElementById("replayTabBadge").hidden'));
  assert('clip name limit matches production saving', await evaluate('document.getElementById("replayName").maxLength===96'));
  await click('replayTab'); await until('__micTest.replay.lists===1 && !document.getElementById("replaySource").disabled', 'source choices');
  assert('Replay offers all desktop apps, individual app, playback device, microphones and Freqx mix', await evaluate(`(()=>{const options=Array.from(document.getElementById('replaySource').options,o=>o.value);return ['desktop:desktop','application:42','device:fixture-headphones','microphone:','microphone:fixture-mic-b','mix:'].every(value=>options.includes(value))&&!options.some(value=>value.startsWith('everything:'));})()`));
  assert('visiting Replay does not start any recording', await evaluate('__micTest.replay.starts.length===0 && __micTest.captures.length===1'));
  assert('rolling buffer offers the three bounded lengths', await evaluate('Array.from(document.getElementById("replayBuffer").options,o=>o.value).join(",")==="15,30,60"'));
  await evaluate(`document.getElementById('soundboardTab').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
  assert('keyboard tab navigation includes Replay', await evaluate('document.getElementById("replayTab").getAttribute("aria-selected")==="true" && document.activeElement.id==="replayTab"'));
  await value('replayBuffer', '15'); await start('desktop:desktop');
  assert('explicit Start uses the chosen desktop source and shows persistent recording status', await evaluate('__micTest.replay.starts.at(-1).kind==="desktop" && __micTest.replay.starts.at(-1).id && !document.getElementById("replayTabBadge").hidden && document.getElementById("replayBuffer").disabled'));
  await click('soundboardTab');
  assert('recording stays visible while Soundboard is selected', await evaluate('!document.getElementById("soundboardPage").hidden && document.getElementById("replayPage").hidden && !document.getElementById("replayTabBadge").hidden'));
  await click('discoverTab'); await until('__micTest.replay.catalog===1', 'Discover lazy catalog');
  assert('three-tab navigation preserves Discover loading and recording', await evaluate('!document.getElementById("discoverPage").hidden && document.getElementById("replayPage").hidden && !document.getElementById("replayTabBadge").hidden'));
  await click('replayTab'); await pause(600); await click('replayCapture');
  await until('!document.getElementById("replayPlay").disabled', 'captured waveform');
  const original = await duration();
  assert('Capture creates a real editable stereo waveform with native backpressure acknowledgements', original > .4 && await evaluate('__micTest.replay.acks.length>0 && document.getElementById("replayWaveform").dataset.loaded==="true" && document.getElementById("replayOut").value>0'));
  await stop();
  assert('Stop closes native recording and hides the tab badge while keeping captured audio', await evaluate('__micTest.replay.sessions.size===0 && document.getElementById("replayTabBadge").hidden && !document.getElementById("replayPlay").disabled'));
  const bounds = await evaluate(`(()=>{const r=document.getElementById('replayWaveCanvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  const pointer = getWindow().webContents;
  const from = Math.round(bounds.x + bounds.width * .25), to = Math.round(bounds.x + bounds.width * .75), y = Math.round(bounds.y + bounds.height * .5);
  pointer.sendInputEvent({ type: 'mouseMove', x: from, y }); pointer.sendInputEvent({ type: 'mouseDown', x: from, y, button: 'left', clickCount: 1 });
  pointer.sendInputEvent({ type: 'mouseMove', x: to, y, modifiers: ['leftButtonDown'] }); pointer.sendInputEvent({ type: 'mouseUp', x: to, y, button: 'left', clickCount: 1 }); await pause(100);
  assert('dragging the real waveform changes the selected range', await evaluate('Number(document.getElementById("replayIn").value)>0 && Number(document.getElementById("replayOut").value)<' + original));
  const a = Number((original * .2).toFixed(2)), b = Number((original * .8).toFixed(2));
  await value('replayIn', a); await value('replayOut', b); await click('replayTrim');
  const trimmed = await duration(); assert('numeric In/Out and Keep selection trim the actual clip', Math.abs(trimmed - (b - a)) < .011);
  await click('replayUndo'); assert('Undo restores the full capture', Math.abs(await duration() - original) < .011);
  await click('replayRedo'); assert('Redo reapplies the trim', Math.abs(await duration() - trimmed) < .011);
  await value('replayIn', trimmed * .25); await value('replayOut', trimmed * .5); await click('replayCut');
  assert('Cut selection removes only the selected range', Math.abs(await duration() - trimmed * .75) < .02);
  await click('replayReset'); assert('Reset restores the original captured clip', Math.abs(await duration() - original) < .011);
  await value('replayGain', '1.5'); await value('replayFadeIn', '.1'); await value('replayFadeOut', '.15');
  assert('volume and fade adjustments update the editor controls', await evaluate('document.getElementById("replayGainValue").textContent==="150%" && document.getElementById("replayFadeOut").value==="0.15"'));
  await click('replayUndo'); assert('Undo restores effects and their controls', await evaluate('document.getElementById("replayFadeOut").value==="0" && document.getElementById("replayGainValue").textContent==="150%"'));
  await click('replayRedo');
  await evaluate('setSoundPlaybackEnabled(false)'); await click('replayPlay');
  await until('!!replayPreviewSource', 'local replay preview');
  assert('Replay preview works with clip Hear off through local protection, outside shared mix and PTT', await evaluate('!isSoundPlaybackEnabled && __micTest.edges.filter(e=>e[0]===__micTest.id(replayPreviewSource)).every(e=>e[1]===__micTest.id(localPlaybackLimiterNode)) && __micTest.ptt.begins.length===0 && activeSoundNodes.size===0'));
  await value('replaySeek', original * .25, 'input'); await pause(50);
  assert('preview position supports seeking', await evaluate('Number(document.getElementById("replaySeek").value)>0'));
  await click('stopAllSounds'); assert('Stop all also stops local replay audition', await evaluate('replayPreviewSource===null'));
  await evaluate(`boards.push('Clips');renderBoardControls();`); await value('replayBoard','Clips'); await value('replayName','Saved moment','input');
  await evaluate('__micTest.replay.deferSave=true'); await click('replaySave'); await until('typeof __micTest.replay.finishSave==="function"','deferred replay import');
  await value('replayName','Changed later','input'); await value('replayBoard','Main');
  await evaluate('__micTest.replay.finishSave();__micTest.replay.deferSave=false');
  await until('importedLibraryItems.some(i=>i.path==="fixture:replay-1") && !document.getElementById("replaySave").disabled', 'saved replay pad');
  assert('Save keeps click-time name/board and passes a real stereo 48kHz WAV through normal import', await evaluate(`(()=>{const item=importedLibraryItems.find(i=>i.path==='fixture:replay-1'),metadata=getSoundMetadata(item),bytes=__micTest.replay.saves[0].bytes,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return metadata.name==='Saved moment'&&metadata.board==='Clips'&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&view.getUint16(22,true)===2&&view.getUint32(24,true)===48000&&view.getUint16(34,true)===16;})()`));
  await click('replayExport'); await until('__micTest.replay.exports.length===1','WAV export');
  assert('Export uses the edited WAV without adding another sound pad', await evaluate('__micTest.replay.files.length===1 && __micTest.replay.exports[0].bytes.length===__micTest.replay.saves[0].bytes.length'));
  await evaluate('__micTest.replay.cancelExport=true'); await click('replayExport'); await until('document.getElementById("replayFeedback").textContent.includes("canceled")','export cancel');
  assert('canceling export preserves the editable capture without an error', await evaluate('!document.getElementById("replayPlay").disabled && document.getElementById("replayFeedback").dataset.error==="false"'));
  for (const source of ['application:42','device:fixture-headphones']) { await start(source); await stop(); }
  assert('application and playback-device sources are passed distinctly to capture', await evaluate('__micTest.replay.starts.some(s=>s.kind==="application"&&s.id!=="desktop") && __micTest.replay.starts.some(s=>s.kind==="device")'));
  const nativeStarts = await evaluate('__micTest.replay.starts.length');
  await evaluate(`window.__replayOriginalTrack=micStream.getAudioTracks()[0];window.__fixtureMic=__micTest.captures.at(-1);window.__replayOsc=__fixtureMic.context.createOscillator();__replayOsc.frequency.value=440;window.__replayOscGain=__fixtureMic.context.createGain();__replayOscGain.gain.value=.1;__replayOsc.connect(__replayOscGain).connect(__fixtureMic.destination);__replayOsc.start();`);
  await start('microphone:'); await pause(300); await click('replayCapture'); await until('!document.getElementById("replayCapture").textContent.includes("Capturing")','microphone snapshot'); await stop();
  assert('microphone recording clones live capture and releases it without stopping the mixer mic', await evaluate('__replayOriginalTrack.readyState==="live" && __micTest.captures.length===1 && __micTest.replay.starts.length===' + nativeStarts));
  await start('microphone:fixture-mic-b'); await stop();
  assert('another microphone uses its own capture and stops that owned track', await evaluate('__micTest.captures.length===2 && __micTest.captures.at(-1).stream.getTracks().every(t=>t.readyState==="ended") && __replayOriginalTrack.readyState==="live"'));
  await start('mix:'); await stop(); assert('Freqx mix uses a cloned browser stream without native loopback', await evaluate('__micTest.replay.starts.length===' + nativeStarts + ' && mixDestination.stream.getTracks().every(t=>t.readyState==="live")'));
  await value('replaySource','desktop:desktop'); await evaluate('__micTest.replay.defer=true'); await click('replayStart');
  await until('typeof __micTest.replay.finish==="function"','pending native capture'); await click('replayStart');
  await evaluate('__micTest.replay.finish();__micTest.replay.defer=false'); await pause(150);
  assert('Cancel start retires late native sessions and leaves capture off', await evaluate('__micTest.replay.canceled>0 && __micTest.replay.sessions.size===0 && document.getElementById("replayTabBadge").hidden'));
  await evaluate('__micTest.replay.fail=true'); await click('replayStart');
  await until('document.getElementById("replayFeedback").textContent.includes("unavailable")','capture failure');
  assert('capture failure leaves a visible source error and no recording badge', await evaluate('document.getElementById("replayCaptureHelp").dataset.error==="true" && document.getElementById("replayCaptureHelp").textContent.includes("unavailable") && document.getElementById("replayTabBadge").hidden'));
  await evaluate('__micTest.replay.fail=false');
  await start('application:42');
  await evaluate(`(()=>{const id=__micTest.replay.starts.at(-1).id;for(const handler of __micTest.replay.handlers)handler({id,type:'ended',reason:'Fixture game closed.'});})()`);
  await until('document.getElementById("replayCaptureHelp").textContent.includes("game closed")', 'source disconnect');
  assert('a disconnected source closes the buffer and keeps the editable clip', await evaluate('__micTest.replay.sessions.size===0 && document.getElementById("replayTabBadge").hidden && !document.getElementById("replayPlay").disabled'));
  const lists = await evaluate('__micTest.replay.lists'); await evaluate('__micTest.replay.unsupported=true'); await click('refreshReplaySources');
  await until('__micTest.replay.lists>' + lists + ' && !document.getElementById("replaySource").disabled', 'unsupported Windows sources');
  assert('unsupported Windows builds show only available sources and a visible desktop capture explanation', await evaluate(`(()=>{const options=Array.from(document.getElementById('replaySource').options,o=>o.value);return !options.some(value=>value.startsWith('desktop:')||value.startsWith('application:'))&&options.includes('device:fixture-headphones')&&options.includes('microphone:')&&options.includes('mix:')&&document.getElementById('replayCaptureHelp').textContent.includes('20348');})()`));
  await evaluate('__micTest.replay.unsupported=false'); await click('refreshReplaySources'); await until('Array.from(document.getElementById("replaySource").options).some(o=>o.value==="desktop:desktop")','available desktop source restored');
  assert('successful source refresh clears a resolved capture availability error', await evaluate('document.getElementById("replayFeedback").dataset.error==="false" && document.getElementById("replayCaptureHelp").dataset.error==="false"'));
  const win = getWindow(); win.showInactive();
  for (const width of [1200,900]) {
    win.setSize(width,900); await pause(150); await evaluate('document.getElementById("replayPage").scrollTop=0'); await pause(100);
    fs.writeFileSync(path.join(output,`replay-${width}.png`),(await win.webContents.capturePage()).toPNG());
    assert(`Replay waveform and controls stay within the workspace at ${width}px`, await evaluate(`(()=>{const page=document.getElementById('replayPage'),wave=document.getElementById('replayWaveform').getBoundingClientRect(),bounds=page.getBoundingClientRect();return page.scrollWidth<=page.clientWidth+1&&wave.left>=bounds.left&&wave.right<=bounds.right+1;})()`));
    await evaluate('document.getElementById("replayPage").scrollTop=document.getElementById("replayPage").scrollHeight'); await pause(100);
    fs.writeFileSync(path.join(output,`replay-editor-${width}.png`),(await win.webContents.capturePage()).toPNG());
    assert(`Replay save and export controls fit the editor at ${width}px`, await evaluate(`(()=>{const button=document.getElementById('replayExport').getBoundingClientRect(),bounds=document.getElementById('replayPage').getBoundingClientRect();return button.right<=bounds.right+1&&button.bottom<=bounds.bottom;})()`));
  }
  win.hide();
  await start('desktop:desktop'); await evaluate('replayUi.destroy()'); await pause(100);
  assert('closing Replay releases recording resources without stopping the live mixer microphone', await evaluate('__micTest.replay.sessions.size===0 && document.getElementById("replayTabBadge").hidden && __replayOriginalTrack.readyState==="live"'));
  assert('Replay finishes without renderer crashes or worklet errors', await evaluate('__micTest.crashes.length===0 && __micTest.worklets.every(w=>w.errors.length===0)'));
};
