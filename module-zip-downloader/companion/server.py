#!/usr/bin/env python3
"""
Cascade Downloader Companion Server
Receives save/download requests from the Chrome extension and writes files to disk.
Run with: python3 server.py
"""

import json
import os
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

BASE_PATH = "/Users/muhammadnaveedshahzad/projects/mgmt-500"
PORT = 7734


class Handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[{self.address_string()}] {format % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/ping":
            self.send_json({"status": "ok", "base": BASE_PATH})
        elif self.path == "/downloads-dir":
            self.send_json({"path": os.path.expanduser("~/Downloads")})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "invalid json"}, 400)
            return

        if self.path == "/exists":
            path = payload.get("path", "")
            full_path = path if os.path.isabs(path) else os.path.join(BASE_PATH, path)
            self.send_json({"exists": os.path.exists(full_path)})

        elif self.path == "/unzip":
            import shutil
            import zipfile
            from_path = payload.get("from", "")   # absolute path to zip in Downloads
            to_rel    = payload.get("to", "")      # relative dest folder e.g. mgmt-560/modules/module1
            to_full   = os.path.join(BASE_PATH, to_rel)
            os.makedirs(to_full, exist_ok=True)
            try:
                with zipfile.ZipFile(from_path, 'r') as zf:
                    zf.extractall(to_full)
                os.remove(from_path)
                print(f"  [UNZIPPED] {from_path} -> {to_full}")
                self.send_json({"unzipped": to_rel})
            except Exception as e:
                print(f"  [ERROR] unzip: {e}")
                self.send_json({"error": str(e)}, 500)

        elif self.path == "/move":
            import shutil
            from_path = payload.get("from", "")
            to_path = payload.get("to", "")
            to_full = to_path if os.path.isabs(to_path) else os.path.join(BASE_PATH, to_path)
            os.makedirs(os.path.dirname(to_full), exist_ok=True)
            try:
                shutil.move(from_path, to_full)
                print(f"  [MOVED] {from_path} -> {to_full}")
                self.send_json({"moved": to_full})
            except Exception as e:
                print(f"  [ERROR] move: {e}")
                self.send_json({"error": str(e)}, 500)

        elif self.path == "/save":
            ptype = payload.get("type")

            if ptype == "save_text":
                rel_path = payload.get("path", "")
                content = payload.get("content", "")
                full_path = os.path.join(BASE_PATH, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, "w", encoding="utf-8") as f:
                    f.write(content)
                print(f"  [SAVED] {full_path}")
                self.send_json({"saved": rel_path})

            elif ptype == "download_file":
                url = payload.get("url", "")
                rel_path = payload.get("path", "")
                full_path = os.path.join(BASE_PATH, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        with open(full_path, "wb") as f:
                            f.write(resp.read())
                    print(f"  [DOWNLOADED] {full_path}")
                    self.send_json({"saved": rel_path})
                except urllib.error.URLError as e:
                    print(f"  [ERROR] {url}: {e}")
                    self.send_json({"error": str(e)}, 500)

            else:
                self.send_json({"error": f"unknown type: {ptype}"}, 400)
        else:
            self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    print(f"Cascade Downloader Companion Server")
    print(f"Base path : {BASE_PATH}")
    print(f"Listening : http://localhost:{PORT}")
    print(f"Press Ctrl+C to stop\n")
    server = HTTPServer(("localhost", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
