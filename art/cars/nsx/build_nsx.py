# Rebuilds the stylised NSX in the open Blender scene (collection MODEL only).
# Metres, Z up, front faces -Y (so the car's left is +X), origin on the ground at the centre.
# v4: details follow the reference sheet (ref/turnaround.webp) view by view.
import bpy
import bmesh
import math
from bisect import bisect_right

COLL = "MODEL"

# Flat colours (sRGB hex).
PALETTE = {
    "nsx_body": "#E8A21C",  # faces turned to the sky
    "nsx_body_mid": "#D08E18",  # shoulders, tail
    "nsx_body_shade": "#B07414",  # sides, nose
    "nsx_dark": "#7A3A1A",  # undercuts, recesses
    "nsx_black": "#1C0D15",  # roof, pillars, intakes, lamp frame
    "nsx_glass": "#3A1626",  # side glass
    "nsx_glass_light": "#55243A",  # windscreen and rear glass (sky reflection)
    "nsx_tyre": "#2A2024",
    "nsx_metal": "#94603C",  # wheel spokes, exhaust tips
    "nsx_light_red": "#D93A2B",
    "nsx_light_red_dark": "#9E2A22",
    "nsx_light_maroon": "#641C1E",  # smoked tail lens
    "nsx_light_smoke": "#9A7272",  # reversing lamp
    "nsx_light_amber": "#F06A1C",
    "nsx_light_pale": "#F4E3B0",
}
# Tone of an "auto" body face = quantised dot(normal, LIGHT). LIGHT has no X part, so the
# shading is left-right symmetric and a mirrored sprite frame stays valid.
LIGHT = (0.0, 0.25, 1.0)
TONE_LIGHT, TONE_MID, TONE_SHADE = 0.80, 0.15, -0.30


def pchip(keys):
    """Monotone cubic through (x, y) keys; clamped outside the range."""
    xs = [k[0] for k in keys]
    ys = [k[1] for k in keys]
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] > 0:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = bisect_right(xs, x) - 1
        t = (x - xs[i]) / h[i]
        t2, t3 = t * t, t * t * t
        return (
            (2 * t3 - 3 * t2 + 1) * ys[i]
            + (t3 - 2 * t2 + t) * h[i] * m[i]
            + (-2 * t3 + 3 * t2) * ys[i + 1]
            + (t3 - t2) * h[i] * m[i + 1]
        )

    return f


# The loft runs between the two fascia cut planes; the fascias add the rest of the length
# (overall 4.43 m: nose tip at -2.215, bumper face at +2.215).
LOFT_Y0, LOFT_Y1 = -2.13, 2.145
FRONT_Y, REAR_Y = -1.215, 1.315

# Body profile curves over Y.
W_BASE = pchip([(-2.13, 0.76), (-2.0, 0.815), (-1.7, 0.86), (-1.215, 0.878), (-0.6, 0.872),
                (0.3, 0.875), (1.0, 0.887), (1.315, 0.887), (1.9, 0.88), (2.145, 0.85)])
ZF = pchip([(-2.13, 0.165), (-2.0, 0.13), (-1.6, 0.11), (1.7, 0.11), (2.0, 0.15), (2.145, 0.20)])
ZK = pchip([(-2.13, 0.36), (-1.215, 0.50), (-0.8, 0.585), (0.0, 0.60), (0.9, 0.61),
            (1.315, 0.62), (2.145, 0.62)])  # character line: the widest line of the side
ZS = pchip([(-2.13, 0.47), (-2.0, 0.52), (-1.6, 0.64), (-1.215, 0.70), (-0.82, 0.75),
            (0.0, 0.79), (1.0, 0.83), (1.315, 0.86), (1.9, 0.885), (2.145, 0.90)])  # fender crown
# Centre line. Behind the cabin the deck sinks between the fender ridges, which rise into the wing.
ZC = pchip([(-2.13, 0.475), (-1.7, 0.59), (-1.215, 0.67), (-0.82, 0.745), (-0.6, 0.77),
            (0.5, 0.82), (1.45, 0.855), (1.8, 0.825), (2.145, 0.80)])
IND = pchip([(-2.13, 0.0), (-1.9, 0.012), (-0.6, 0.02), (0.4, 0.04), (0.75, 0.085), (0.85, 0.085),
             (0.885, 0.02), (2.145, 0.01)])  # undercut of the lower side, deepest at the side intake
# Bonnet: a raised centre panel, with a groove between it and each fender.
HOOD_XP = pchip([(-2.13, 0.34), (-0.9, 0.40), (2.145, 0.40)])  # half-width of the centre panel
HOOD_STEP = pchip([(-2.13, 0.015), (-1.9, 0.035), (-1.0, 0.035), (-0.82, 0.0), (2.145, 0.0)])
HOOD_STEP_W = 0.022
KNEE_FX = pchip([(-2.13, 0.78), (1.5, 0.78), (1.95, 0.96), (2.145, 0.96)])  # knee x / crown x
KNEE_RISE = 0.2  # knee height as a fraction of the crown rise

