"""Developer mode helper.

The test build lives in dev/, a full copy of the app. Phones with developer
mode on (7 taps on the version number in Me) load it; everyone else keeps the
app at the root.

  python tools/devmode.py fresh     copy the live app into dev/ (start over)
  python tools/devmode.py check     list what dev/ changes compared to live
  python tools/devmode.py promote   copy dev/ over the live app (the real push)
"""
import filecmp, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEV = ROOT / 'dev'
APP = ['index.html', 'styles.css', 'config.js', 'manifest.webmanifest', 'manifest-demo.webmanifest', 'js', 'icons']


def copy(src, dst):
    for name in APP:
        s, d = src / name, dst / name
        if s.is_dir():
            shutil.copytree(s, d, dirs_exist_ok=True)
        elif s.exists():
            shutil.copy2(s, d)


def changed():
    out = []
    for name in APP:
        s, d = DEV / name, ROOT / name
        files = [p.relative_to(DEV) for p in s.rglob('*') if p.is_file()] if s.is_dir() else [Path(name)]
        out += [str(f) for f in files if not (ROOT / f).exists() or not filecmp.cmp(DEV / f, ROOT / f, shallow=False)]
    return out


cmd = sys.argv[1] if len(sys.argv) > 1 else 'check'
if cmd == 'fresh':
    DEV.mkdir(exist_ok=True)
    copy(ROOT, DEV)
    print('dev/ now matches the live app')
elif cmd == 'check':
    print('\n'.join(changed()) or 'dev/ is the same as live')
elif cmd == 'promote':
    files = changed()
    copy(DEV, ROOT)
    # New cache name so installed apps pick up the update.
    sw = ROOT / 'sw.js'
    text = sw.read_text(encoding='utf-8')
    text = re.sub(r"pulse-v(\d+)", lambda m: f"pulse-v{int(m.group(1)) + 1}", text, count=1)
    sw.write_text(text, encoding='utf-8')
    print('promoted:', ', '.join(files) or 'nothing')
