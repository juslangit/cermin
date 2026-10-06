/* Downloaded characters: validate the actual animated GLB after re-import, not
 * just its rig count. Also covers default loading, swaps, credits and failure. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const out = new URL('./out/characters/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const server = spawn('python3', ['server.py', '--no-open'], { env: { ...process.env, CERMIN_PORT: '0', BENGKEL_DATA: out + 'data' } });
let browser;
try {
  const ready = await new Promise((resolve, reject) => {
    let text = '';
    server.stdout.on('data', (data) => { text += data; const m = text.match(/@@CERMIN-READY@@(.*)/); if (m) resolve(JSON.parse(m[1])); });
    server.on('error', reject);
  });
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ready.url);
  await page.waitForFunction(() => window.cermin && !cermin.state.characterLoading);
  assert.equal(await page.locator('#character option').count(), 4);
  assert.equal(await page.locator('#character').inputValue(), 'mannequin');
  const signatures = new Set();
  for (const name of ['mannequin', 'skeleton', 'male', 'female']) {
    await page.evaluate(async name => { cermin.man.reset(); await cermin.changeCharacter(name); }, name);
    assert.equal(await page.locator('#character').inputValue(),name);
    assert.match(await page.locator('#character-credit').textContent(),/CC BY/);
    const result = await page.evaluate(async name => {
      const THREE=await import('/web/vendor/three.module.js');
      const { toGLB, buildClip } = await import('/web/export.js');
      const { BONE_NAMES } = await import('/web/solve.js');
      const { GLTFLoader } = await import('/web/vendor/GLTFLoader.js');
      const { api } = await import('/common/tool.js');
      const { man } = cermin, avatar=man.avatar;
      if(!avatar||man.root.visible)throw Error('Downloaded character missing or procedural mesh still visible');
      const q=BONE_NAMES.flatMap(()=>[0,0,0,1]),m=man.face.morphTargetInfluences.slice();
      const raised=q.slice(),crouched=q.slice();
      const set=(array,n,axis,angle)=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis),angle).toArray(array,BONE_NAMES.indexOf(n)*4);
      set(raised,'LeftForeArm',[0,0,1],1.1);set(raised,'RightArm',[0,0,1],.7);
      set(raised,'LeftHandIndex1',[0,0,1],-.5);
      for(const side of ['Left','Right']) {set(crouched,side+'UpLeg',[1,0,0],-.7);set(crouched,side+'Leg',[1,0,0],1.2);}
      const frames=[{q,hips:[0,.95,0],m},{q:raised,hips:[.12,.95,0],m},{q:crouched,hips:[.2,.6,0],m}];
      const solved={frames,fps:2},clip=buildClip(solved);
      function pose(frame) {
        BONE_NAMES.forEach((n,i)=>man.bones[n].quaternion.fromArray(frame.q,i*4));man.bones.Hips.position.fromArray(frame.hips);avatar.sync(man);
      }
      const expected=frames.map(f=>{pose(f);return Object.fromEntries(['Head','LeftHand','RightHand','LeftFoot','RightFoot'].map(n=>[avatar.map[n].name,avatar.map[n].getWorldPosition(new THREE.Vector3()).toArray()]));});
      // Export should leave the current pose alone.
      const saved=man.bones.Hips.position.clone();
      const buf=await toGLB(man,clip);
      if(man.bones.Hips.position.distanceTo(saved)>1e-7)throw Error('Export changed the source pose');
      const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,20,new DataView(buf).getUint32(12,true))));
      if(!doc.images?.length||!doc.materials?.some(m=>m.pbrMetallicRoughness?.baseColorTexture))throw Error('Textures lost in export');
      if(!doc.nodes.some(n=>n.extras?.author&&n.extras?.license==='CC-BY-4.0'))throw Error('Attribution missing from GLB');
      const gltf=await new GLTFLoader().parseAsync(buf,'');
      if(gltf.animations.length!==1)throw Error('Export animation missing');
      const mixer=new THREE.AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations[0]).play();
      let maximumError=0;
      frames.forEach((_,i)=>{
        mixer.setTime(i/2);gltf.scene.updateMatrixWorld(true);
        for(const [n,p] of Object.entries(expected[i]))maximumError=Math.max(maximumError,gltf.scene.getObjectByName(n).getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...p)));
      });
      if(maximumError>.001)throw Error(`Export differs from viewport by ${maximumError} m`);
      let importedVertices=0;gltf.scene.traverse(o=>{if(o.isMesh)importedVertices+=o.geometry.attributes.position.count;});
      const vertices=avatar.meshes.reduce((n,o)=>n+o.geometry.attributes.position.count,0);
      if(importedVertices!==vertices)throw Error('Export geometry mismatch');
      // Store the real result for Blender validation outside the browser.
      const {take}=await api('/api/take',{label:`character-${name}`});
      const response=await fetch(`/api/take-file?take=${encodeURIComponent(take)}&name=cermin.glb`,{method:'POST',headers:{'X-Bengkel-Token':window.BENGKEL_TOKEN,'Content-Type':'application/octet-stream'},body:buf});
      if(!response.ok)throw Error('Could not save test GLB');
      man.reset();avatar.sync(man);
      return {vertices,bytes:buf.byteLength,joints:doc.skins[0].joints.length,maximumError,take};
    }, name);
    signatures.add(result.vertices);
    fs.copyFileSync(out+`data/takes/${result.take}/cermin.glb`,out+`${name}.glb`);
    await page.waitForTimeout(200);
    await page.locator('#stage-pane').screenshot({path:out+name+'.png'});
    await page.evaluate(() => { cermin.man.bones.LeftForeArm.rotation.z=.8; });
    await page.evaluate(name => cermin.changeCharacter(name), name);
    assert.equal(await page.evaluate(() => cermin.man.bones.LeftForeArm.rotation.z), .8);
    await page.waitForTimeout(100);
    await page.locator('#stage-pane').screenshot({path:out+name+'-posed.png'});
    await page.evaluate(() => cermin.man.reset());
    console.log('PASS',name,result);
  }
  assert.equal(signatures.size,4);
  await page.waitForTimeout(100);await page.screenshot({path:out+'app.png'});
  await page.reload();
  await page.waitForFunction(() => window.cermin && !cermin.state.characterLoading);
  assert.equal(await page.locator('#character').inputValue(),'female');
  await page.evaluate(async () => { await Promise.all([cermin.changeCharacter('male'),cermin.changeCharacter('skeleton')]); });
  assert.equal(await page.locator('#character').inputValue(),'skeleton');
  await page.route('**/characters/male.glb', r => r.fulfill({status:503,body:'unavailable'}));
  await page.selectOption('#character','male');
  await page.waitForFunction(() => !cermin.state.characterLoading);
  assert.equal(await page.locator('#character').inputValue(),'skeleton');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS preference, rapid selection, load failure recovery, no page errors');
} finally { await browser?.close(); server.kill(); }
