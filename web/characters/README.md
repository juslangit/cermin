# Cermin character credits

Downloaded from Sketchfab on 2026-10-06. All four models are licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Retain the model title, author, source and license when sharing an exported character.

| Choice | Original model | Author |
|---|---|---|
| Mannequin | [Wooden Mannequin (Lay Figure) - Rigged](https://sketchfab.com/3d-models/f119f296833e4d4d9a8fc24dfc0533d6) | James Wright |
| Skeleton | [Lowpoly Human Skeleton (Rigged)](https://sketchfab.com/3d-models/08ab10e2a78549ab86e1b6129678b3aa) | Void |
| Male | [Casual Man Character](https://sketchfab.com/3d-models/05d9dd5bdddd4157bd46dc179781ee6e) | Bogdan Strielecki |
| Female | [Female Character stylized (Rigged)](https://sketchfab.com/3d-models/6916dc24a76944b7abdcf598bb0eef76) | Guilherme Alves |

The original meshes, textures, weights and skeletons are retained. Cermin adapts
facing, uniform scale and rest pose, then retargets captured movement onto each
original rig. The female material uses alpha testing instead of blended transparency.
FBX export bakes glTF material multipliers and packed roughness/metallic channels
into compatible texture maps. These adaptations are by the Cermin project.

None of these models has compatible facial-expression shapes. Face tracking remains
available in `face.csv`; it does not animate their expressions. The wooden mannequin
has solid hands; the other three support finger motion.

`web/characters/*.glb` are the bundled original downloads. `assets/sources/` keeps
the downloaded sources and attribution. `blender/*.blend` are editable prepared
scenes, with packed textures and a short validation animation, saved through Blender MCP.
`web/characters.js` contains the rig mapping and runtime retargeting.

The earlier procedural meshes were retired on 2026-10-06.
