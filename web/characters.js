/* Licensed Sketchfab characters. Retarget the capture onto each original rig;
 * keep its proportions, authored skin weights, materials and textures. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { restPositions } from './mannequin.js';

export const CHARACTERS = ['mannequin', 'skeleton', 'male', 'female'];
export const CHARACTER_INFO = {
  mannequin: { author: 'James Wright', title: 'Wooden Mannequin (Lay Figure)', uid: 'f119f296833e4d4d9a8fc24dfc0533d6', fingers: false },
  skeleton: { author: 'Void', title: 'Lowpoly Human Skeleton', uid: '08ab10e2a78549ab86e1b6129678b3aa', fingers: true },
  male: { author: 'Bogdan Strielecki', title: 'Casual Man Character', uid: '05d9dd5bdddd4157bd46dc179781ee6e', fingers: true },
  female: { author: 'Guilherme Alves', title: 'Female Character stylized', uid: '6916dc24a76944b7abdcf598bb0eef76', fingers: true },
};
const V = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const Q = () => new THREE.Quaternion();
const rest = restPositions();

function boneMap(name, bones) {
  const map = {};
  const find = (pattern) => bones.find(b => typeof pattern === 'string' ? b.name === pattern : pattern.test(b.name));
  const add = (semantic, pattern) => { const b=find(pattern); if(b)map[semantic]=b; };
  if (name==='female') {
    for(const b of bones) {
      const m=b.name.match(/^Character1_(.+)_\d+$/);
      if(m && rest[m[1]]) map[m[1]]=b;
    }
    // This asset weights the whole head to Neck; Head is an unused end marker.
    map.HeadTip=map.Head; map.Head=map.Neck; delete map.Neck;
    add('UpperChest', /^Character1_Spine3_/);
  } else if(name==='male') {
    for(const [key,part] of Object.entries({Hips:'Pelvis',Spine:'Spine1',Spine1:'Spine2',Spine2:'Spine3',UpperChest:'Spine4',Ribcage:'Ribcage',Neck:'Neck1',Head:'Head'})) add(key,new RegExp(`^Base_Human${part}_\\d+$`));
    for(const [side,s] of [['Left','L'],['Right','R']]) {
      for(const [key,part] of Object.entries({Shoulder:'Collarbone',Arm:'Upperarm',ForeArm:'Forearm',Hand:'Palm',UpLeg:'Thigh',Leg:'Calf',Foot:'Foot',ToeBase:'Digit11'})) add(side+key,new RegExp(`^Base_Human${s}${part}_\\d+$`));
      for(const [f,d] of [['Thumb','1'],['Index','2'],['Middle','3'],['Ring','4'],['Pinky','5']]) for(let k=1;k<=3;k++) {
        const digits=f==='Thumb'?(k<3?`1${k}1`:'13'):`${d}${k}`;
        add(`${side}Hand${f}${k}`,new RegExp(`^Base_Human${s}Digit${digits}_\\d+$`));
      }
    }
  } else if(name==='mannequin') {
    add('Hips','waist_00');add('Spine2','body_01');add('Head','head_02');
    for(const [side,s] of [['Left','l'],['Right','r']]) for(const [key,part] of Object.entries({Arm:'shoulder',ForeArm:'forearm',Hand:'hand',UpLeg:'thigh',Leg:'shin',Foot:'ankle',ToeBase:'foot'}))add(side+key,new RegExp(`^${s}_${part}_\\d+$`));
  } else {
    for(const [key,n] of [['Hips','019'],['Spine','020'],['Spine1','021'],['Spine2','022'],['Neck','023'],['Head','024']])add(key,new RegExp(`^Bone${n}_`));
    for(const side of ['Left','Right']) {
      const suffix=side==='Left'?'\\(mirrored\\)':'';
      for(const [key,n] of [['Shoulder','025'],['Arm','001'],['ForeArm','002'],['Hand','003']])add(side+key,new RegExp(`^Bone${n}${suffix}_`));
      for(const [f,start] of [['Thumb',4],['Index',7],['Middle',10],['Ring',13],['Pinky',16]])for(let k=1;k<=3;k++)add(`${side}Hand${f}${k}`,new RegExp(`^Bone${String(start+k-1).padStart(3,'0')}${suffix}_`));
      const s=side==='Left'?'R':'L';add(side+'UpLeg',new RegExp(`^bone_Leg_${s}_thig_`));add(side+'Leg',new RegExp(`^bone_Leg_${s}_calf_`));add(side+'Foot',new RegExp(`^bone_${s}_foot_`));
    }
  }
  for(const n of ['Hips','Head','LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'])if(!map[n])throw new Error(`${name}: missing ${n} in the character rig.`);
  return map;
}

function worldQuaternion(bone, world) {
  bone.parent.updateWorldMatrix(true,false);
  bone.quaternion.copy(bone.parent.getWorldQuaternion(Q()).invert().multiply(world));
  bone.updateWorldMatrix(false,true);
}
function point(bone) { return bone.getWorldPosition(V()); }
function aim(bone,child,direction) {
  if(!bone || !child)return;
  const from=point(child).sub(point(bone));if(from.length()<1e-5)return;
  const turn=Q().setFromUnitVectors(from.normalize(),direction.clone().normalize());
  worldQuaternion(bone,turn.multiply(bone.getWorldQuaternion(Q())));
}
function basis(primary,secondary) {
  const x=primary.clone().normalize(),y=secondary.clone().addScaledVector(x,-secondary.dot(x)).normalize(),z=x.clone().cross(y).normalize();
  return Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
}

export async function loadCharacter(name) {
  if(!CHARACTERS.includes(name))throw new Error('Unknown character.');
  const gltf=await new GLTFLoader().loadAsync(`/web/characters/${name}.glb`);
  const asset=gltf.scene, bones=[], meshes=[];
  asset.traverse(o=>{
    if(o.isBone)bones.push(o);
    if(o.isMesh){
      o.castShadow=true;o.frustumCulled=false;meshes.push(o);
      if(name==='female') for(const material of Array.isArray(o.material)?o.material:[o.material]) {
        // Sketchfab marks the entire opaque body as BLEND. Use the texture's
        // cutout alpha while writing depth, so eyes and hidden skin stay inside.
        material.transparent=false;material.depthWrite=true;material.alphaTest=.5;
      }
    }
  });
  const map=boneMap(name,bones);
  const root=new THREE.Group();root.name='CharacterMotion';
  const normalizer=new THREE.Group();normalizer.name='CharacterScale';root.add(normalizer);normalizer.add(asset);
  root.updateMatrixWorld(true);
  // The files use different up axes and units. Orient by their anatomy, then
  // use a uniform scale; never stretch a downloaded mesh onto our old body.
  const right=point(map.LeftUpLeg).sub(point(map.RightUpLeg)).normalize();
  const up=point(map.Head).sub(point(map.Hips));up.addScaledVector(right,-up.dot(right)).normalize();
  const front=right.clone().cross(up).normalize();
  normalizer.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,up,front)).invert();
  root.updateMatrixWorld(true);
  // Use the authored initial pose. skeleton.pose() corrupts several of these
  // Sketchfab files because unused end bones have identity inverse binds.
  const torso=['Hips','Spine','Spine1','Spine2','UpperChest','Ribcage','Neck','Head'].filter(n=>map[n]);
  for(let i=0;i<torso.length-1;i++)aim(map[torso[i]],map[torso[i+1]],V(0,1,0));
  for(const side of ['Left','Right']) {
    const sign=side==='Left'?1:-1;
    for(const [a,b] of [['Shoulder','Arm'],['Arm','ForeArm'],['ForeArm','Hand']])aim(map[side+a],map[side+b],V(sign,0,0));
    const hand=map[side+'Hand'],middle=map[side+'HandMiddle1'],index=map[side+'HandIndex1'];
    if(middle&&index) {
      const from=basis(point(middle).sub(point(hand)),point(index).sub(point(middle)));
      const to=basis(V(sign,0,0),V(0,0,1));
      worldQuaternion(hand,to.multiply(from.invert()).multiply(hand.getWorldQuaternion(Q())));
    }
    for(const f of ['Thumb','Index','Middle','Ring','Pinky'])for(let k=1;k<3;k++) {
      const a=`${side}Hand${f}${k}`,b=`${side}Hand${f}${k+1}`;
      aim(map[a],map[b],rest[b].clone().sub(rest[a]));
    }
    aim(map[side+'UpLeg'],map[side+'Leg'],V(0,-1,0));
    aim(map[side+'Leg'],map[side+'Foot'],V(0,-1,0));
    // Keep the author's shoe/foot pitch: toes in some source rigs are helper
    // pivots and are not at the visible tip of the foot.
  }
  if(map.HeadTip)aim(map.Head,map.HeadTip,V(0,1,0));
  root.updateMatrixWorld(true);
  let box=new THREE.Box3().setFromObject(root,true);
  const scale=1.74/(box.max.y-box.min.y);normalizer.scale.setScalar(scale);root.updateMatrixWorld(true);
  box=new THREE.Box3().setFromObject(root,true);
  const hips=point(map.Hips);
  normalizer.position.set(-hips.x,-box.min.y,-hips.z);root.updateMatrixWorld(true);
  const hipRest=point(map.Hips);
  const entries=[];
  const semantics=new Map(Object.entries(map).map(([n,b])=>[b,n]));
  asset.traverse(b=>{
    const key=semantics.get(b);if(!key)return;
    if(key==='HeadTip')return;
    const source=key==='UpperChest'||key==='Ribcage'?'Spine2':key;
    entries.push({bone:b,source,world:b.getWorldQuaternion(Q()),local:b.quaternion.clone()});
  });
  // Give exported tracks stable, unambiguous names, independent of source node names.
  let index=0;asset.traverse(o=>{o.name=`${name}_${index++}_${o.name}`;});
  const saved=bones.map(b=>({bone:b,position:b.position.clone(),quaternion:b.quaternion.clone(),scale:b.scale.clone()}));
  // Foot support points are authored mesh vertices expressed in the foot
  // bone's local space. This grounds any proportions without flattening jumps.
  const supports=[];
  for(const side of ['Left','Right']) {
    const foot=map[side+'Foot'],p=point(foot),inverse=foot.matrixWorld.clone().invert();
    const candidates=[];
    for(const mesh of meshes) {
      const position=mesh.geometry.attributes.position;
      for(let i=0;i<position.count;i++) {
        const v=mesh.getVertexPosition(i,V()).applyMatrix4(mesh.matrixWorld);
        if(v.y<.20 && Math.abs(v.x-p.x)<.12)candidates.push(v);
      }
    }
    candidates.sort((a,b)=>a.y-b.y);
    // Multiple points catch toe/heel contact during foot rotation.
    for(const v of candidates.filter((_,i)=>i%Math.max(1,Math.floor(candidates.length/80))===0))supports.push({bone:foot,local:v.clone().applyMatrix4(inverse)});
  }
  const info=CHARACTER_INFO[name];
  root.userData={character:name,source:`https://sketchfab.com/3d-models/${info.uid}`,author:info.author,license:'CC-BY-4.0',modifications:'Uniform scale, T-pose calibration and motion retargeting'};
  const targetQ=Q(),parentQ=Q(),sourceQ=Q();
  return {
    root, bones, meshes, map, entries, info,
    reset() {root.position.set(0,0,0);for(const s of saved){s.bone.position.copy(s.position);s.bone.quaternion.copy(s.quaternion);s.bone.scale.copy(s.scale);}root.updateMatrixWorld(true);},
    sync(man) {
      man.root.updateMatrixWorld(true);
      root.position.set(0,0,0);root.updateMatrixWorld(true);
      for(const e of entries) {
        const source=man.bones[e.source];if(!source)continue;
        source.getWorldQuaternion(sourceQ);targetQ.copy(sourceQ).multiply(e.world);
        e.bone.parent.getWorldQuaternion(parentQ).invert();
        e.bone.quaternion.copy(parentQ.multiply(targetQ));e.bone.updateWorldMatrix(false,true);
      }
      const hp=point(map.Hips);
      root.position.set(man.bones.Hips.position.x+hipRest.x-hp.x,man.bones.Hips.position.y-.95+hipRest.y-hp.y,man.bones.Hips.position.z+hipRest.z-hp.z);
      root.updateMatrixWorld(true);
      let low=Infinity;for(const s of supports)low=Math.min(low,V().copy(s.local).applyMatrix4(s.bone.matrixWorld).y);
      // The solver already encodes floor contact and jump lift in the source.
      let sourceLow=Infinity;
      for(const side of ['Left','Right']) {
        for(const [bone,p] of [[side+'Foot',[0,-.04,-.045]],[side+'ToeBase',[0,-.025,.04]]])sourceLow=Math.min(sourceLow,V(...p).applyMatrix4(man.bones[bone].matrixWorld).y);
      }
      if(Number.isFinite(low))root.position.y+=Math.max(0,sourceLow)-low;
      root.updateMatrixWorld(true);
    },
    dispose() {
      const geometries=new Set(),materials=new Set(),textures=new Set();
      for(const m of meshes){geometries.add(m.geometry);for(const mat of Array.isArray(m.material)?m.material:[m.material]){materials.add(mat);for(const v of Object.values(mat))if(v?.isTexture)textures.add(v);}}
      for(const g of geometries)g.dispose();for(const m of materials)m.dispose();for(const t of textures)t.dispose();
    },
  };
}

/** Bake the same retargeted transforms shown in the viewport into the export. */
export function retargetClip(man,clip) {
  const avatar=man.avatar;
  const sourceTimes=clip.tracks.find(t=>t.name==='Hips.position').times;
  // glTF derives clip length from the final key. Hold the last capture frame
  // through the video's duration instead of shortening every export by a frame.
  const times=clip.duration>sourceTimes[sourceTimes.length-1]
    ? Float32Array.from([...sourceTimes,clip.duration]) : sourceTimes;
  const sourcePose=Object.values(man.bones).map(b=>[b,b.position.clone(),b.quaternion.clone()]);
  const face=man.face.morphTargetInfluences.slice();
  const tracks=clip.tracks.map(t=>({name:t.name,sample:t.createInterpolant()}));
  const rotations=avatar.entries.map(()=>[]),positions=[];
  man.reset();
  try {
    for(const time of times) {
      for(const t of tracks) {
        const value=t.sample.evaluate(time),[name,property]=t.name.split('.');
        if(man.bones[name]&&property==='quaternion')man.bones[name].quaternion.fromArray(value);
        if(man.bones[name]&&property==='position')man.bones[name].position.fromArray(value);
      }
      avatar.sync(man);positions.push(...avatar.root.position.toArray());
      avatar.entries.forEach((e,i)=>rotations[i].push(...e.bone.quaternion.toArray()));
    }
    return new THREE.AnimationClip(clip.name,clip.duration,[
      new THREE.VectorKeyframeTrack('CharacterMotion.position',times,positions),
      ...avatar.entries.map((e,i)=>new THREE.QuaternionKeyframeTrack(`${e.bone.name}.quaternion`,times,rotations[i])),
    ]);
  } finally {
    for(const [b,p,q] of sourcePose){b.position.copy(p);b.quaternion.copy(q);}
    man.face.morphTargetInfluences.splice(0,face.length,...face);avatar.sync(man);
  }
}
