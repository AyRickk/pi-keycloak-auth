"""Drive pi in a pseudo-terminal and render its screen with pyte (pip install pyte)."""
import os, pty, re, select, sys, time, signal
import pyte

COLS, ROWS = 700, 45  # wide, so long URLs stay on one line
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

class Pi:
    def __init__(self, argv, env, cwd):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ.update(env)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"], os.environ["LINES"] = str(COLS), str(ROWS)
            os.execvp(argv[0], argv)
        self.pid, self.fd = pid, fd
        import fcntl, termios, struct
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def pump(self, seconds=0.2):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                self.stream.feed(data)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def send(self, s, delay=0.05):
        for ch in s:
            os.write(self.fd, ch.encode())
            time.sleep(delay)
            self.pump(0.01)

    def key(self, name):
        codes = {"enter": "\r", "down": "\x1b[B", "up": "\x1b[A", "esc": "\x1b", "ctrl-c": "\x03", "tab": "\t"}
        os.write(self.fd, codes[name].encode())
        self.pump(0.3)

    def wait_for(self, pattern, timeout=30):
        end = time.time() + timeout
        rx = re.compile(pattern, re.S)
        while time.time() < end:
            self.pump(0.3)
            if rx.search(self.text()):
                return True
        return False

    def snap(self, path, title=""):
        with open(path, "a") as f:
            f.write(f"\n===== {title} @ {time.strftime('%H:%M:%S')} =====\n{self.text()}\n")

    def stop(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

# ---- Keycloak helpers (scripted user + admin API) ----
import json, html, http.cookiejar, urllib.request, urllib.parse

KC = os.environ.get("KC_E2E_URL", "http://localhost:18080")

def _forms(page):
    for m in re.finditer(r"<form\b([^>]*)>(.*?)</form>", page, re.S):
        action = re.search(r'action="([^"]+)"', m.group(1))
        if not action:
            continue
        fields = {}
        for inp in re.finditer(r"<input\b[^>]*>", m.group(2)):
            t = inp.group(0)
            name = re.search(r'name="([^"]+)"', t)
            if not name:
                continue
            typ = (re.search(r'type="([^"]+)"', t) or [None, "text"])[1]
            val = html.unescape((re.search(r'value="([^"]*)"', t) or [None, ""])[1])
            if typ == "submit":
                if re.search(r"accept|yes", name.group(1) + val, re.I):
                    fields[name.group(1)] = val
                continue
            fields[name.group(1)] = val
        yield html.unescape(action.group(1)), fields

def approve_device(user_code):
    import subprocess
    out = subprocess.run(["node", os.path.join(ROOT, "test/e2e/approve-device.ts"), user_code], capture_output=True, text=True)
    return out.stdout + out.stderr

def admin_revoke(username="alice"):
    tok = json.load(urllib.request.urlopen(f"{KC}/realms/master/protocol/openid-connect/token",
        urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": "admin"}).encode()))["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    users = json.load(urllib.request.urlopen(urllib.request.Request(f"{KC}/admin/realms/pi-test/users?username={username}", headers=h)))
    uid = users[0]["id"]
    urllib.request.urlopen(urllib.request.Request(f"{KC}/admin/realms/pi-test/users/{uid}/logout", method="POST", headers=h))
    urllib.request.urlopen(urllib.request.Request(f"{KC}/admin/realms/pi-test/users/{uid}/consents/pi-cli", method="DELETE", headers=h))