WELL_X = 0.50  # inner wall of the wheel wells (room for a steered front wheel)
ARCH_GAP = 0.045
ARCH_STEPS = 10
FLARE = 0.018  # extra half-width over the wheel arches
FLARE_REACH = 0.14
# Fender crown sits this far inside the widest line; at the tail the ridges (wing uprights) move in.
CROWN_IN = pchip([(-2.13, 0.16), (1.5, 0.16), (1.95, 0.24), (2.145, 0.24)])

# Wheels: name -> (x, y, radius, width)
WHEELS = {
    "wheel_FL": (0.755, FRONT_Y, 0.31, 0.22),
    "wheel_FR": (-0.755, FRONT_Y, 0.31, 0.22),
    "wheel_RL": (0.765, REAR_Y, 0.33, 0.26),
    "wheel_RR": (-0.765, REAR_Y, 0.33, 0.26),
}
WHEEL_SEGMENTS = 20
ARCHES = [(FRONT_Y, 0.31), (REAR_Y, 0.33)]  # (axle y, wheel radius)

BASE_YS = [-2.13, -2.08, -2.0, -1.88, -1.75, -1.62,
           -0.82, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.65, 0.75, 0.85, 0.885,
           1.75, 1.85, 1.95, 2.05, 2.145]

# Cabin curves.
CAB_XB = pchip([(-0.82, 0.68), (-0.4, 0.715), (0.3, 0.725), (1.05, 0.72), (1.40, 0.67)])
CAB_XT = pchip([(-0.82, 0.66), (-0.02, 0.47), (0.55, 0.46), (1.05, 0.53), (1.40, 0.62)])
CAB_ZT = pchip([(-0.82, 0.745), (-0.10, 1.085), (-0.02, 1.115), (0.28, 1.13), (0.55, 1.118),
                (1.05, 0.975), (1.40, 0.885)])
CAB_YS = [-0.82, -0.62, -0.42, -0.22, -0.02, 0.28, 0.50, 0.60, 0.82, 1.05, 1.22, 1.40]
CAB_RAIL = 0.045
CAB_CROWN = 0.02
WINDSCREEN_TOP_Y, B_PILLAR = -0.02, (0.50, 0.60)

# Wing: a low hoop. The rear fender ridges are its uprights; the blade bridges them, and the
# boot lid stays visible through the gap under it.
WING_BLADE = (0.61, 1.98, 2.20, 0.87, 0.91)  # half-width, y0, y1, z0, z1

BODY_SLOTS = ["nsx_body", "nsx_body_mid", "nsx_body_shade", "nsx_dark", "nsx_black",
              "nsx_metal", "nsx_light_pale"]
B_AUTO, B_MID, B_SHADE, B_DARK, B_BLACK, B_METAL, B_PALE = range(7)
BODY_TONES = (B_AUTO, B_MID, B_SHADE, B_DARK)
LIGHT_SLOTS = ["nsx_light_red", "nsx_light_red_dark", "nsx_light_maroon", "nsx_light_amber",
               "nsx_light_pale", "nsx_black", "nsx_light_smoke"]
L_RED, L_REDD, L_MAROON, L_AMBER, L_PALE, L_BLACK, L_SMOKE = range(7)


# Fascias: (cut-plane y, direction, rows, material function). A row is (z, how far the surface
# stands off the cut plane on the centre line); z None = top edge. Rows are clipped by the top skin.
def rear_mat(x, z):
    if z < 0.39:  # black valance in the middle; the bumper corners come down as two legs
        return B_BLACK if (x < 0.655 or z < 0.22) else B_AUTO
    if 0.675 < z < 0.795 and x < 0.795:  # seam around the tail lens
        return B_BLACK
    return B_AUTO


def front_mat(x, z):
    return B_AUTO


REAR = (LOFT_Y1, 1.0, [
    (0.13, 0.0), (0.30, 0.03), (0.375, 0.058),  # valance, receding under the car
    (0.42, 0.07), (0.56, 0.07), (0.64, 0.06),  # rounded bumper
    (0.675, 0.05), (0.68, 0.046), (0.795, 0.04),  # tail lens band, almost flush
    (0.80, 0.034),  # boot lid edge between the fender ridges
    (0.85, 0.034), (None, 0.034),  # rear faces of the wing uprights
], rear_mat)
FRONT = (LOFT_Y0, -1.0, [
    (0.125, 0.065), (0.14, 0.075), (0.215, 0.075),  # lip spoiler
    (0.225, 0.055), (0.355, 0.055),  # intake zone
    (0.365, 0.075), (0.39, 0.085),  # bumper bar, nose tip
    (0.46, 0.05), (None, 0.0),  # lamp facet up to the bonnet edge
], front_mat)
FASCIA_COLS = 12
PROUD = 0.006  # detail panels sit this far off the surface


