import json
import socket
import subprocess
import time

EXE = r"core-dist\Novela.Core.exe"
srv = subprocess.Popen([EXE, "serve", "--port", "4490", "--token", "s3cret"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(40):
        try:
            s = socket.create_connection(("127.0.0.1", 4490), timeout=2)
            s.close()
            break
        except OSError:
            time.sleep(0.5)

    import urllib.request

    def post(payload, token=None):
        req = urllib.request.Request(
            "http://127.0.0.1:4490/api/obfuscate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                      **({"X-Novela-Token": token} if token else {})},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    # 1. no token -> 401
    st, body = post({"source": "print(1)", "options": {}, "seed": 1})
    print("no-token:", st, body.get("error"))
    assert st == 401

    # 2. wrong token -> 401
    st, _ = post({"source": "print(1)", "options": {}, "seed": 1}, token="bad")
    print("bad-token:", st)
    assert st == 401

    # 3. correct token + cyrillic source -> works
    src = 'local s = "Привет"\nprint(s)\nreturn s'
    st, body = post({"source": src, "options": {"vmLayers": 1}, "seed": 3}, token="s3cret")
    print("ok:", st, "mode=", body["stats"]["mode"], "outlen=", len(body["output"]))
    assert st == 200 and body["success"]

    # 4. run the protected output (cyrillic must survive)
    from lupa import LuaRuntime
    lua = LuaRuntime(unpack_returned_tuples=True)
    out = []
    lua.globals()["print"] = lambda *a: out.append(" ".join(str(x) for x in a))
    ret = lua.execute(body["output"])
    assert out == ["Привет"] and ret == "Привет", (out, ret)
    print("API cyrillic round-trip OK")

    # 5. bad json -> 400
    req = urllib.request.Request("http://127.0.0.1:4490/api/obfuscate", data=b"{nope",
                                 headers={"Content-Type": "application/json",
                                          "X-Novela-Token": "s3cret"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=30)
        print("bad-json: unexpected 200")
    except urllib.error.HTTPError as e:
        print("bad-json:", e.code)
        assert e.code == 400
    print("API ALL OK")
finally:
    srv.terminate()
