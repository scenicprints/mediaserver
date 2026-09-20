"""Builds the Roku app's generated assets from the web app's own sources.

Roku Labels can't letter-space and custom fonts get no glyph fallback, so the
web look (tracked small caps, the Braun symbols ★ ✓ ▶ and friends) has to be
baked into the font files themselves:

  * every Archivo / Roboto Mono weight the web uses, with the symbols the UI
    prints merged in from Noto / DejaVu (what Android's fallback chain draws),
  * a tracked copy for each letter-spacing the CSS asks for (CSS letter-spacing
    adds the same space after every glyph, which is exactly a wider advance).

Colour emoji (row titles, a few buttons) are Noto Color Emoji PNGs, the font
Android TV draws them with.

Run:  python roku/tools/build_assets.py
Needs: pip install fonttools pillow. Downloads its source fonts into
roku/tools/.cache (git-ignored). Output goes to roku/lib/fonts and
roku/lib/images/emoji, and a copy of the fonts to roku/shell/fonts.
"""
import os
import re
import shutil
import sys
import urllib.request

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROKU = os.path.dirname(HERE)
REPO = os.path.dirname(ROKU)
CACHE = os.path.join(HERE, '.cache')
WEBFONTS = os.path.join(REPO, 'public', 'fonts')
OUT_FONTS = os.path.join(ROKU, 'lib', 'fonts')
OUT_EMOJI = os.path.join(ROKU, 'lib', 'images', 'emoji')

SOURCES = {
    'NotoSansSymbols2-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf',
    'NotoSansSymbols.ttf': 'https://github.com/google/fonts/raw/main/ofl/notosanssymbols/NotoSansSymbols%5Bwght%5D.ttf',
    'NotoSansMath-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/notosansmath/NotoSansMath-Regular.ttf',
    # Android's default sans: what text inputs (search, sign-in, settings fields) draw in.
    'Roboto-VF.ttf': 'https://github.com/google/fonts/raw/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf',
}
FALLBACKS = ['NotoSansSymbols2-Regular.ttf', 'NotoSansSymbols.ttf', 'NotoSansMath-Regular.ttf', 'DejaVuSans.ttf']

# Every non-ASCII character the UI can print as TEXT (emoji are images, below).
SYMBOLS = '–—’“”…‹›←↑→↓↺↻⇒−≠≥⏭⏱⏸⏹ⓘ▲▶▸▼◀○●★☆☘⚙⚠✓✕✖⟳⬆⬇＋×·•❚'

