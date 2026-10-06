import {chromium} from 'playwright-core';
import fs from 'node:fs';
fs.mkdirSync('tests/out/replacements',{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.on('pageerror',e=>console.log('ERROR',e.message));page.on('console',m=>{if(m.type()==='error')console.log(m.text());});
await page.goto('http://127.0.0.1:8794');await page.waitForFunction(()=>window.cermin&&!cermin.state.characterLoading);
for(const name of ['mannequin','skeleton','male','female']){
 await page.evaluate(async n=>{cermin.man.reset();await cermin.changeCharacter(n);},name);
 console.log(name,await page.evaluate(()=>({loaded:cermin.state.character,meshes:cermin.man.avatar?.meshes.length,toast:document.getElementById('toast').textContent})));
 await page.waitForTimeout(300);await page.locator('#stage-pane').screenshot({path:`tests/out/replacements/${name}.png`});
 await page.evaluate(()=>{cermin.man.bones.LeftForeArm.rotation.z=1; cermin.man.bones.RightArm.rotation.z=.8; cermin.man.bones.LeftUpLeg.rotation.x=-.5; cermin.man.bones.LeftLeg.rotation.x=1;});
 await page.waitForTimeout(300);await page.locator('#stage-pane').screenshot({path:`tests/out/replacements/${name}-posed.png`});
}
}finally{await browser.close();}
