# Background Blender: export a decimated copy of the MODEL collection and render a small preview.
import bpy
import math
import sys

args = sys.argv[sys.argv.index("--") + 1:]
out_glb, out_png, ratio_body, ratio_wheel = args[0], args[1], float(args[2]), float(args[3])
scene = bpy.context.scene
objs = list(bpy.data.collections["MODEL"].objects)
for o in scene.objects:
    o.hide_render = o not in objs
    o.select_set(False)
for o in objs:
    if o.name == "lights":
        continue
    m = o.modifiers.new("Decimate", "DECIMATE")
    m.ratio = ratio_wheel if o.name.startswith("wheel") else ratio_body
    if o.name in ("body", "glass"):
        m.use_symmetry = True
        m.symmetry_axis = "X"
dg = bpy.context.evaluated_depsgraph_get()
tris = {}
for o in objs:
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    tris[o.name] = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
print("LOD_TRIS", tris, sum(tris.values()))
for o in objs:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out_glb, use_selection=True, export_apply=True, export_format="GLB")

cam_data = bpy.data.cameras.new("preview_cam")
cam = bpy.data.objects.new("preview_cam", cam_data)
scene.collection.objects.link(cam)
cam_data.lens = 70
dist, az, el = 13.0, math.radians(28), math.radians(20)
cam.location = (dist * math.sin(az) * math.cos(el), dist * math.cos(az) * math.cos(el),
                0.5 + dist * math.sin(el))
cam.rotation_euler = (math.radians(90) - el, 0, math.radians(180) - az)
scene.camera = cam
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "FLAT"
scene.display.shading.color_type = "MATERIAL"
scene.display.render_aa = "OFF"
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x = 360
scene.render.resolution_y = 240
scene.render.resolution_percentage = 100
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