# (file stem, source ttf, tracking in em). Tracking values are the CSS
# letter-spacing values the web uses, in em (px values divided by font-size).
VARIANTS = [
    ('A400', 'Archivo-Regular.ttf', 0.0),
    ('A500', 'Archivo-Medium.ttf', 0.0),
    ('A600', 'Archivo-SemiBold.ttf', 0.0),
    ('A400t20', 'Archivo-Regular.ttf', 0.20),    # .vp-st, uppercase subtitles
    ('A500t10', 'Archivo-Medium.ttf', 0.10),     # chips / badges / tags
    ('A500t16', 'Archivo-Medium.ttf', 0.16),     # nav tabs
    ('A500n01', 'Archivo-Medium.ttf', -0.01),    # hero + detail titles (letter-spacing -0.01em)
    ('A600t04', 'Archivo-SemiBold.ttf', 0.04),   # 800-weight labels with .3-.5px tracking
    ('A600t10', 'Archivo-SemiBold.ttf', 0.10),   # .ec-sub / .un / at-tag caps
    ('A600t14', 'Archivo-SemiBold.ttf', 0.143),  # .lt-name (2px on 14px)
    ('A600t16', 'Archivo-SemiBold.ttf', 0.16),   # buttons, player controls, settings tabs
    ('A600t20', 'Archivo-SemiBold.ttf', 0.20),   # row titles
    ('A600t25', 'Archivo-SemiBold.ttf', 0.25),   # buffering wordmark (10px on 40px)
    ('A600t30', 'Archivo-SemiBold.ttf', 0.30),   # the MARQUEE brand
    ('A400i', 'Archivo-Regular.ttf', 0.0),        # font-style: italic with no italic face: Chrome's synthetic oblique
    ('R400', 'Roboto-Regular.ttf', 0.0),          # <input> text (Chrome gives inputs the system sans)
    # The native player (PlayerActivity) is Android TextViews: Roboto, with
    # android:letterSpacing in em.
    ('R400t06', 'Roboto-Regular.ttf', 0.06),       # time "0:00 / 0:00"
    ('R400t08', 'Roboto-Regular.ttf', 0.08),       # the key hint
    ('R400t22', 'Roboto-Regular.ttf', 0.22),       # "LOADING…"
    ('R400t30', 'Roboto-Regular.ttf', 0.30),       # "LIVE"
    ('R700', 'Roboto-Bold.ttf', 0.0),              # title, play icon
    ('R700t18', 'Roboto-Bold.ttf', 0.18),          # SKIP INTRO / SKIP CREDITS
    ('R700t24', 'Roboto-Bold.ttf', 0.24),          # subtitles menu header
    ('R700t35', 'Roboto-Bold.ttf', 0.35),          # buffering "MARQUEE"
    ('M400', 'RobotoMono-Regular.ttf', 0.0),
    ('M500', 'RobotoMono-Medium.ttf', 0.0),
    ('M500t10', 'RobotoMono-Medium.ttf', 0.10),   # chips inside mono rows (.hero-meta .chip)
    ('M400t04', 'RobotoMono-Regular.ttf', 0.04),  # .vp-time
    ('M400t08', 'RobotoMono-Regular.ttf', 0.08),  # .hero-meta
]

# Emoji the UI prints, as they appear in the source (with any VS16 kept, which
# is how the browser decides to draw them in colour).
EMOJI_SOURCE_FILES = [os.path.join(REPO, 'public', 'app.js'), os.path.join(REPO, 'public', 'index.html')]


