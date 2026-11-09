"""
Real pi check: drives the actual pi TUI in a pseudo-terminal against the e2e Keycloak
and the fake gateway, and records what the screen shows.

Prerequisites (see CONTRIBUTING.md):
  ./scripts/e2e-keycloak.sh up            # Keycloak on :18080, realm pi-test
  npm run build                           # dist/index.js
  python3 -m pip install pyte             # terminal emulator used to read the screen

Usage:
  python3 test/pi/real-pi-check.py [output-dir]

Steps: device-code /login, /model, a message, a message after the 60 s access token
expired (refresh), revocation of every session then a message (invalid_grant must be
visible), then /login with the two browser methods. The fake gateway logs each request's
Authorization header; the script checks it is the stored Keycloak access token.
"""
import base64, json, os, re, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drive import ROOT, Pi, admin_revoke, approve_device  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="real-pi-")
agent = os.path.join(out_dir, "agent")
work = os.path.join(out_dir, "work")
os.makedirs(agent, exist_ok=True)
os.makedirs(work, exist_ok=True)
SCREENS = os.path.join(out_dir, "screens.txt")
GATEWAY_LOG = os.path.join(out_dir, "gateway.log")
AUTH = os.path.join(agent, "auth.json")
URL = r"http://localhost:18080/realms/pi-test/protocol/openid-connect/auth\?\S+"

json.dump(
    {
        "issuer": "http://localhost:18080/realms/pi-test",
        "clientId": "pi-cli",
        "baseUrl": "http://127.0.0.1:18181/v1",
        "headers": {"X-Client": "pi"},
        "models": [{"id": "gw-model", "name": "Gateway Model"}],
    },
    open(os.path.join(agent, "keycloak-auth.json"), "w"),
)
# Headless mode: the device flow is offered first and pi never launches a browser.
ENV = {"PI_CODING_AGENT_DIR": agent, "PI_KC_LOG": "info", "SSH_CONNECTION": "10.0.0.1 1 10.0.0.2 22"}
results = []


def check(name, ok):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name, flush=True)


def stored():
    return json.load(open(AUTH))["keycloak"]


def claims(jwt):
    p = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def start_pi():
    pi = Pi([os.path.join(ROOT, "node_modules/.bin/pi"), "-e", os.path.join(ROOT, "dist/index.js")], ENV, work)
    pi.pump(6)
    return pi


def open_login(pi):
    pi.send("/login keycloak")
    pi.pump(0.5)
    pi.key("enter")
    pi.pump(0.5)
    if "Sign in to Keycloak" not in pi.text():
        pi.key("enter")
    return pi.wait_for("Sign in to Keycloak", 10)


gateway = subprocess.Popen(
    ["node", os.path.join(ROOT, "test/pi/fake-gateway.mjs")],
    env={**os.environ, "GATEWAY_LOG": GATEWAY_LOG},
    stdout=subprocess.DEVNULL,
)
try:
    # 1. Device-code login.
    pi = start_pi()
    check("/login lists the device code first in a headless session", open_login(pi) and "Device code" in pi.text())
    pi.snap(SCREENS, "method choice")
    pi.key("enter")
    pi.wait_for(r"Enter code: (\S+)", 20)
    pi.snap(SCREENS, "device code")
    code = re.search(r"Enter code: (\S+)", pi.text()).group(1)
    check("device code approved in Keycloak", "device approved" in approve_device(code))
    check("pi reports the login", pi.wait_for(r"Logged in to Keycloak", 30))
    pi.snap(SCREENS, "after device login")

    # 2. /model, then a message.
    pi.send("/model")
    pi.pump(0.5)
    pi.key("enter")
    check("/model lists the configured model", pi.wait_for(r"Gateway Model", 10))
    pi.snap(SCREENS, "/model")
    pi.send("Gateway")
    pi.pump(0.5)
    pi.key("enter")
    pi.pump(1.5)
    pi.send("ping one")
    pi.key("enter")
    check("a message gets the gateway's answer", pi.wait_for(r"pong", 20))
    pi.snap(SCREENS, "first reply")
    first = stored()

    # 3. After the 60 s access token expired.
    time.sleep(max(0, (first["expires"] / 1000 - time.time()) + 3))
    pi.send("ping two")
    pi.key("enter")
    check("a message after the access token expired works", pi.wait_for(r"pong.*pong", 25))
    pi.snap(SCREENS, "reply after expiry")
    second = stored()
    check("the refreshed pair was persisted (access and refresh rotated)",
          second["access"] != first["access"] and second["refresh"] != first["refresh"])

    # 4. Gateway saw the Keycloak access token as Bearer, plus the static header.
    entries = [json.loads(line) for line in open(GATEWAY_LOG)]
    bearer = [e["authorization"].split(" ", 1) for e in entries]
    check("gateway received 'Authorization: Bearer <access token>'",
          all(s == "Bearer" and claims(t)["typ"] == "Bearer" for s, t in bearer))
    check("the second request carried the refreshed access token", bearer[-1][1] == second["access"])
    check("gateway received the static X-Client header", all(e["xClient"] == "pi" for e in entries))

    # 5. Revocation: invalid_grant must be visible in the UI.
    admin_revoke()
    time.sleep(max(0, (second["expires"] / 1000 - time.time()) + 3))
    pi.send("ping three")
    pi.key("enter")
    check("invalid_grant tells the user to run /login keycloak", pi.wait_for(r"Run /login keycloak", 25))
    pi.pump(2)
    pi.snap(SCREENS, "after revocation")
    pi.stop()

    # 6. The two browser methods.
    for downs, label in ((1, "browser auto-capture"), (2, "browser paste")):
        if os.path.exists(AUTH):
            os.remove(AUTH)
        pi = start_pi()
        open_login(pi)
        for _ in range(downs):
            pi.key("down")
        pi.key("enter")
        pi.wait_for(URL, 15)
        pi.snap(SCREENS, f"{label}: URL")
        url = re.search(URL, pi.text()).group(0)
        args = ["node", os.path.join(ROOT, "test/e2e/browser-signin.ts"), url] + (["--follow"] if downs == 1 else [])
        browser = subprocess.run(args, capture_output=True, text=True).stdout.strip()
        if downs == 2:
            pi.send(browser, delay=0.002)
            pi.key("enter")
        check(f"{label} login", pi.wait_for(r"Logged in to Keycloak", 20) and os.path.exists(AUTH))
        pi.snap(SCREENS, f"{label}: done")
        pi.stop()
finally:
    gateway.terminate()

print(f"\nscreens: {SCREENS}\ngateway log: {GATEWAY_LOG}")
failed = [n for n, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
