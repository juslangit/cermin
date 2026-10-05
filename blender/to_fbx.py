"""
Turn cermin's .glb into an .fbx, inside the shared Blender.

The browser writes the .glb itself; .fbx is a closed format nothing in a
browser can write, so Blender does that one step. Run through bengkel's
mcp.run_job, in a scene of its own that is removed afterwards.

Job:  {"source": ".../cermin.glb", "target": ".../cermin.fbx", "fps": 30}
"""

import json
import os
import sys

import bpy
from workshop import fresh_scene                   # noqa: E402  bengkel common/blender

ANSWER = "@@JOB@@"


def main():
    job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
    fresh_scene()
    # The take's own frame rate before importing - the importer turns seconds
    # into frames at whatever rate the scene has - and its own length after,
    # because the export bakes only the scene's range, which starts life as
    # frames 1 to 250 and would quietly cut every take over ten seconds short.
    scene = bpy.context.scene
    scene.render.fps = int(job.get("fps", 30))
    scene.render.fps_base = 1.0
    bpy.ops.import_scene.gltf(filepath=job["source"])

    armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if not armatures:
        print(ANSWER + json.dumps({"ok": False, "problem": "the .glb had no skeleton in it"}))
        return
    # This import's own animation only: bpy.data.actions is the whole shared
    # Blender, and boneka's or Claude's actions are not this take's length.
    mine = [a.animation_data.action for a in armatures
            if a.animation_data and a.animation_data.action]
    actions = [a.name for a in mine]
    ranges = [a.frame_range for a in mine]
    if ranges:
        scene.frame_start = int(min(r[0] for r in ranges))
        scene.frame_end = int(round(max(r[1] for r in ranges)))

    # Only this scene's objects, and bones exported as bones rather than as
    # Blender's leaf-bone extras, which Unreal and Mixamo-style retargeters
    # read as extra joints.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        obj.select_set(True)
    bpy.ops.export_scene.fbx(
        filepath=job["target"],
        use_selection=True,
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_actions=False,
        bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0,
        object_types={"ARMATURE", "MESH"},
    )

    # Assert on the file, not on the operator having returned.
    size = os.path.getsize(job["target"]) if os.path.exists(job["target"]) else 0
    print(ANSWER + json.dumps({"ok": size > 0, "bytes": size, "actions": actions,
                               "frames": [scene.frame_start, scene.frame_end],
                               "problem": None if size else "Blender wrote nothing"}))


main()
