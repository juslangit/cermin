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
import tempfile

import bpy
from fbx_materials import prepare as prepare_material
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
    mine = [o.animation_data.action for o in scene.objects
            if o.animation_data and o.animation_data.action]
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
    # glTF images arrive packed in memory. FBX embeds files from disk, so give
    # this scene's images temporary paths and embed them before cleaning up.
    materials = {m for o in scene.objects if o.type == "MESH" for m in o.data.materials if m}
    for material in materials:
        prepare_material(material)
    images = set()
    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        for material in obj.data.materials:
            if material and material.use_nodes:
                images.update(n.image for n in material.node_tree.nodes
                              if n.type == "TEX_IMAGE" and n.image)
    with tempfile.TemporaryDirectory(prefix="cermin-fbx-textures-") as folder:
        for index, image in enumerate(images):
            extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(image.file_format, "png")
            path = os.path.join(folder, "texture_%d.%s" % (index, extension))
            if image.packed_file:
                with open(path, "wb") as file:
                    file.write(image.packed_file.data)
            else:
                image.filepath_raw = path
                image.save()
            image.filepath = path
        bpy.ops.export_scene.fbx(
            filepath=job["target"],
            use_selection=True,
            add_leaf_bones=False,
            bake_anim=True,
            bake_anim_use_all_actions=False,
            bake_anim_use_nla_strips=False,
            bake_anim_simplify_factor=0.0,
            # CharacterMotion is an animated parent; keeping empties retains
            # its root translation and the source model's uniform scale.
            object_types={"ARMATURE", "MESH", "EMPTY"},
            path_mode="COPY",
            embed_textures=True,
            use_custom_props=True,  # retain source, artist, license and adaptations
        )

    # Assert on the file, not on the operator having returned.
    size = os.path.getsize(job["target"]) if os.path.exists(job["target"]) else 0
    print(ANSWER + json.dumps({"ok": size > 0, "bytes": size, "actions": actions,
                               "frames": [scene.frame_start, scene.frame_end],
                               "problem": None if size else "Blender wrote nothing"}))


main()
