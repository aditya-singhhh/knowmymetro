"""
Builds the shareable web preview as ONE self-contained HTML file (for a hosted link that
only allows inline code). Run from app/:
  WEB_DEMO=1 EXPO_OFFLINE=1 npx expo export --platform web --output-dir dist-web
  python3 scripts/web-demo.py dist-web knowmymetro-web.html
"""
import base64, glob, os, re, sys

src, out = sys.argv[1], sys.argv[2]
html = open(os.path.join(src, 'index.html')).read()
js = ''.join(open(p).read() for p in sorted(glob.glob(os.path.join(src, '_expo/static/js/web/*.js'))))
css = ''.join(open(p).read() for p in sorted(glob.glob(os.path.join(src, '_expo/static/css/*.css'))))

def data_uri(url):
    path = os.path.join(src, url.lstrip('/'))
    base, ext = os.path.splitext(path)
    for cand in (f'{base}@3x{ext}', f'{base}@2x{ext}', path):
        if os.path.exists(cand):
            return f'data:image/{ext[1:]};base64,' + base64.b64encode(open(cand, 'rb').read()).decode()
    return url

js = re.sub(r'"(/assets/[^"]+\.(?:png|jpg|jpeg|gif|webp))"', lambda m: '"' + data_uri(m.group(1)) + '"', js)
js = js.replace('</script', '<\\/script')
reset = re.search(r'<style id="expo-reset">(.*?)</style>', html, re.S).group(1)

page = f"""<title>KnowMyMetro</title>
<style>{reset}
{css}
/* Phone-style bottom tab bar (the web default floats a pill over the header) */
:root {{ --kmm-bg: #F2F2F7; --kmm-bar: #FFFFFF; --kmm-sep: #E3E3E8; --kmm-ink2: #6B6B72; --kmm-tint: #7B2268; --kmm-tint-bg: #F4E6F0; }}
@media (prefers-color-scheme: dark) {{ :root {{ --kmm-bg: #000000; --kmm-bar: #1C1C1F; --kmm-sep: #2E2E33; --kmm-ink2: #9C9CA4; --kmm-tint: #E08BCF; --kmm-tint-bg: #3A1A33; }} }}
html, body {{ background: var(--kmm-bg); }}
[class*="nativeTabsContainer"] {{ max-height: 100%; }}
[class*="tabContent"] {{ padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px)); box-sizing: border-box; }}
[class*="navigationMenuRoot"] {{ top: auto; bottom: 0; left: 0; right: 0; transform: none; max-width: none; width: 100%;
  height: calc(64px + env(safe-area-inset-bottom, 0px)); padding: 6px 12px env(safe-area-inset-bottom, 0px); border-radius: 0;
  background: var(--kmm-bar); border-top: 1px solid var(--kmm-sep); justify-content: space-around; gap: 8px; }}
[class*="navigationMenuRoot"] ul {{ display: flex; width: 100%; justify-content: space-around; margin: 0; padding: 0; }}
[class*="navigationMenuTrigger"] {{ flex: 1; height: 44px; border-radius: 22px; }}
[class*="navigationMenuTrigger"][data-state=active] {{ background: var(--kmm-tint-bg); }}
[class*="tabText"] {{ color: var(--kmm-ink2); font-size: 15px; }}
[class*="navigationMenuTrigger"][data-state=active] [class*="tabText"] {{ color: var(--kmm-tint); font-weight: 600; }}
</style>
<div id="root"></div>
<script>try {{ if (location.pathname !== '/') history.replaceState(null, '', '/'); }} catch (e) {{}}</script>
<script>{js}</script>
"""
open(out, 'w').write(page)
print(f'{out}: {len(page)/1e6:.2f} MB')
