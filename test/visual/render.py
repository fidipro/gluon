#!/usr/bin/env python3
"""Renders a terminal screen to PNG for the visual review (test/visual/, local only).

usage:
  render.py --cells <cells.json> <out.png>    a frame as the visual suite grabs it (exact cells)
  render.py --ansi <ansi.txt> <cols> <out.png>  a screen as escape sequences (tmux capture-pane -e -N -p)
  render.py --sheet <dir>                      every <dir>/<scene>/<size>-<theme>.json: PNGs, one
                                               contact sheet per scene (all sizes side by side) and
                                               <dir>/../index.html (goldens next to images)

cells.json (`cellsJson` in test/visual/frame.ts):
  {"cols": 80, "rows": 24, "theme": "dark"|"light",             theme optional (default dark)
   "defaults": {"fg": "#cccccc", "bg": "#0c0c0c"},               optional: the terminal's colours
   "cursor": {"x": 0, "y": 0, "visible": true},                  optional
   "lines": [{"text": "…", "runs": [[from, to, flags, fg, bg], …], "chars": ["a", "你", "", …]}, …]}
  runs: by column, `to` exclusive; flags any of i (inverse) b (bold) d (dim) t (italic) u (underline);
  fg/bg: -1 the default, "#rrggbb", or 0-255 a palette colour (a number above 255 is 0xRRGGBB).
  chars (optional): one string per column, "" for a wide character's right half; without it the
  text is laid out by East Asian width. `App.cells()` rows ({text, runs}) work too, but their runs
  count cells, not columns: the same unless a row has wide characters.

Writes <out>.txt (the plain text) next to each PNG and refuses (exit 2, no PNG) when the screen
shows something that looks like a secret. Without PIL it prints one note and writes no PNG (exit 0).
Fonts: DejaVu Sans Mono, with fallbacks for symbols, emoji and CJK when installed.
"""
import html
import json
import os
import re
import sys
import unicodedata

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # the suite passes without PNGs
    Image = None

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONTB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FALLBACKS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/mnt/c/Windows/Fonts/CascadiaMono.ttf",
             "/mnt/c/Windows/Fonts/seguisym.ttf", "/mnt/c/Windows/Fonts/seguiemj.ttf", "/mnt/c/Windows/Fonts/msyh.ttc",
             "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
SIZE = 15
CW, CH = 9, 18
PAD = 4

# xterm.js's default 16 colours (`ANSI16` in test/visual/lint.ts).
BASE16 = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
          "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"]
DEFAULTS = {"dark": ("#cccccc", "#0c0c0c"), "light": ("#1e1e1e", "#ffffff")}