def collection():
    c = bpy.data.collections.get(COLL)
    if c is None:
        c = bpy.data.collections.new(COLL)
        bpy.context.scene.collection.children.link(c)
    return c


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    h = PALETTE[name]
    rgba = [srgb_to_linear(int(h[i : i + 2], 16) / 255.0) for i in (1, 3, 5)] + [1.0]
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new("ShaderNodeEmission")
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    e.inputs["Color"].default_value = rgba
    e.inputs["Strength"].default_value = 1.0
    nt.links.new(e.outputs[0], o.inputs["Surface"])
    m.diffuse_color = rgba
    return m


def new_object(name, bm, slots, mirror=False, location=(0, 0, 0), auto_tones=None):
    """slots: material names by index. auto_tones: (light, mid, shade, dark) slot indices given
    by the light to every face still on slot 0."""
    old = bpy.data.objects.get(name)
    if old is not None:
        mesh_old = old.data
        bpy.data.objects.remove(old)
        if mesh_old.users == 0:
            bpy.data.meshes.remove(mesh_old)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    orient_details(bm)
    if auto_tones is not None:
        ll = math.sqrt(sum(c * c for c in LIGHT))
        for f in bm.faces:
            if f.material_index == 0:
                n = f.normal
                dot = (n.x * LIGHT[0] + n.y * LIGHT[1] + n.z * LIGHT[2]) / ll
                f.material_index = auto_tones[
                    0 if dot >= TONE_LIGHT else 1 if dot >= TONE_MID else 2 if dot >= TONE_SHADE else 3
                ]
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for s in slots:
        mesh.materials.append(material(s))
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    collection().objects.link(obj)
    if mirror:
        m = obj.modifiers.new("Mirror", "MIRROR")
        m.use_axis = (True, False, False)
        m.use_clip = True
        m.merge_threshold = 1e-4
    return obj


DETAIL_OUT = []  # (face, wanted outward direction) of loose detail faces, oriented after recalc


def face(bm, pts, mat, out=None):
    """Loose detail face. out = direction its front must look; default: away from the car."""
    f = bm.faces.new([bm.verts.new(p) for p in pts])
    f.material_index = mat
    DETAIL_OUT.append((f, out))
    return f


def orient_details(bm):
    """Engines cull back faces, so every loose panel must face outwards."""
    alive = set(bm.faces)
    for f, out in DETAIL_OUT:
        if f not in alive:
            continue
        if out is None:
            c = f.calc_center_median()
            out = (c.x / 0.81, c.y / 4.84, (c.z - 0.45) / 0.25)  # normal of an ellipsoid around the car
        n = f.normal
        if n.x * out[0] + n.y * out[1] + n.z * out[2] < 0:
            f.normal_flip()
    DETAIL_OUT.clear()


