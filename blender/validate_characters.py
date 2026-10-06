"""Round-trip the downloaded character exports through Blender and FBX."""
import bpy,json,os,runpy,sys
from pathlib import Path
from mathutils import Vector
from workshop import fresh_scene,save_blend
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/out/characters'
results=[]

def snapshot(offset=0):
    result={}
    for frame in [0,15,30]:
        bpy.context.scene.frame_set(frame+offset);bpy.context.view_layer.update()
        points={}
        for arm in bpy.context.scene.objects:
            if arm.type=='ARMATURE':
                for bone in arm.pose.bones:
                    points[bone.name]=(arm.matrix_world@bone.head).copy()
        result[frame]=points
    return result

for name in ['mannequin','skeleton','male','female']:
    job={'source':str(OUT/(name+'.glb')),'target':str(OUT/(name+'.fbx')),'fps':30}
    jobfile=OUT/(name+'-fbx-job.json');jobfile.write_text(json.dumps(job))
    sys.argv=['blender','--',str(jobfile)]
    runpy.run_path(str(ROOT/'blender/to_fbx.py'),run_name='__main__')
    before=snapshot()
    # Keep editable copies of the actual replacement assets, with packed maps.
    bpy.context.scene.frame_set(0)
    for image in bpy.data.images:
        if image.has_data and image.source=='FILE' and not image.packed_file:
            try:image.pack()
            except RuntimeError:pass
    save_blend(str(ROOT/'blender'/(name+'.blend')))
    fresh_scene()
    bpy.ops.import_scene.fbx(filepath=job['target'])
    assert any(o.get('author') and o.get('license') == 'CC-BY-4.0' and o.get('source') for o in bpy.context.scene.objects), (name, 'missing FBX artist credits')
    after=snapshot(1);maximum=0;count=0
    for frame,points in before.items():
        for bone,p in points.items():
            if bone not in after[frame]:raise AssertionError('Missing exported bone '+bone)
            maximum=max(maximum,(p-after[frame][bone]).length);count+=1
    if maximum>=.005:
        print('DRIFT', name, sorted([(round((p-after[f][b]).length,6),f,b,tuple(p),tuple(after[f][b])) for f,ps in before.items() for b,p in ps.items()],reverse=True)[:8])
    assert maximum<.005,(name,'FBX drift',maximum)
    images=set()
    for ob in bpy.context.scene.objects:
        if ob.type=='MESH':
            for material in ob.data.materials:
                if material and material.use_nodes:
                    images.update(n.image for n in material.node_tree.nodes if n.type=='TEX_IMAGE' and n.image)
    # Accessing size loads packed textures lazily after the FBX import.
    assert images and all(tuple(i.size)[0] > 0 and (i.packed_file or os.path.isfile(bpy.path.abspath(i.filepath))) for i in images),(name,'missing FBX textures')
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH': continue
        for material in ob.data.materials:
            if not material or not material.use_nodes: continue
            shader=next(n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
            assert shader.inputs['Base Color'].is_linked, (name, 'base colour texture lost')
    results.append({'character':name,'samples':count,'max_position_error_m':maximum,'textures':len(images),'fbx_bytes':os.path.getsize(job['target'])})
(OUT/'blender-validation.json').write_text(json.dumps(results,indent=2))
print('@@VALIDATION@@'+json.dumps(results))