def fetch(name, url):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('downloading', name)
        os.makedirs(CACHE, exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return path


def ensure_sources():
    for name, url in SOURCES.items():
        fetch(name, url)
    dv = os.path.join(CACHE, 'DejaVuSans.ttf')
    if not os.path.exists(dv):
        import io
        import zipfile
        print('downloading DejaVu')
        data = urllib.request.urlopen('https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip').read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for n in z.namelist():
                if n.endswith('/ttf/DejaVuSans.ttf'):
                    open(dv, 'wb').write(z.read(n))


def add_glyph(font, name, glyph, advance, lsb):
    order = font.getGlyphOrder()
    if name not in order:
        order.append(name)
        font.setGlyphOrder(order)
    font['glyf'][name] = glyph
    font['hmtx'][name] = (advance, lsb)


def merge_symbols(font):
    """Copy every SYMBOLS glyph the font lacks from the first fallback that has it."""
    upm = font['head'].unitsPerEm
    cmap = font.getBestCmap()
    fallbacks = [TTFont(os.path.join(CACHE, f)) for f in FALLBACKS]
    added = {}
    for ch in SYMBOLS:
        cp = ord(ch)
        if cp in cmap:
            continue
        if ch == '＋':  # fullwidth plus: Android draws it from CJK; a centred '+' on a 1em advance
            src_font, src_name = font, cmap[ord('+')]
        else:
            src_font = next((f for f in fallbacks if cp in f.getBestCmap()), None)
            if src_font is None:
                print('  no glyph anywhere for U+%04X' % cp)
                continue
            src_name = src_font.getBestCmap()[cp]
        scale = upm / src_font['head'].unitsPerEm
        gs = src_font.getGlyphSet()
        rec = DecomposingRecordingPen(gs)
        gs[src_name].draw(rec)
        pen = TTGlyphPen(None)
        adv = src_font['hmtx'][src_name][0] * scale
        dx = 0
        if ch == '＋':
            dx = (upm - adv) / 2
            adv = upm
        rec.replay(TransformPen(pen, (scale, 0, 0, scale, dx, 0)))
        glyph = pen.glyph()
        name = 'mq_uni%04X' % cp
        glyph.recalcBounds(font['glyf'])
        add_glyph(font, name, glyph, int(round(adv)), getattr(glyph, 'xMin', 0))
        added[cp] = name
    for table in font['cmap'].tables:
        if table.isUnicode():
            for cp, name in added.items():
                if table.format == 4 and cp > 0xFFFF:
                    continue
                table.cmap[cp] = name


def track(font, em):
    if not em:
        return
    extra = int(round(em * font['head'].unitsPerEm))
    hmtx = font['hmtx']
    for name in font.getGlyphOrder():
        adv, lsb = hmtx[name]
        if adv > 0:
            hmtx[name] = (max(1, adv + extra), lsb)
    font['hhea'].advanceWidthMax += extra


def oblique(font, skew=0.25):
    """Skia's fake italic: shear every outline by 1/4 (x += y/4), as Chrome does
    for font-style: italic when the family has no italic face."""
    glyf = font['glyf']
    gs = font.getGlyphSet()
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.numberOfContours == 0:
            continue
        rec = DecomposingRecordingPen(gs)
        gs[name].draw(rec)
        pen = TTGlyphPen(None)
        rec.replay(TransformPen(pen, (1, 0, skew, 1, 0, 0)))
        ng = pen.glyph()
        ng.recalcBounds(glyf)
        glyf[name] = ng
        adv, _ = font['hmtx'][name]
        font['hmtx'][name] = (adv, getattr(ng, 'xMin', 0))


def roboto_static(weight):
    name = 'Roboto-Regular.ttf' if weight == 400 else 'Roboto-Bold.ttf'
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        from fontTools.varLib import instancer
        vf = TTFont(os.path.join(CACHE, 'Roboto-VF.ttf'))
        instancer.instantiateVariableFont(vf, {'wght': weight, 'wdth': 100}, inplace=True)
        vf.save(path)
    return path


def build_fonts():
    os.makedirs(OUT_FONTS, exist_ok=True)
    for stem, src, em in VARIANTS:
        if src == 'Roboto-Regular.ttf':
            srcpath = roboto_static(400)
        elif src == 'Roboto-Bold.ttf':
            srcpath = roboto_static(700)
        else:
            srcpath = os.path.join(WEBFONTS, src)
        font = TTFont(srcpath)
        merge_symbols(font)
        track(font, em)
        if stem.endswith('i'):
            oblique(font)
        # A distinct family name per variant, so no platform ever treats two of
        # them as the same face and hands back the wrong spacing from a cache.
        for rec in font['name'].names:
            if rec.nameID in (1, 4, 6, 16):
                base = rec.toUnicode()
                rec.string = (base.replace(' ', '') if rec.nameID == 6 else base) + ('-' if rec.nameID == 6 else ' ') + 'MQ' + stem
        out = os.path.join(OUT_FONTS, stem + '.ttf')
        font.save(out)
        print('font', stem, os.path.getsize(out) // 1024, 'KB')
    for lic in ('OFL-Archivo.txt', 'OFL-RobotoMono.txt'):
        shutil.copy(os.path.join(WEBFONTS, lic), OUT_FONTS)
    shutil.copy(os.path.join(CACHE, 'OFL.txt') if os.path.exists(os.path.join(CACHE, 'OFL.txt')) else os.path.join(WEBFONTS, 'OFL-Archivo.txt'), os.path.join(OUT_FONTS, 'OFL-Noto.txt'))


# ---------------------------------------------------------------- emoji
# Characters that draw as colour emoji by default (Emoji_Presentation=Yes) or
# because the source follows them with VS16.
EMOJI_RE = re.compile(
    '(?:[\U0001F1E6-\U0001F1FF]{2})'                                 # flags
    '|(?:[\U0001F300-\U0001FAFF][\U0001F3FB-\U0001F3FF]?️?)'   # SMP pictographs
    '|(?:[⌀-➿⬀-⯿]️)'                        # BMP symbol + VS16
    '|(?:[⏩-⏬⏰⏳⌚⌛◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕])'
)


def emoji_file(seq):
    cps = [ord(c) for c in seq if ord(c) != 0xFE0F]
    return 'emoji_u' + '_'.join('%04x' % c for c in cps) + '.png'


def build_emoji():
    os.makedirs(OUT_EMOJI, exist_ok=True)
    found = set()
    for f in EMOJI_SOURCE_FILES:
        found.update(m.group(0) for m in EMOJI_RE.finditer(open(f, encoding='utf-8').read()))
    table = []
    for seq in sorted(found):
        name = emoji_file(seq)
        out = os.path.join(OUT_EMOJI, name.replace('emoji_u', ''))
        if not os.path.exists(out):
            url = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/72/' + name
            cps = [ord(c) for c in seq]
            if len(cps) == 2 and all(0x1F1E6 <= c <= 0x1F1FF for c in cps):  # flags live apart
                url = ('https://raw.githubusercontent.com/googlefonts/noto-emoji/main/third_party/region-flags/png/'
                       + ''.join(chr(c - 0x1F1E6 + 65) for c in cps) + '.png')
            try:
                urllib.request.urlretrieve(url, out)
            except Exception as e:  # noqa: BLE001
                print('  emoji missing', repr(seq), url, e)
                continue
            if 'region-flags' in url:  # a bare flag image: set it in a 72px emoji cell like the rest
                from PIL import Image
                flag = Image.open(out).convert('RGBA')
                w = 64
                flag = flag.resize((w, round(flag.height * w / flag.width)), Image.LANCZOS)
                cell = Image.new('RGBA', (72, 72), (0, 0, 0, 0))
                cell.paste(flag, ((72 - flag.width) // 2, (72 - flag.height) // 2))
                cell.save(out)
        table.append(seq)
    # The BrightScript side needs the list: each sequence and its file.
    lines = ['{']
    for seq in table:
        key = ''.join('%04X' % ord(c) for c in seq)
        lines.append('  "%s": "%s",' % (key, emoji_file(seq).replace('emoji_u', '')))
    lines[-1] = lines[-1].rstrip(',')
    lines.append('}')
    open(os.path.join(ROKU, 'lib', 'images', 'emoji.json'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print('emoji', len(table))


# ---------------------------------------------------------------- icons
# White on transparent; the app tints them with Poster.blendColor. Paths are the
# web app's own (index.html settings gear, app.js ICONS). Sizes are device px on
# the 1920x1080 canvas (CSS px x 2, see Theme.brs).
OUT_ICONS = os.path.join(ROKU, 'lib', 'images', 'icons')
NAV_GEAR = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" '
            'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>')
FILLED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="%s"/></svg>'
STROKED = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" '
           'stroke-linecap="round"><path d="%s"/></svg>')
ICONS = {
    'navgear': (NAV_GEAR, 40),
    'play': (FILLED % 'M8 5v14l11-7z', 100),
    'pause': (FILLED % 'M6 5h4v14H6zm8 0h4v14h-4z', 100),
    'back': (STROKED % 'M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6', 88),
    'fwd': (STROKED % 'M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6', 88),
    'gear': (FILLED % 'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1l-.4-2.5H10.9l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-.9-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-.9c.5.4 1.1.7 1.7 1l.3 2.5h4.2l.4-2.5c.6-.3 1.2-.6 1.7-1l2.3.9 2-3.4-2-1.5zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z', 52),
    'skipnext': (FILLED % 'M6 5l8.5 7L6 19V5zm10.5 0H19v14h-2.5V5z', 30),
}


def build_icons():
    import resvg_py
    os.makedirs(OUT_ICONS, exist_ok=True)
    for name, (svg, px) in ICONS.items():
        svg = svg.replace('viewBox="0 0 24 24"', 'viewBox="0 0 24 24" width="%d" height="%d"' % (px, px), 1)
        data = resvg_py.svg_to_bytes(svg_string=svg)
        open(os.path.join(OUT_ICONS, name + '.png'), 'wb').write(bytes(data))
    # Circles: a disc, and rings at the exact sizes/strokes the CSS draws (a
    # scaled ring would scale its stroke too). Supersampled for smooth edges.
    from PIL import Image, ImageDraw

    def circle(name, d, stroke=None):
        ss = 4
        im = Image.new('RGBA', (d * ss, d * ss), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im)
        if stroke:
            dr.ellipse((0, 0, d * ss - 1, d * ss - 1), outline=(255, 255, 255, 255), width=stroke * ss)
        else:
            dr.ellipse((0, 0, d * ss - 1, d * ss - 1), fill=(255, 255, 255, 255))
        im.resize((d, d), Image.LANCZOS).save(os.path.join(OUT_ICONS, name + '.png'))
    circle('disc', 256)
    circle('ring80', 80, 2)    # .icon-btn: 40px, 1px border
    circle('ring64', 64, 3)    # .round card action: 32px, 1.5px border
    circle('ring56', 56, 3)    # .wtoggle: 28px, 1.5px border
    print('icons', len(ICONS) + 4)


# ---------------------------------------------------------------- focus glows
# The web's focus ring is a box-shadow stack: `0 0 0 3px var(--accent),
# 0 0 0 6px rgba(222,95,16,.32), 0 0 22px rgba(222,95,16,.55)`. Roku can't draw
# shadows, so each stack is baked into a 9-patch the app lays around the
# element (inset by the margin M). Device px (CSS x 2). One per finish, because
# the ring is var(--accent) and that differs between them.
ACCENTS = {'black': (0xF2, 0x6A, 0x16), 'white': (0xDE, 0x5F, 0x10)}
OUT_GLOW = os.path.join(ROKU, 'lib', 'images', 'glow')


def shadow_stack(w, h, layers, circle=False):
    """Render box-shadows around a w x h box (device px) the way CSS does:
    spread rings are the box grown by `spread`, blurs are gaussian with sigma =
    blur/2. The box itself stays transparent."""
    from PIL import Image, ImageDraw, ImageFilter
    M = max(l[0] + l[1] for l in layers) + 4
    W, H = w + 2 * M, h + 2 * M
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for spread, blur, rgba in reversed(layers):  # CSS paints the first shadow on top
        mask = Image.new('L', (W, H), 0)
        d = ImageDraw.Draw(mask)
        box = (M - spread, M - spread, M + w + spread - 1, M + h + spread - 1)
        (d.ellipse if circle else d.rectangle)(box, fill=255)
        if blur:
            mask = mask.filter(ImageFilter.GaussianBlur(blur / 2))
        layer = Image.new('RGBA', (W, H), rgba[:3] + (0,))
        alpha = mask.point(lambda v, a=rgba[3]: int(v * a / 255))
        layer.putalpha(alpha)
        out = Image.alpha_composite(out, layer)
    # Punch the element's own box back out: shadows only paint outside it.
    hole = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(hole)
    (d.ellipse if circle else d.rectangle)((M, M, M + w - 1, M + h - 1), fill=0)
    r, g, b, a = out.split()
    a = Image.composite(a, Image.new('L', (W, H), 0), hole)
    out.putalpha(a)
    return out, M


def nine_patch(img, M, path):
    """Wrap as an Android/Roku .9.png: 1px guides mark the stretchable middle."""
    from PIL import Image
    W, H = img.size
    out = Image.new('RGBA', (W + 2, H + 2), (0, 0, 0, 0))
    out.paste(img, (1, 1))
    black = (0, 0, 0, 255)
    for x in range(M + 1, W - M + 1):
        out.putpixel((x, 0), black)
    for y in range(M + 1, H - M + 1):
        out.putpixel((0, y), black)
    out.save(path)


def build_glows():
    os.makedirs(OUT_GLOW, exist_ok=True)
    halo = lambda a: (222, 95, 16, int(a * 255))
    meta = {}
    for fin, acc in ACCENTS.items():
        ring = acc + (255,)
        # .btn/.nav-link/.tab/... : 3px accent, 6px 32% halo, 22px 55% glow.
        stacks = {
            'ring': [(3, 0, ring), (6, 0, halo(0.32)), (0, 22, halo(0.55))],
            # .episode.tv-focus: 2px accent ring, 20px 50% glow.
            'ring2': [(2, 0, ring), (0, 20, halo(0.5))],
        }
        for name, layers in stacks.items():
            dev = [(sp * 2, bl * 2, c) for sp, bl, c in layers]
            img, M = shadow_stack(64, 64, dev)
            nine_patch(img, M, os.path.join(OUT_GLOW, '%s_%s.9.png' % (name, fin)))
            meta[name] = M / 2  # CSS px the image extends past the element
        # .icon-btn is a 40px circle: its shadow is a circle too (not stretchable).
        dev = [(sp * 2, bl * 2, c) for sp, bl, c in stacks['ring']]
        img, M = shadow_stack(80, 80, dev, circle=True)
        img.save(os.path.join(OUT_GLOW, 'circle40_%s.png' % fin))
        meta['circle40'] = M / 2
    import json
    json.dump(meta, open(os.path.join(OUT_GLOW, 'glow.json'), 'w'))
    print('glows', meta)



def build_pop():
    """--shadow-pop: box-shadow 0 18px 44px rgba(0,0,0,a), a = .6 (Black) or .18
    (White). Under .dp-poster, .sheet and .auth-card. Baked around a 280px
    (device) box with the 18px drop included; only a 2px strip through the
    middle stretches, so the soft edges keep their real profile on any element
    at least 280 device px wide/tall (the smallest, the poster, is 380x570)."""
    from PIL import Image, ImageDraw, ImageFilter
    B, DY, BLUR = 280, 36, 88           # device px (CSS x2)
    sigma = BLUR / 2
    M = int(3 * sigma + DY + 8)
    W = H = B + 2 * M
    for fin, a in (('black', 0.6), ('white', 0.18)):
        mask = Image.new('L', (W, H), 0)
        ImageDraw.Draw(mask).rectangle((M, M + DY, M + B - 1, M + DY + B - 1), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(sigma))
        alpha = mask.point(lambda v: int(v * a))
        hole = Image.new('L', (W, H), 255)
        ImageDraw.Draw(hole).rectangle((M, M, M + B - 1, M + B - 1), fill=0)
        alpha = Image.composite(alpha, Image.new('L', (W, H), 0), hole)
        img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        img.putalpha(alpha)
        out = Image.new('RGBA', (W + 2, H + 2), (0, 0, 0, 0))
        out.paste(img, (1, 1))
        mid = M + B // 2
        for i in (mid, mid + 1):
            out.putpixel((i + 1, 0), (0, 0, 0, 255))
            out.putpixel((0, i + 1), (0, 0, 0, 255))
        out.save(os.path.join(OUT_GLOW, 'pop_%s.9.png' % fin))
    print('pop margin (css px)', M / 2)


# ---------------------------------------------------------------- gradients
# CSS linear-gradients the Roku can't draw, baked 1:1 as stretched images.
# (name, height device px, direction 'down' = stops run top->bottom, stops)
OUT_GRAD = os.path.join(ROKU, 'lib', 'images', 'grad')
GRADIENTS = [
    # .card-info: linear-gradient(0deg, rgba(6,7,11,.95) 20%, rgba(6,7,11,0) 100%)
    ('cardinfo', 248, 'up', [(0.20, (6, 7, 11, 0.95)), (1.0, (6, 7, 11, 0.0))]),
    # PlayerActivity HUD: top band TOP_BOTTOM argb(178,0,0,0) -> transparent,
    # bottom band BOTTOM_TOP argb(200,0,0,0) -> transparent.
    ('hudtop', 256, 'down', [(0.0, (0, 0, 0, 178 / 255)), (1.0, (0, 0, 0, 0.0))]),
    ('hudbottom', 256, 'up', [(0.0, (0, 0, 0, 200 / 255)), (1.0, (0, 0, 0, 0.0))]),
]


def premul_mix(c0, c1, f):
    """Mix two (r, g, b, a) stops the way CSS gradients do: in premultiplied
    alpha. Straight per-channel mixing drags an opaque stop toward a translucent
    one's colour too early (it made the White-finish Live TV fade too dark)."""
    a = c0[3] + (c1[3] - c0[3]) * f
    if a <= 0:
        return (c1[0], c1[1], c1[2], 0.0)
    rgb = tuple((c0[i] * c0[3] * (1 - f) + c1[i] * c1[3] * f) / a for i in range(3))
    return rgb + (a,)


def lerp_stops(stops, t):
    if t <= stops[0][0]:
        return stops[0][1]
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            f = (t - p0) / (p1 - p0) if p1 > p0 else 0
            return premul_mix(c0, c1, f)
    return stops[-1][1]


def build_gradients(extra=()):
    from PIL import Image
    os.makedirs(OUT_GRAD, exist_ok=True)
    for name, h, direction, stops in list(GRADIENTS) + list(extra):
        im = Image.new('RGBA', (4, h))
        for y in range(h):
            t = (y + 0.5) / h
            if direction == 'up':
                t = 1 - t
            r, g, b, a = lerp_stops(stops, t)
            # CSS interpolates in premultiplied space; for one colour fading to
            # transparent that is the same colour with a linear alpha ramp.
            for x in range(4):
                im.putpixel((x, y), (round(r), round(g), round(b), round(a * 255)))
        im.save(os.path.join(OUT_GRAD, name + '.png'))
    # Live TV: the preview fade is two stacked CSS gradients (and its base colour
    # is var(--bg-2), so one image per finish); the selected channel cell's wash
    # runs left to right; a live block is a 120deg two-stop gradient.
    for fin, bg2 in (('black', (35, 35, 39)), ('white', (239, 238, 233))):
        W, H = 480, 160
        im = Image.new('RGBA', (W, H))
        for y in range(H):
            t = 1 - (y + 0.5) / H          # 0deg: 0% at the bottom
            if t <= 0.02:
                v = bg2 + (1.0,)
            elif t <= 0.45:
                f = (t - 0.02) / 0.43
                v = premul_mix(bg2 + (1.0,), (11, 12, 16, 0.5), f)
            else:
                f = (t - 0.45) / 0.55
                v = (11, 12, 16, 0.5 + (0.1 - 0.5) * f)
            for x in range(W):
                u = (x + 0.5) / W
                a2 = 0.9 * (1 - u / 0.62) if u < 0.62 else 0.0   # the 90deg layer
                # CSS paints the FIRST background layer on top: the 0deg fade (v)
                # goes over the 90deg rgba(11,12,16,a2) darkening.
                a1 = v[3]
                out_a = a1 + a2 * (1 - a1)
                if out_a <= 0:
                    im.putpixel((x, y), (0, 0, 0, 0))
                    continue
                base = (11, 12, 16)
                c = [(v[i] * a1 + base[i] * a2 * (1 - a1)) / out_a for i in range(3)]
                im.putpixel((x, y), (round(c[0]), round(c[1]), round(c[2]), round(out_a * 255)))
        im.save(os.path.join(OUT_GRAD, 'ltfade_%s.png' % fin))
    im = Image.new('RGBA', (256, 4))
    for x in range(256):
        u = (x + 0.5) / 256
        a = 0.42 + (0.10 - 0.42) * u
        for y in range(4):
            im.putpixel((x, y), (222, 95, 16, round(a * 255)))
    im.save(os.path.join(OUT_GRAD, 'ltchansel.png'))
    import math
    W, H = 256, 32
    im = Image.new('RGBA', (W, H))
    ang = math.radians(120)
    dx, dy = math.sin(ang), -math.cos(ang)          # CSS: 0deg points up, clockwise
    L = abs(W * dx) + abs(H * dy)
    for y in range(H):
        for x in range(W):
            px, py = x + 0.5 - W / 2, y + 0.5 - H / 2
            t = (px * dx + py * dy) / L + 0.5
            c0, c1 = (0x23, 0x2A, 0x44), (0x1A, 0x1F, 0x30)
            im.putpixel((x, y), tuple(round(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,))
    im.save(os.path.join(OUT_GRAD, 'ltlive.png'))
    print('gradients', len(GRADIENTS) + len(extra) + 4)


# ---------------------------------------------------------------- shell
# The sideloaded shell's own package: home-screen poster, splash, and the two
# fonts its loading screen uses (the shell can't reach the library's files).
OUT_SHELL = os.path.join(ROKU, 'shell')


def build_shell():
    from PIL import Image, ImageDraw, ImageFont
    os.makedirs(os.path.join(OUT_SHELL, 'images'), exist_ok=True)
    os.makedirs(os.path.join(OUT_SHELL, 'fonts'), exist_ok=True)
    for stem in ('A600t30', 'A600t16'):
        shutil.copy(os.path.join(OUT_FONTS, stem + '.ttf'), os.path.join(OUT_SHELL, 'fonts'))
    shutil.copy(os.path.join(OUT_FONTS, 'OFL-Archivo.txt'), os.path.join(OUT_SHELL, 'fonts'))
    brand = os.path.join(OUT_FONTS, 'A600t30.ttf')

    def card(w, h, size, name, fmt):
        im = Image.new('RGB', (w, h), (0x14, 0x14, 0x16))
        d = ImageDraw.Draw(im)
        f = ImageFont.truetype(brand, size)
        text = 'MARQUEE'
        box = d.textbbox((0, 0), text, font=f)
        tw = box[2] - box[0] - size * 0.3  # the tracking after the last letter isn't ink
        d.text(((w - tw) / 2 - box[0], (h - (box[3] - box[1])) / 2 - box[1]), text, font=f, fill=(0xEF, 0xEE, 0xE9))
        im.save(os.path.join(OUT_SHELL, 'images', name), fmt, quality=92)
    card(540, 405, 56, 'poster_fhd.png', 'PNG')
    card(290, 218, 30, 'poster_hd.png', 'PNG')
    card(1920, 1080, 68, 'splash_fhd.jpg', 'JPEG')
    card(1280, 720, 45, 'splash_hd.jpg', 'JPEG')
    print('shell images')


if __name__ == '__main__':
    ensure_sources()
    what = sys.argv[1:] or ['fonts', 'emoji', 'icons', 'glows', 'gradients', 'shell']
    if 'fonts' in what:
        build_fonts()
    if 'emoji' in what:
        build_emoji()
    if 'icons' in what:
        build_icons()
    if 'glows' in what:
        build_glows()
    if 'glows' in what or 'pop' in what:
        build_pop()
    if 'gradients' in what:
        build_gradients()
    if 'shell' in what:
        build_shell()