SECRET = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ABSK[A-Za-z0-9+/=]{20,}|xai-[A-Za-z0-9]{20,}|"
                    r"sk-ant-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30})")


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def c256(n):
    if n < 16: return rgb(BASE16[n])
    if n < 232:
        n -= 16
        lv = [0, 95, 135, 175, 215, 255]
        return (lv[n // 36], lv[(n // 6) % 6], lv[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


def color(c):
    """-1 / None: default; "#rrggbb"; 0-255 palette; above 255: 0xRRGGBB."""
    if c is None or c == -1: return None
    if isinstance(c, str): return rgb(c)
    if c > 255: return ((c >> 16) & 255, (c >> 8) & 255, c & 255)
    return c256(c)


def width(ch):
    if not ch: return 0
    o = ord(ch[0])
    if unicodedata.combining(ch[0]) or o in (0x200b, 0x200d, 0xfe0f, 0xfe0e): return 0
    if unicodedata.east_asian_width(ch[0]) in ("W", "F"): return 2
    if 0x1f300 <= o <= 0x1faff: return 2
    return 1


def split_cols(text):
    """A row's text as one string per column ("" right halves), by East Asian width."""
    out = []
    for ch in text:
        w = width(ch)
        if w == 0 and out:
            out[-1] += ch
            continue
        out.append(ch)
        if w == 2: out.append("")
    return out


# ── A screen as cells: [[(char, style, width)]] ─────────────────────────────────────────────

def blank_style():
    return dict(fg=None, bg=None, bold=False, dim=False, ul=False, inv=False, it=False)


def from_cells(doc):
    rows = []
    for line in doc["lines"]:
        chars = line.get("chars") or split_cols(line.get("text", ""))
        cols = doc.get("cols", len(chars))
        chars = (chars + [" "] * cols)[:cols] if len(chars) < cols else chars
        styles = [blank_style() for _ in chars]
        for run in line.get("runs", []):
            a, b, flags, fg, bg = run
            for x in range(a, min(b, len(styles))):
                styles[x] = dict(fg=color(fg), bg=color(bg), bold="b" in flags, dim="d" in flags,
                                 ul="u" in flags, inv="i" in flags, it="t" in flags)
        cells = []
        for x, ch in enumerate(chars):
            w = 0 if ch == "" else (2 if x + 1 < len(chars) and chars[x + 1] == "" else 1)
            cells.append((ch or "", styles[x], w))
        rows.append(cells)
    return rows


def apply_sgr(st, params):
    ps = params.split(";") if params else ["0"]
    k = 0
    while k < len(ps):
        p = ps[k]
        if ":" in p:  # 38:2::r:g:b or 38:5:n
            sub = p.split(":")
            if sub[0] in ("38", "48"):
                tgt = "fg" if sub[0] == "38" else "bg"
                nums = [int(x) for x in sub[1:] if x != ""]
                if nums and nums[0] == 5: st[tgt] = c256(nums[1])
                elif nums and nums[0] == 2: st[tgt] = tuple(nums[-3:])
            elif sub[0] == "4": st["ul"] = sub[1] != "0"
            k += 1; continue
        n = int(p) if p else 0
        if n == 0: st.update(blank_style())
        elif n == 1: st["bold"] = True
        elif n == 2: st["dim"] = True
        elif n == 3: st["it"] = True
        elif n == 4: st["ul"] = True
        elif n == 7: st["inv"] = True
        elif n == 22: st["bold"] = st["dim"] = False
        elif n == 23: st["it"] = False
        elif n == 24: st["ul"] = False
        elif n == 27: st["inv"] = False
        elif 30 <= n <= 37: st["fg"] = c256(n - 30)
        elif n == 39: st["fg"] = None
        elif 40 <= n <= 47: st["bg"] = c256(n - 40)
        elif n == 49: st["bg"] = None
        elif 90 <= n <= 97: st["fg"] = c256(n - 90 + 8)
        elif 100 <= n <= 107: st["bg"] = c256(n - 100 + 8)
        elif n in (38, 48):
            tgt = "fg" if n == 38 else "bg"
            if k + 1 < len(ps) and ps[k + 1] == "5":
                st[tgt] = c256(int(ps[k + 2])); k += 2
            elif k + 1 < len(ps) and ps[k + 1] == "2":
                st[tgt] = (int(ps[k + 2]), int(ps[k + 3]), int(ps[k + 4])); k += 4
        k += 1


def from_ansi(text, cols):
    rows = []
    st = blank_style()
    for line in text.rstrip("\n").split("\n"):
        cells = []
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == "\x1b":
                m = re.match(r"\x1b\[([0-9;:]*)m", line[i:])
                if m:
                    apply_sgr(st, m.group(1)); i += m.end(); continue
                m = re.match(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", line[i:])
                if m: i += m.end(); continue
                m = re.match(r"\x1b\[[0-9;?]*[A-Za-z]", line[i:])
                if m: i += m.end(); continue
                i += 1; continue
            j = i + 1
            while j < len(line) and line[j] != "\x1b" and width(line[j]) == 0: j += 1
            w = width(ch)
            cells.append((line[i:j], dict(st), w))
            if w == 2: cells.append(("", dict(st), 0))
            i = j
        rows.append(cells[:cols])
    return rows


# ── Drawing ─────────────────────────────────────────────────────────────────────────────────

_fonts, _cmaps = {}, {}


def has(path, g):
    if not os.path.exists(path): return False
    if path not in _cmaps:
        try:
            from fontTools.ttLib import TTFont
            _cmaps[path] = set(TTFont(path, fontNumber=0, lazy=True).getBestCmap().keys())
        except Exception:
            _cmaps[path] = None  # unknown: take the font as is
    cmap = _cmaps[path]
    return cmap is None or ord(g[0]) in cmap


def font_for(g, bold):
    if (g, bold) in _fonts: return _fonts[(g, bold)]
    path = FONTB if bold else FONT
    if not has(path, g):
        for f in FALLBACKS:
            if has(f, g):
                path = f; break
    try:
        ft = _fonts.get(path) or _fonts.setdefault(path, ImageFont.truetype(path, SIZE))
    except Exception:
        ft = ImageFont.load_default()
    _fonts[(g, bold)] = ft
    return ft


def plain(rows):
    return "\n".join("".join(g for g, _, _ in cells).rstrip() for cells in rows)


def render(rows, cols, out, defaults=DEFAULTS["dark"], cursor=None):
    def_fg, def_bg = rgb(defaults[0]), rgb(defaults[1])
    img = Image.new("RGB", (cols * CW + 2 * PAD, len(rows) * CH + 2 * PAD), def_bg)
    d = ImageDraw.Draw(img)
    for p in (0, 1):
        for y, cells in enumerate(rows):
            # One cell per column: a wide character's right half ("") is drawn with its left (NF-7).
            for x, (g, st, w) in enumerate(cells):
                if w == 0 and g == "":
                    continue
                fg = st["fg"] or def_fg
                bg = st["bg"] or def_bg
                if st["inv"]: fg, bg = bg, fg
                if st["dim"]: fg = tuple(int(c * 0.6 + b * 0.4) for c, b in zip(fg, bg))
                px, py = PAD + x * CW, PAD + y * CH
                span = CW * max(w, 1)
                if p == 0:
                    if bg != def_bg: d.rectangle([px, py, px + span - 1, py + CH - 1], fill=bg)
                else:
                    if g in ("│", "┃", "║"):
                        d.line([px + CW // 2, py, px + CW // 2, py + CH - 1], fill=fg)
                    elif g in ("─", "━"):
                        d.line([px, py + CH // 2, px + CW - 1, py + CH // 2], fill=fg)
                    elif g.strip():
                        d.text((px, py + 1), g, font=font_for(g, st["bold"]), fill=fg)
                    if st["ul"]: d.line([px, py + CH - 2, px + span - 1, py + CH - 2], fill=fg)
    if cursor and cursor.get("visible") and 0 <= cursor["y"] < len(rows):
        px, py = PAD + cursor["x"] * CW, PAD + cursor["y"] * CH
        d.rectangle([px, py, px + CW - 1, py + CH - 1], outline=(255, 64, 160))
    img.save(out)


def save(rows, cols, out, defaults=DEFAULTS["dark"], cursor=None):
    """Writes <out>.txt and the PNG; refuses (False) a screen with a secret-looking string."""
    text = plain(rows)
    m = SECRET.search(text)
    if m:
        print("REFUSED: secret-looking text in screen:", m.group(0)[:6] + "…", file=sys.stderr)
        return False
    with open(out[:-4] + ".txt", "w", encoding="utf-8") as f:
        f.write(text + "\n")
    if Image is None: return True
    render(rows, cols, out, defaults, cursor)
    return True


def load_cells(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    theme = doc.get("theme", "dark")
    dflt = doc.get("defaults") or {}
    defaults = (dflt.get("fg", DEFAULTS[theme][0]), dflt.get("bg", DEFAULTS[theme][1]))
    return doc, from_cells(doc), defaults


# ── Contact sheets and the index ────────────────────────────────────────────────────────────

def size_key(name):
    m = re.match(r"(\d+)x(\d+)-(\w+)", name)
    return (m.group(3) != "dark", int(m.group(1)), int(m.group(2))) if m else (True, 0, 0)


def sheet(dir_):
    if Image is None:
        print("visual review: python3 has no PIL (pip install pillow): no PNGs written")
        return 0
    out_root = os.path.dirname(os.path.abspath(dir_.rstrip("/")))
    sheets_dir = os.path.join(out_root, "sheets")
    os.makedirs(sheets_dir, exist_ok=True)
    entries, refused = [], 0
    for scene in sorted(os.listdir(dir_)):
        sdir = os.path.join(dir_, scene)
        if not os.path.isdir(sdir): continue
        shots = []
        for name in sorted((n for n in os.listdir(sdir) if n.endswith(".json")), key=size_key):
            doc, rows, defaults = load_cells(os.path.join(sdir, name))
            png = os.path.join(sdir, name[:-5] + ".png")
            if not save(rows, doc["cols"], png, defaults, doc.get("cursor")):
                refused += 1; continue
            shots.append((name[:-5], png))
        if not shots: continue
        imgs = [Image.open(p) for _, p in shots]
        label_h = 22
        w = sum(i.width for i in imgs) + 12 * (len(imgs) + 1)
        h = max(i.height for i in imgs) + label_h + 24
        sh = Image.new("RGB", (w, h), (40, 40, 48))
        d = ImageDraw.Draw(sh)
        x = 12
        for (label, _), im in zip(shots, imgs):
            d.text((x, 6), label, font=font_for("a", True), fill=(230, 230, 230))
            sh.paste(im, (x, label_h + 6))
            x += im.width + 12
        path = os.path.join(sheets_dir, f"{scene}.png")
        sh.save(path)
        entries.append((scene, path, shots))
        print(path)
    index = os.path.join(out_root, "index.html")
    with open(index, "w", encoding="utf-8") as f:
        f.write("<!doctype html><meta charset=utf-8><title>Gluon visual review</title>"
                "<style>body{font:14px system-ui;background:#16171b;color:#ddd;margin:16px}"
                "pre{font:11px/1.25 monospace;background:#0c0c0c;padding:8px;overflow:auto;max-height:480px}"
                "img{max-width:100%;border:1px solid #333}.row{display:flex;gap:12px;align-items:flex-start}"
                "h2{margin-top:32px}</style><h1>Gluon visual review</h1><ul>")
        for scene, _, _ in entries:
            f.write(f'<li><a href="#{html.escape(scene)}">{html.escape(scene)}</a></li>')
        f.write("</ul>")
        for scene, path, shots in entries:
            f.write(f'<h2 id="{html.escape(scene)}">{html.escape(scene)}</h2>'
                    f'<img src="{html.escape(os.path.relpath(path, out_root))}">')
            for label, png in shots:
                base = png[:-4]
                golden = open(base + ".golden.txt", encoding="utf-8").read() if os.path.exists(base + ".golden.txt") else ""
                lint = open(base + ".lint.txt", encoding="utf-8").read() if os.path.exists(base + ".lint.txt") else ""
                f.write(f"<h3>{html.escape(label)}</h3><div class=row><img src=\"{html.escape(os.path.relpath(png, out_root))}\">"
                        f"<pre>{html.escape(golden)}</pre></div>")
                if lint.strip(): f.write(f"<pre>lint:\n{html.escape(lint)}</pre>")
    print(index)
    return 2 if refused else 0


def main():
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == "--cells":
        doc, rows, defaults = load_cells(a[1])
        if Image is None: print("render.py: python3 has no PIL (pip install pillow): no PNG written")
        ok = save(rows, doc["cols"], a[2], defaults, doc.get("cursor"))
    elif len(a) == 4 and a[0] == "--ansi":
        text = open(a[1], encoding="utf-8", errors="replace").read()
        if Image is None: print("render.py: python3 has no PIL (pip install pillow): no PNG written")
        ok = save(from_ansi(text, int(a[2])), int(a[2]), a[3])
    elif len(a) == 2 and a[0] == "--sheet":
        sys.exit(sheet(a[1]))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(64)
    if not ok: sys.exit(2)
    print(a[-1])


if __name__ == "__main__":
    main()
