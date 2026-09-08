// Uses synthetic camera + microphone only; never opens a real capture device or API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { chromium } = require('playwright');

let browser, server, url;
const liveId='__framing_check__';
before(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import Teleprompter from './app/project/[id]/Teleprompter';
        const root=createRoot(document.getElementById('root'));
        root.render(<React.StrictMode><Teleprompter script="Тестовый текст НЕ должен попасть в видео"
          onClose={()=>root.unmount()} onRecorded={blob=>{window.savedTake=blob;root.unmount()}} /></React.StrictMode>);`,
      loader: 'tsx', resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const js = result.outputFiles[0].text;
  const css = fs.readFileSync('app/globals.css', 'utf8');
  server = http.createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('content-type','text/javascript'); res.end(js); }
    else { res.setHeader('content-type','text/html'); res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  if (process.env.CAPTURE_SITE_URL) url = `${process.env.CAPTURE_SITE_URL.replace(/\/$/,'')}/project/${liveId}`;
  const installed = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p))
    : undefined;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CAPTURE_BROWSER || installed,
    args: ['--autoplay-policy=no-user-gesture-required',
      ...(process.env.CAPTURE_HOST_RULES ? [`--host-resolver-rules=${process.env.CAPTURE_HOST_RULES}`] : [])] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

async function openCamera(width, height, viewport, fallback = false) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const errors = [];
  const uploads=[];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.CAPTURE_SITE_URL) {
    const project={id:liveId,topic:'Проверка кадра 9:16',script:'Тестовый текст НЕ должен попасть в видео',rawVideo:null,processedVideo:null,processing:{state:'idle'},publications:[],meta:null};
    // All API requests are intercepted: this live-UI check cannot modify real projects,
    // upload footage, start paid processing or publish anything.
    await page.route('**/api/**', async route=>{
      const request=route.request();const pathname=new URL(request.url()).pathname;
      if (pathname===`/api/projects/${liveId}` && request.method()==='GET') return route.fulfill({json:project});
      if (pathname===`/api/projects/${liveId}/upload` && request.method()==='PUT') {
        uploads.push(request.postDataBuffer());project.rawVideo='record.mp4';
        return route.fulfill({json:{received:Number(request.headers()['x-offset']||0)+request.postDataBuffer().length,uploadedSize:Number(request.headers()['x-file-size'])}});
      }
      if(request.method()!=='GET') errors.push(`Unexpected mutation blocked: ${request.method()} ${pathname}`);
      await route.fulfill({json:{}});
    });
  }
  await page.addInitScript(({ width, height, fallback }) => {
    if (fallback) HTMLVideoElement.prototype.requestVideoFrameCallback = undefined;
    window.testStreams = [];
    window.sourceFrames = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width=width; canvas.height=height;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const audio = new AudioContext(); const oscillator=audio.createOscillator(); const dest=audio.createMediaStreamDestination();
      oscillator.frequency.value=440; oscillator.connect(dest); oscillator.start();
      await audio.resume(); stream.addTrack(dest.stream.getAudioTracks()[0]);
      window.testStreams.push(stream);
      const cropWidth=Math.min(width,height*9/16), cropHeight=Math.min(height,width*16/9);
      const left=(width-cropWidth)/2, top=(height-cropHeight)/2;
      function paint() {
        if (stream.getVideoTracks()[0].readyState==='ended') { void audio.close(); return; }
        ctx.fillStyle='#777';ctx.fillRect(0,0,width,height);
        for(const [x,y,color] of [[.08,.12,'#f00'],[.77,.12,'#0f0'],[.08,.72,'#00f'],[.77,.72,'#ff0']]) {
          ctx.fillStyle=color;ctx.fillRect(left+x*cropWidth,top+y*cropHeight,.15*cropWidth,.15*cropHeight);
        }
        ctx.fillStyle=Math.floor(performance.now()/250)%2?'#fff':'#000';
        ctx.fillRect(left+.4*cropWidth,top+.45*cropHeight,.2*cropWidth,.1*cropHeight);
        window.sourceFrames++;requestAnimationFrame(paint);
      }
      paint(); return stream;
    };
  }, { width, height, fallback });
  await page.goto(url);
  if (process.env.CAPTURE_SITE_URL) {
    await page.getByRole('button',{name:/2\. Съёмка/}).click();
    await page.getByRole('button',{name:/Записать с телесуфлёром/}).click();
  }
  await page.getByRole('button', { name: 'Начать запись' }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Начать запись')).disabled);
  return { page, errors, uploads };
}

for (const [name,width,height,viewport,fallback] of [
  ['phone native 9:16',1080,1920,{width:390,height:844},false],
  ['phone 3:4',1440,1920,{width:390,height:664},false],
  ['desktop 16:9 + rAF fallback',1920,1080,{width:1280,height:720},true],
]) {
  test(`${name}: preview → recorded file preserves crop, orientation, movement and audio`, {timeout:60000}, async () => {
    const { page, errors, uploads } = await openCamera(width,height,viewport,fallback);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gudini-capture-'));
    try {
      const geometry=await page.evaluate(()=>{
        const frame=document.querySelector('.tp-frame').getBoundingClientRect();
        return {width:frame.width,height:frame.height,top:frame.top,bottom:frame.bottom,
          topEnd:document.querySelector('.tp-top').getBoundingClientRect().bottom,
          bottomStart:document.querySelector('.tp-bottom').getBoundingClientRect().top};
      });
      assert.ok(Math.abs(geometry.width/geometry.height-9/16)<.002);
      assert.ok(geometry.top>=geometry.topEnd-.1 && geometry.bottom<=geometry.bottomStart+.1,'controls never cover the frame');
      if (process.env.CAPTURE_SCREENSHOT && name === 'phone 3:4') await page.screenshot({path:path.resolve(process.env.CAPTURE_SCREENSHOT)});
      const sample=()=>page.evaluate(()=>{
        const ctx=document.querySelector('canvas.tp-canvas').getContext('2d');
        return [[.15,.19],[.84,.19],[.15,.79],[.84,.79]].map(([x,y])=>[...ctx.getImageData(x*1080,y*1920,1,1).data].slice(0,3));
      });
      const reference=await sample();
      const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
      reference.forEach((rgb,i)=>rgb.forEach((value,c)=>assert.ok(Math.abs(value-colors[i][c])<20,'visible crop/mirror is wrong')));
      await page.getByRole('button',{name:'Начать запись'}).click();
      const started=await page.evaluate(()=>performance.now());
      await page.waitForFunction(start=>performance.now()-start>2000,started);
      await page.getByRole('button',{name:'Остановить запись'}).click();
      await page.locator('video.tp-playback').waitFor();
      await page.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
      const encoded=await page.locator('video.tp-playback').evaluate(async video=>{
        const bytes=new Uint8Array(await (await fetch(video.src)).arrayBuffer());
        let binary=''; for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        return btoa(binary);
      });
      const file=path.join(dir,'take.mp4');fs.writeFileSync(file,Buffer.from(encoded,'base64'));
      const metadata=JSON.parse(execFileSync(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
      const video=metadata.streams.find(s=>s.codec_type==='video');
      assert.equal(video.width,1080);assert.equal(video.height,1920);
      assert.ok(metadata.streams.some(s=>s.codec_type==='audio'),'microphone audio missing');
      for(const at of [.15,.65,1.15]) {
        const pixels=execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-ss',String(at),'-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:8*1024*1024});
        assert.equal(pixels.length,1080*1920*3,`missing frame at ${at}: ${JSON.stringify(video)}`);
        [[.15,.19],[.84,.19],[.15,.79],[.84,.79]].forEach(([x,y],i)=>{
          const offset=(Math.floor(y*1920)*1080+Math.floor(x*1080))*3;
          reference[i].forEach((value,c)=>assert.ok(Math.abs(value-pixels[offset+c])<30,`recorded marker ${i} moved or mirrored`));
        });
      }
      // Compare decoded frames themselves; the recorded stream must contain motion.
      const hashes=execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-i',file,'-vf','crop=200:100:440:910,fps=8','-an','-f','framemd5','-'],{encoding:'utf8'});
      assert.ok(new Set(hashes.split('\n').filter(l=>/^0,/.test(l)).map(l=>l.split(',').at(-1).trim())).size>1,'recording is frozen');
      if(name==='phone 3:4') {
        await page.getByRole('button',{name:'Перезаписать'}).click();
        await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Начать запись')).disabled);
        await page.getByRole('button',{name:'Закрыть',exact:true}).click();
        await page.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
      } else {
        await page.getByRole('button',{name:'Использовать запись'}).click();
        if(process.env.CAPTURE_SITE_URL) {
          await page.getByRole('heading',{name:/Автомонтаж/}).waitFor();
          assert.ok(Buffer.concat(uploads).equals(Buffer.from(encoded,'base64')),'the upload must contain exactly the reviewed file');
        } else assert.ok(await page.evaluate(()=>window.savedTake.size>0));
      }
      assert.deepEqual(errors,[]);
    } finally {
      await page.close();
      assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('gudini-capture-'));
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
}

test('failed canvas cannot be re-enabled by a camera unmute event', {timeout:30000}, async () => {
  const { page, errors } = await openCamera(1080,1920,{width:390,height:844});
  try {
    await page.evaluate(()=>{
      document.querySelector('canvas.tp-canvas').getContext('2d').drawImage=()=>{throw new Error('test drawing failure')};
    });
    await page.getByRole('alert').filter({hasText:'test drawing failure'}).waitFor();
    await page.evaluate(()=>window.testStreams.forEach(stream=>stream.getTracks().forEach(track=>track.dispatchEvent(new Event('unmute')))));
    assert.ok(await page.getByRole('button',{name:'Начать запись'}).isDisabled());
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    await page.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test('microphone recovery cannot enable recording while the source camera is still muted', {timeout:30000}, async () => {
  const { page, errors } = await openCamera(1080,1920,{width:390,height:844});
  try {
    await page.evaluate(()=>{
      window.activeSource=window.testStreams.find(s=>s.getVideoTracks()[0].readyState==='live');
      for(const track of window.activeSource.getTracks()) {
        Object.defineProperty(track,'muted',{value:true,configurable:true});track.dispatchEvent(new Event('mute'));
      }
    });
    await page.getByRole('alert').waitFor();
    await page.evaluate(()=>{
      const track=window.activeSource.getAudioTracks()[0];
      Object.defineProperty(track,'muted',{value:false,configurable:true});track.dispatchEvent(new Event('unmute'));
    });
    assert.ok(await page.getByRole('button',{name:'Начать запись'}).isDisabled());
    await page.evaluate(()=>{
      const track=window.activeSource.getVideoTracks()[0];
      Object.defineProperty(track,'muted',{value:false,configurable:true});track.dispatchEvent(new Event('unmute'));
    });
    await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Начать запись')).disabled);
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    await page.waitForFunction(()=>window.testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});