def box(bm, x0, x1, y0, y1, z0, z1, mat=0):
    v = [bm.verts.new((x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    for idx in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([v[i] for i in idx]).material_index = mat


# ---------------------------------------------------------------- body surface

def half_width(y):
    w = W_BASE(y)
    for ya, r in ARCHES:
        t = (y - ya) / (r + ARCH_GAP + FLARE_REACH)
        if abs(t) < 1:
            w += FLARE * (1 - t * t) ** 2
    return w


def side_poly(y):
    """Side skin of the half-section, from the skirt bottom up to the fender crown: (x, z)."""
    w, zf, zk, zs = half_width(y), ZF(y), ZK(y), ZS(y)
    ind = IND(y)
    return [
        (w - 0.035, zf + 0.01),  # skirt bottom
        (w + 0.004, zf + 0.07),  # skirt edge
        (w - 0.004, zf + 0.11),  # skirt top
        (w - 0.03 * min(max((y - LOFT_Y0) / 1.2, 0.0), 1.0) - ind, zf + 0.14),  # lower door
        (w, zk),  # character line, widest
        (w - 0.02, zk + 0.5 * (zs - zk)),
        (w - 0.075, zs - 0.04),  # shoulder
        (w - CROWN_IN(y), zs),  # crown
    ]


WELL_STRIPS = (1, 2)  # section strips: well wall, arch ceiling


def top_poly(y):
    """Top skin of the half-section from the centre line out to the fender crown: (x, z)."""
    w, zs, zc = half_width(y), ZS(y), ZC(y)
    cx = w - CROWN_IN(y)
    xp, g = HOOD_XP(y), HOOD_STEP(y)
    return [(0.0, zc), (xp, zc), (xp + HOOD_STEP_W, zc - g),
            (max(KNEE_FX(y) * cx, xp + HOOD_STEP_W + 0.03), zc + KNEE_RISE * (zs - zc)), (cx, zs)]


def x_at(poly, z):
    if z <= poly[0][1]:
        return poly[0][0]
    for (x0, z0), (x1, z1) in zip(poly, poly[1:]):
        if z <= z1:
            return x0 + (x1 - x0) * (z - z0) / (z1 - z0)
    return poly[-1][0]


def skin_x(y, z):
    """Outer skin X at height z."""
    return x_at(side_poly(y), z)


def top_z(y, x):
    """Top skin Z at half-width x."""
    pts = top_poly(y)
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if x <= x1:
            return z0 + (z1 - z0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


def body_section(y, arch_h):
    """Points of the half-section; arch_h = height of the wheel-arch opening here, or None."""
    w, zf = half_width(y), ZF(y)
    side = side_poly(y)
    xb = min(WELL_X, w - 0.10)
    pts = [(0.0, zf), (xb, zf)]
    if arch_h is None:
        pts.append((xb, zf))
        pts += side
    else:
        xa = x_at(side, arch_h)
        pts.append((xb, arch_h))
        pts += [(xa, arch_h) if z < arch_h else (x, z) for (x, z) in side]
    pts += reversed(top_poly(y)[:-1])  # the crown is already the last side point
    return [(x, y, z) for (x, z) in pts]


def body_stations():
    spans = [(ya - (r + ARCH_GAP), ya + (r + ARCH_GAP)) for ya, r in ARCHES]
    st = [(y, None) for y in BASE_YS if not any(a - 1e-6 <= y <= b + 1e-6 for a, b in spans)]
    for ya, r in ARCHES:
        ra = r + ARCH_GAP
        st.append((ya - ra, None))  # closed section, then the arch opens at the same y
        for k in range(ARCH_STEPS + 1):
            t = math.pi * k / ARCH_STEPS
            st.append((ya - ra * math.cos(t), r + ra * math.sin(t)))
        st.append((ya + ra, None))
    st.sort(key=lambda s: round(s[0], 6))  # stable: keeps closed/open order at the arch ends
    return st


def build_body(details):
    bm = bmesh.new()
    rings = []
    for y, h in body_stations():
        rings.append([bm.verts.new(p) for p in body_section(y, h)])
    for a, b in zip(rings, rings[1:]):
        same_y = abs(a[0].co.y - b[0].co.y) < 1e-6
        for i in range(len(a) - 1):
            quad = [a[i], a[i + 1], b[i + 1], b[i]]
            if len({v.co.to_tuple(5) for v in quad}) < 3:
                continue
            f = bm.faces.new(quad)
            if same_y or i in WELL_STRIPS:
                f.material_index = B_DARK
    for ring in (rings[0], rings[-1]):
        bm.faces.new(ring)
    build_fascia(bm, REAR)
    build_fascia(bm, FRONT)
    build_wing(bm)
    if details:
        body_details(bm)
    inner = [f for f in bm.faces if all(abs(v.co.x) < 1e-6 for v in f.verts)]
    bmesh.ops.delete(bm, geom=inner, context="FACES")
    return new_object("body", bm, BODY_SLOTS, mirror=True, auto_tones=BODY_TONES)


# ---------------------------------------------------------------- fascias

def corner(u):
    """Plan-view rounding of a fascia: 1 on the centre line, 0 at the body side."""
    u = min(max(u, 0.0), 1.0)
    return (1.0 - u ** 3) ** (1.0 / 3.0)


def band_depth(fascia, z):
    y0, _, bands, _ = fascia
    rows = [(ZS(y0) if bz is None else bz, d) for bz, d in bands]
    if z <= rows[0][0]:
        return rows[0][1]
    for (z0, d0), (z1, d1) in zip(rows, rows[1:]):
        if z <= z1:
            return d0 + (d1 - d0) * (z - z0) / (z1 - z0)
    return rows[-1][1]


def fascia_y(fascia, x, z, proud=PROUD):
    """Y of the fascia surface at (x, z), pushed outwards by proud."""
    y0, sign, _, _ = fascia
    xm = skin_x(y0, z)
    return y0 + sign * (band_depth(fascia, z) * corner(x / xm) + proud)


def build_fascia(bm, fascia):
    y0, sign, bands, mat_fn = fascia
    rows = []
    for bz, depth in bands:
        row = []
        for i in range(FASCIA_COLS + 1):
            u = math.sin(0.5 * math.pi * i / FASCIA_COLS)
            if bz is None:
                x = u * (half_width(y0) - CROWN_IN(y0))
                z = top_z(y0, x)
            else:
                x = u * skin_x(y0, bz)
                z = min(bz, top_z(y0, x))
            row.append(bm.verts.new((x, y0 + sign * depth * corner(u), z)))
        rows.append(row)
    for j in range(len(rows) - 1):
        for i in range(FASCIA_COLS):
            quad = [rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]]
            if len({v.co.to_tuple(5) for v in quad}) >= 3:
                xm = sum(v.co.x for v in quad) / 4
                zm = sum(v.co.z for v in quad) / 4
                bm.faces.new(quad).material_index = mat_fn(xm, zm)


def ftrap(bm, fascia, x0, x1, zb0, zb1, zt0, zt1, mat, proud=PROUD, n=4):
    """Panel on a fascia whose bottom and top edges run linearly from x0 to x1."""
    def pt(t, top):
        x = x0 + (x1 - x0) * t
        z = (zt0 + (zt1 - zt0) * t) if top else (zb0 + (zb1 - zb0) * t)
        return (x, fascia_y(fascia, x, z, proud), z)
    for k in range(n):
        ta, tb = k / n, (k + 1) / n
        face(bm, [pt(ta, False), pt(tb, False), pt(tb, True), pt(ta, True)], mat)


def fpanel(bm, fascia, x0, x1, z0, z1, mat, proud=PROUD, n=4):
    """Rectangle (in x, z) laid on a fascia."""
    ftrap(bm, fascia, x0, x1, z0, z0, z1, z1, mat, proud, n)


def spanel(bm, pts, mat, proud=PROUD):
    """Polygon given as (y, z) points, laid on the body side."""
    face(bm, [(skin_x(y, z) + proud, y, z) for (y, z) in pts], mat)


def sstrip(bm, y0, y1, zlo, zhi, mat, proud=PROUD):
    """Vertical strip on the body side that follows the section's bends."""
    zs = sorted({zlo, zhi} | {z for _, z in side_poly(0.5 * (y0 + y1)) if zlo < z < zhi})
    for za, zb in zip(zs, zs[1:]):
        spanel(bm, [(y0, za), (y1, za), (y1, zb), (y0, zb)], mat, proud)


def tpanel(bm, x0, x1, y0, y1, mat, proud=PROUD, n=3):
    """Rectangle (in x, y) laid on the bonnet or the deck."""
    for k in range(n):
        ya = y0 + (y1 - y0) * k / n
        yb = y0 + (y1 - y0) * (k + 1) / n
        face(bm, [(x0, ya, top_z(ya, x0) + proud), (x1, ya, top_z(ya, x1) + proud),
                  (x1, yb, top_z(yb, x1) + proud), (x0, yb, top_z(yb, x0) + proud)], mat)


def raised(bm, x0, x1, y0, y1, h, n=3):
    """Panel standing h above the bonnet, with side walls; tones come from the light."""
    top, base = [], []
    for k in range(n + 1):
        y = y0 + (y1 - y0) * k / n
        base.append(((x0, y, top_z(y, x0)), (x1, y, top_z(y, x1))))
        top.append(((x0, y, top_z(y, x0) + h), (x1, y, top_z(y, x1) + h)))
    for k in range(n):
        face(bm, [top[k][0], top[k][1], top[k + 1][1], top[k + 1][0]], B_AUTO, out=(0, 0, 1))
        face(bm, [base[k][0], top[k][0], top[k + 1][0], base[k + 1][0]], B_SHADE, out=(-1, 0, 0))
        face(bm, [base[k][1], base[k + 1][1], top[k + 1][1], top[k][1]], B_SHADE, out=(1, 0, 0))
    face(bm, [base[0][0], base[0][1], top[0][1], top[0][0]], B_DARK, out=(0, -1, 0))  # front edge
    face(bm, [base[n][0], top[n][0], top[n][1], base[n][1]], B_MID, out=(0, 1, 0))


# ---------------------------------------------------------------- wing

def build_wing(bm):
    hw, y0, y1, z0, z1 = WING_BLADE
    box(bm, 0, hw, y0, y1, z0, z1)


# ---------------------------------------------------------------- details (body object)

PLATE_RECESS = (0.0, 0.195, 0.39, 0.525)  # x0, x1, z0, z1: pocket in the rear bumper
PLATE = (0.0, 0.17, 0.33, 0.51)  # the plate hangs over the top edge of the valance
EXHAUST = (0.565, 0.255, 0.05, 0.05)  # one tip per side: x, z, radius, how far it sticks out
GRILLE_X = 0.40  # centre bars of the valance
GRILLE_SLATS = [(0.295, 0.318), (0.345, 0.368)]
GRILLE_POST = (0.43, 0.47, 0.16, 0.385)
NOSE_INTAKE = (0.0, 0.36, 0.232, 0.35)
NOSE_SLAT = (0.0, 0.36, 0.28, 0.298)
NOSE_SIDE_DUCT = (0.385, 0.69, 0.238, 0.34)
COWL = (0.0, 0.56, -0.875, -0.835)
# Side intake: a groove under the character line that widens into the mouth behind the door.
GROOVE = (-0.60, 0.655, 0.006, 0.014, 0.05)  # y0, y1, top offset below the line, depth at y0 / y1
INTAKE_MOUTH = [(0.655, 0.60), (0.70, 0.335), (0.82, 0.335), (0.86, 0.38), (0.88, 0.47),
                (0.86, 0.56), (0.82, 0.60)]  # (y, z)
DOOR_FRONT_Y, DOOR_REAR_Y = -0.73, 0.61
SEAM_W = 0.02
DOOR_LOWER = [(0.70, 0.33), (0.66, 0.25), (0.62, 0.20)]  # rear door edge below the intake: (y, z)
DOOR_HANDLE = (0.44, 0.54, 0.665, 0.69)  # y0, y1, z0, z1
POPUP_LID = (0.44, 0.66, -1.97, -1.60)  # x0, x1, y0, y1
LID_H = 0.018
ENGINE_COVER = (0.48, 1.42, 1.80)  # half-width, y0, y1: dark glass hatch over the engine
ENGINE_RIBS = [1.49, 1.57, 1.65, 1.73]
RIB_W = 0.03
MIRROR_BASE = (0.70, 0.80, -0.45, -0.36, 0.71, 0.77)  # sits in the door shoulder
MIRROR_HEAD = (0.76, 0.93, -0.48, -0.31, 0.75, 0.87)


def tube(bm, cx, cz, r, y0, y1, n=10):
    """Exhaust tip along Y: metal sleeve, thin metal end ring, black bore."""
    def ringy(y, rad):
        return [bm.verts.new((cx + rad * math.cos(2 * math.pi * (i + 0.5) / n), y,
                              cz + rad * math.sin(2 * math.pi * (i + 0.5) / n))) for i in range(n)]
    a, b, c = ringy(y0, r), ringy(y1, r), ringy(y1, 0.78 * r)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([a[i], a[j], b[j], b[i]]).material_index = B_DARK
        bm.faces.new([b[i], b[j], c[j], c[i]]).material_index = B_DARK
    bm.faces.new(c).material_index = B_BLACK


def body_details(bm):
    y1 = LOFT_Y1
    # Rear bumper: plate notch with a body-colour plate panel.
    x0, x1, z0, z1 = PLATE_RECESS
    fpanel(bm, REAR, x0, x1, z0, z1, B_BLACK)
    x0, x1, z0, z1 = PLATE
    yp = LOFT_Y1 + 0.07 + 2 * PROUD  # flat plate, standing just off the bumper face
    face(bm, [(x0, yp, z0), (x1, yp, z0), (x1, yp, z1), (x0, yp, z1)], B_PALE, out=(0, 1, 0))
    # Valance: centre grille (slats between two posts), one exhaust tip per side.
    for z0, z1 in GRILLE_SLATS:
        fpanel(bm, REAR, 0.0, GRILLE_X, z0, z1, B_DARK)
    x0, x1, z0, z1 = GRILLE_POST
    fpanel(bm, REAR, x0, x1, z0, z1, B_DARK, n=1)
    cx, cz, r, out = EXHAUST
    tube(bm, cx, cz, r, y1 - 0.04, y1 + out)
    # Front bumper: centre intake with one slat, side ducts.
    x0, x1, z0, z1 = NOSE_INTAKE
    fpanel(bm, FRONT, x0, x1, z0, z1, B_BLACK)
    x0, x1, z0, z1 = NOSE_SLAT
    fpanel(bm, FRONT, x0, x1, z0, z1, B_DARK, proud=2 * PROUD)
    x0, x1, z0, z1 = NOSE_SIDE_DUCT
    fpanel(bm, FRONT, x0, x1, z0, z1, B_BLACK)
    # Cowl grille under the windscreen.
    x0, x1, ya, yb = COWL
    tpanel(bm, x0, x1, ya, yb, B_BLACK, n=1)
    # Side: groove under the character line, widening into the intake mouth.
    ya, yb, top, d0, d1 = GROOVE
    n = 10
    for k in range(n):
        a = ya + (yb - ya) * k / n
        b = ya + (yb - ya) * (k + 1) / n
        da = d0 + (d1 - d0) * k / n
        db = d0 + (d1 - d0) * (k + 1) / n
        spanel(bm, [(a, ZK(a) - top - da), (b, ZK(b) - top - db), (b, ZK(b) - top), (a, ZK(a) - top)],
               B_DARK, proud=0.003)
    spanel(bm, INTAKE_MOUTH, B_BLACK)
    # Door: front edge, rear edge above the intake, rear edge curving forward below it; handle.
    sy = DOOR_FRONT_Y
    sstrip(bm, sy, sy + SEAM_W, ZF(sy) + 0.16, ZS(sy) - 0.07, B_DARK)
    sy = DOOR_REAR_Y
    sstrip(bm, sy, sy + SEAM_W, ZK(sy) + 0.005, ZS(sy) - 0.07, B_DARK)
    for (ya, za), (yb, zb) in zip(DOOR_LOWER, DOOR_LOWER[1:]):
        spanel(bm, [(yb, zb), (yb + SEAM_W, zb), (ya + SEAM_W, za), (ya, za)], B_DARK)
    ya, yb, z0, z1 = DOOR_HANDLE
    spanel(bm, [(ya, z0), (yb, z0), (yb, z1), (ya, z1)], B_BLACK)
    # Bonnet: pop-up lamp lid with the shadow of its front edge.
    x0, x1, ya, yb = POPUP_LID
    raised(bm, x0, x1, ya, yb, LID_H)
    # Engine cover: dark glass hatch with ribs, between the rear glass and the wing.
    hw, ya, yb = ENGINE_COVER
    tpanel(bm, 0.0, hw, ya, yb, B_BLACK, n=5)
    for ry in ENGINE_RIBS:
        tpanel(bm, 0.0, hw - 0.03, ry, ry + RIB_W, B_DARK, proud=2 * PROUD, n=1)
    # Door mirror: base sunk into the door shoulder, head, dark glass on the rear face.
    x0, x1, ya, yb, z0, z1 = MIRROR_BASE
    box(bm, x0, x1, ya, yb, z0, z1)
    x0, x1, ya, yb, z0, z1 = MIRROR_HEAD
    # Wedge: the front face is smaller than the rear one.
    fx0, fx1, fz0, fz1 = x0 + 0.05, x1 - 0.06, z0 + 0.03, z1 - 0.04
    v = [bm.verts.new(p) for p in (
        (fx0, ya, fz0), (fx1, ya, fz0), (fx1, ya, fz1), (fx0, ya, fz1),
        (x0, yb, z0), (x1, yb, z0), (x1, yb, z1), (x0, yb, z1))]
    for idx in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([v[i] for i in idx])
    face(bm, [(x0 + 0.02, yb + 0.004, z0 + 0.015), (x1 - 0.02, yb + 0.004, z0 + 0.015),
              (x1 - 0.02, yb + 0.004, z1 - 0.015), (x0 + 0.02, yb + 0.004, z1 - 0.015)], B_BLACK,
         out=(0, 1, 0))


# ---------------------------------------------------------------- cabin

G_SIDE, G_LIGHT, G_FRAME = 0, 1, 2


def build_cabin():
    bm = bmesh.new()
    rings = []
    for y in CAB_YS:
        xb, xt, zt = CAB_XB(y), CAB_XT(y), CAB_ZT(y)
        zb = top_z(y, xb) - 0.02
        rings.append([bm.verts.new(p) for p in (
            (xb, y, zb), (xt, y, zt), (max(xt - CAB_RAIL, 0.2), y, zt + 0.6 * CAB_CROWN),
            (0.0, y, zt + CAB_CROWN))])
    for a, b in zip(rings, rings[1:]):
        ym = 0.5 * (a[0].co.y + b[0].co.y)
        side = G_FRAME if B_PILLAR[0] <= ym <= B_PILLAR[1] else G_SIDE
        top = G_LIGHT if (ym < WINDSCREEN_TOP_Y or ym > B_PILLAR[1]) else G_FRAME
        for i, mat in enumerate((side, G_FRAME, top)):
            bm.faces.new([a[i], a[i + 1], b[i + 1], b[i]]).material_index = mat
    return new_object("glass", bm, ["nsx_glass", "nsx_glass_light", "nsx_black"], mirror=True)


# ---------------------------------------------------------------- wheels

def ring(bm, x, r, n=WHEEL_SEGMENTS):
    return [bm.verts.new((x, r * math.cos(2 * math.pi * (i + 0.5) / n),
                          r * math.sin(2 * math.pi * (i + 0.5) / n))) for i in range(n)]


def bridge(bm, a, b, mat):
    n = len(a)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([a[i], a[j], b[j], b[i]]).material_index = mat


T_TYRE, T_METAL, T_BLACK = 0, 1, 2


def build_wheel(name, x, y, r, w):
    bm = bmesh.new()
    s = 1.0 if x > 0 else -1.0  # outer side
    hw = w / 2
    r_side, r_rim, r_lip, r_dish = r - 0.035, 0.76 * r, 0.69 * r, 0.65 * r
    inner = ring(bm, -s * hw, r_side)
    bm.faces.new(inner).material_index = T_TYRE
    t0 = ring(bm, -s * (hw - 0.035), r)
    t1 = ring(bm, s * (hw - 0.035), r)
    outer = ring(bm, s * hw, r_side)
    bridge(bm, inner, t0, T_TYRE)
    bridge(bm, t0, t1, T_TYRE)
    bridge(bm, t1, outer, T_TYRE)
    rim = ring(bm, s * hw, r_rim)
    bridge(bm, outer, rim, T_TYRE)
    lip = ring(bm, s * hw, r_lip)
    bridge(bm, rim, lip, T_METAL)
    dish = ring(bm, s * (hw - 0.05), r_dish)
    bridge(bm, lip, dish, T_BLACK)
    bm.faces.new(dish).material_index = T_BLACK
    # Five spokes and the hub, just under the rim plane.
    xs = s * (hw - 0.012)
    for k in range(5):
        a = math.pi / 2 + 2 * math.pi * k / 5
        ca, sa = math.cos(a), math.sin(a)
        r0, h0, r1, h1 = 0.12 * r, 0.055, r_lip, 0.04
        quad = [(r0, -h0), (r1, -h1), (r1, h1), (r0, h0)]
        face(bm, [(xs, rad * ca - t * sa, rad * sa + t * ca) for rad, t in quad], T_METAL, out=(s, 0, 0))
    hx = s * (hw - 0.006)
    face(bm, [(hx, 0.2 * r * math.cos(2 * math.pi * (i + 0.5) / 10), 0.2 * r * math.sin(2 * math.pi * (i + 0.5) / 10))
              for i in range(10)], T_METAL, out=(s, 0, 0))
    return new_object(name, bm, ["nsx_tyre", "nsx_metal", "nsx_black"], location=(x, y, r))


# ---------------------------------------------------------------- lights

# Tail lens: one smoked band across the car; its outer ends turn up into the wing uprights as
# the bright brake lamps. (x0, x1, bottom z at x0 / x1, top z at x0 / x1).
LENS_Z = (0.683, 0.79)
TAIL_CENTRE = (0.0, 0.108)
TAIL_REVERSE = (0.12, 0.228)
TAIL_MAIN = (0.24, 0.78)
TAIL_CAP = (0.78, 0.795, 0.683, 0.70, 0.79, 0.73)  # rounded outer end
BRAKE_X = (0.60, 0.645, 0.745)  # inner edge, end of the flat top, foot of the slanted outer edge
BRAKE_Z = (0.796, 0.875)  # bottom, highest top
WING_LED = (0.0, 0.585, 0.873, 0.889)  # stop-lamp strip along the trailing edge of the blade
FRONT_HOUSING = (0.38, 0.74, 0.392, 0.458)
FRONT_LENS = (0.40, 0.72, 0.402, 0.448)
BUMPER_MARKER = (-1.71, -1.61, 0.43, 0.47)  # amber, side of the front bumper: y0, y1, z0, z1
FENDER_REPEATER = (-0.85, -0.77, 0.545, 0.58)  # amber, behind the front wheel


def build_lights(details):
    bm = bmesh.new()
    zb, zt = LENS_Z
    for (x0, x1), mat in ((TAIL_CENTRE, L_MAROON), (TAIL_REVERSE, L_SMOKE), (TAIL_MAIN, L_MAROON)):
        ftrap(bm, REAR, x0, x1, zb, zb, zt, zt, mat, n=6)
    ftrap(bm, REAR, *TAIL_CAP, L_MAROON, n=1)
    xa, xb, xc = BRAKE_X
    z0, zmax = BRAKE_Z
    ta = min(zmax, top_z(LOFT_Y1, xa) - 0.012)
    tb = min(zmax, top_z(LOFT_Y1, xb) - 0.012)
    ftrap(bm, REAR, xa, xb, z0, z0, ta, tb, L_RED, n=2)
    ftrap(bm, REAR, xb, xc, z0, z0, tb, z0 + 0.004, L_RED, n=3)
    x0, x1, z0, z1 = WING_LED
    yb = WING_BLADE[2] + 0.004
    face(bm, [(x0, yb, z0), (x1, yb, z0), (x1, yb, z1), (x0, yb, z1)], L_REDD, out=(0, 1, 0))
    x0, x1, z0, z1 = FRONT_HOUSING
    fpanel(bm, FRONT, x0, x1, z0, z1, L_BLACK)
    x0, x1, z0, z1 = FRONT_LENS
    fpanel(bm, FRONT, x0, x1, z0, z1, L_PALE, proud=2 * PROUD)
    for ya, yb, z0, z1 in (BUMPER_MARKER, FENDER_REPEATER):
        spanel(bm, [(ya, z0), (yb, z0), (yb, z1), (ya, z1)], L_AMBER)
    return new_object("lights", bm, LIGHT_SLOTS, mirror=True)


def tri_count(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    return n


def build_all(details=True):
    old = bpy.data.objects.get("wing")
    if old is not None:
        bpy.data.objects.remove(old)
    objs = [build_body(details), build_cabin(), build_lights(details)]
    objs += [build_wheel(n, *p) for n, p in WHEELS.items()]
    for o in objs:
        o.data.name = o.name
    bpy.context.view_layer.update()
    return {o.name: tri_count(o) for o in objs}
